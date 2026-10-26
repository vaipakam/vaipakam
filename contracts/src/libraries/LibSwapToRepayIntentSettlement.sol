// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibCloseoutFreeze} from "./LibCloseoutFreeze.sol";
import {LibSettlement} from "./LibSettlement.sol";
import {LibPrepayCleanup} from "./LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "../facets/EncumbranceMutateFacet.sol";
import {ConsolidationFacet} from "../facets/ConsolidationFacet.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {VaipakamVaultImplementation} from "../VaipakamVaultImplementation.sol";
import {VPFIDiscountFacet} from "../facets/VPFIDiscountFacet.sol";
import {LibERC721} from "./LibERC721.sol";

/**
 * @title LibSwapToRepayIntentSettlement — T-087 Sub 3.B extraction
 *
 * Internal logic for the SWAP_TO_REPAY arm of the IntentDispatchFacet.
 * The bodies of the three 1inch LOP v4 hooks (`preInteraction`,
 * `postInteraction`, and `isValidSignature`, whose swap arm is since #1566
 * S3e {isOrderValidImpl}, the borrower vault's validator) that previously lived in
 * `SwapToRepayIntentFacet` move here so the same selectors can be
 * dispatched from `IntentDispatchFacet` for both order kinds
 * (SWAP_TO_REPAY and BUYBACK).
 *
 * The extraction itself was mechanical. Events + custom errors that the
 * bodies emit / revert are re-declared here so library-scope emission
 * keeps the diamond as the on-chain emitter.
 *
 * #1566 slice 3 -- PULL AT USE, and (S3e) the vault is the maker. The
 * commit moves nothing: the lot stays in `loan.borrower`'s vault, liened
 * with the rest of the collateral, until its own fill, and the 1inch
 * order names that vault as its maker, so the orderbook sees the lot
 * where it rests. Inside the fill the LOP takes it from the vault
 * straight to the taker; {preInteractionImpl} (under the fill lock the
 * dispatcher acquired first) does the bookkeeping that transfer needs,
 * and {postInteractionImpl} requires the vault to have dropped by
 * exactly the lot and the Diamond to have received exactly the taking
 * amount. So no user collateral rests in the
 * Diamond between transactions (#2141). A commit stamped with the old
 * custody (`custodialCollateral != 0`: its lot already in the Diamond)
 * is refused by name, never paid from the Diamond's balance (owner
 * decision O1, 2026-10-07: fresh deploy only).
 */
library LibSwapToRepayIntentSettlement {
    using SafeERC20 for IERC20;

    // ─── Events (mirror SwapToRepayIntentFacet declarations) ────────

    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentFilled(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        uint256 consumed,
        uint256 delivered,
        uint256 residualToBorrowerVault
    );

    /// @notice #1566 slice 3 -- the fill released the committed lot from
    ///         `borrower`'s vault to `taker`: the pre-hook recorded the outflow
    ///         (lien, tracked balance, tier) and the LOP, the order's maker
    ///         being the vault (S3e), takes the lot from `vault` straight to the
    ///         taker in the same call. It never enters the Diamond.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentLotPulled(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        address indexed borrower,
        address vault,
        address taker,
        address asset,
        uint256 lot
    );

    // ─── Errors ──────────────────────────────────────────────────────

    error IntentNotRegistered(bytes32 orderHash);
    error IntentPostInteractionUnauthorized(address caller);
    error IntentPreInteractionUnauthorized(address caller);
    error IntentPreInteractionUnknownOrder(bytes32 orderHash);
    error IntentDeliveredBelowLiveFloor(uint256 actualDelivered, uint256 liveFloor);
    /// @notice #1566 slice 3 (O1) -- the commit was recorded under the old custody,
    ///         its lot already in the Diamond; refused rather than paid from the
    ///         Diamond's balance. Same selector as the facet's declaration.
    error IntentCustodyNotVaultHeld(uint256 loanId);
    /// @notice The LOP's making amount is not the committed lot. A genuine fill
    ///         always matches (no partial fills; the hash binds the amount); the
    ///         check pins it instead of trusting it.
    error IntentFillAmountMismatch(uint256 makingAmount, uint256 lot);
    /// @notice The principal the fill delivered is not the order's taking amount:
    ///         only the taker's own transfer may fund the settlement (S1-10).
    error IntentDeliveredMismatch(uint256 actualDelivered, uint256 takingAmount);
    /// @notice The fill did not take exactly the lot out of the borrower's vault
    ///         (fee-on-transfer or rebasing collateral, #1566 S3e: measured on the
    ///         vault, the order's maker). The fill reverts; the commit stays
    ///         cancellable. Same selector as the facet's.
    error IntentCollateralFeeOnTransferUnsupported(uint256 received, uint256 requested);

    // ─── preInteraction body ─────────────────────────────────────────

    /// @dev §5.1 preInteraction -- #1566 slice 3, AT USE. Runs inside the
    ///      fill, after the dispatcher acquired the fill lock and before the
    ///      LOP's maker-to-taker transfer:
    ///        1. the commit lookup, and the caller pinned to the commit's LOP
    ///           (Codex round-11 P2 #6);
    ///        2. a commit stamped with the old custody is refused by name (O1);
    ///        3. the LOP's making amount must be the committed lot;
    ///        4. ONE step (design: "lien decrement, pull, and VPFI restamp are
    ///           ONE atomic step"), as BOOKKEEPING since S3e: the order's maker is
    ///           `loan.borrower`'s vault, so the LOP itself takes the lot from the
    ///           vault straight to the taker right after this hook. The lien drops
    ///           by the lot; the vault's tracked balance records the outflow
    ///           through `VaultFactoryFacet.recordVaultOutflowERC20` (the
    ///           withdrawal's lien guard and RL-2 debit event, no screen, so a
    ///           borrower flagged after the commit cannot block the fill that
    ///           repays their lender); a VPFI holder's tier is restamped at the
    ///           reduced balance, broadcast-free (D16) so a third party's fill
    ///           never spends the CCIP budget -- the mirror-chain tier catches up
    ///           at the borrower's next broadcasting action; and the vault's
    ///           balance is snapshotted for the post-hook's exact-drop check;
    ///        5. the principal baseline for the post-hook's delta, in transient
    ///           storage keyed by the order hash. A loan's collateral and
    ///           principal differ (self-collateralized offers are refused at
    ///           creation), so the lot cannot move this baseline.
    ///      Any failure reverts the whole fill, so nothing is half-recorded.
    function preInteractionImpl(bytes32 orderHash, uint256 makingAmount, address taker) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        uint256 loanId = s.orderHashToLoanId[orderHash];
        if (loanId == 0 || s.intentCommits[loanId].orderHash != orderHash) {
            revert IntentPreInteractionUnknownOrder(orderHash);
        }
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (msg.sender != commit.lopAtCommit) {
            revert IntentPreInteractionUnauthorized(msg.sender);
        }
        if (commit.custodialCollateral != 0) revert IntentCustodyNotVaultHeld(loanId);
        uint256 lot = commit.makerAmount;
        if (makingAmount != lot) revert IntentFillAmountMismatch(makingAmount, lot);

        LibVaipakam.Loan storage loan = s.loans[loanId];
        address collateral = loan.collateralAsset;
        address vault = s.userVaipakamVaults[loan.borrower];
        LibEncumbrance.decrementCollateralLien(loanId, lot);
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaultFactoryFacet.recordVaultOutflowERC20.selector, loan.borrower, collateral, lot, taker
            ),
            bytes4(0)
        );
        {
            uint256 vaultBefore = IERC20(collateral).balanceOf(vault);
            bytes32 vaultKey = _vaultSnapshotKey(orderHash);
            assembly ("memory-safe") {
                tstore(vaultKey, vaultBefore)
            }
        }
        emit SwapToRepayIntentLotPulled(loanId, orderHash, loan.borrower, vault, taker, collateral, lot);

        uint256 baseline = IERC20(loan.principalAsset).balanceOf(address(this));
        assembly ("memory-safe") {
            tstore(orderHash, baseline)
        }
    }

    // ─── postInteraction body ────────────────────────────────────────

    /// @dev §5.1 postInteraction — atomic settlement waterfall + claim
    ///      record + commit teardown + the vault's signature revoked. The
    ///      caller (IntentDispatchFacet) released the fill lock and holds the
    ///      reentrancy guard. #1566 slice 3: the making amount must be the
    ///      committed lot and the principal delivered must be exactly the
    ///      taking amount; the whole lot is consumed, so nothing returns to the
    ///      vault here.
    function postInteractionImpl(bytes32 orderHash, uint256 makingAmount, uint256 takingAmount) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // ── Step 1: reverse-index lookup (Codex round-11 P1 #7 —
        //    derive loanId BEFORE the auth check) ──────────────────────
        uint256 loanId = s.orderHashToLoanId[orderHash];
        if (loanId == 0) revert IntentNotRegistered(orderHash);

        // ── Step 2: authorized-caller against pinned LOP (Codex
        //    round-10 P1 #6) ─────────────────────────────────────────
        LibVaipakam.SwapToRepayIntentCommit storage commit = s.intentCommits[loanId];
        if (msg.sender != commit.lopAtCommit) {
            revert IntentPostInteractionUnauthorized(msg.sender);
        }
        if (makingAmount != commit.makerAmount) {
            revert IntentFillAmountMismatch(makingAmount, commit.makerAmount);
        }

        LibVaipakam.Loan storage loan = s.loans[loanId];

        // ── Step 3: actual principal received via transient-storage
        //    baseline (Codex round-5 P1 #2 + round-7 P1 #6) ─────────
        uint256 baseline;
        assembly ("memory-safe") {
            baseline := tload(orderHash)
            tstore(orderHash, 0)
        }
        uint256 actualDelivered = IERC20(loan.principalAsset).balanceOf(address(this))
            - baseline;
        // #1566 slice 3 (S1-10) — the settlement is funded by the taker's
        // transfer and nothing else: principal that reached the Diamond any
        // other way mid-fill is refused, not paid out as borrower surplus.
        if (actualDelivered != takingAmount) {
            revert IntentDeliveredMismatch(actualDelivered, takingAmount);
        }
        // #1566 S3e — the LOP took the lot from the borrower's vault (the
        // order's maker) straight to the taker: the vault must have dropped by
        // exactly the lot since the pre-hook's snapshot (a token that moves
        // more or less than asked fails the fill, and the commit stays
        // cancellable).
        {
            bytes32 vaultKey = _vaultSnapshotKey(orderHash);
            uint256 vaultBefore;
            assembly ("memory-safe") {
                vaultBefore := tload(vaultKey)
                tstore(vaultKey, 0)
            }
            uint256 vaultNow = IERC20(loan.collateralAsset).balanceOf(s.userVaipakamVaults[loan.borrower]);
            uint256 dropped = vaultBefore > vaultNow ? vaultBefore - vaultNow : 0;
            if (dropped != commit.makerAmount) {
                revert IntentCollateralFeeOnTransferUnsupported(dropped, commit.makerAmount);
            }
        }

        // ── Step 4: the live floor (Codex round-2 P1 #8) is checked by
        //    the waterfall itself: `_runSettlement` refuses a delivery
        //    below `lenderDue + treasuryShare` of the same repayment plan
        //    that pays out, which is `LibCollateralSettlement.liveFloor`
        //    (#2740 — one split, so the floor and the payout cannot
        //    disagree). The late fee is in that plan.
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId);

        // ── Step 5 (#1566 slice 3): the whole lot is consumed ───────
        // The LOP took exactly the committed lot from the vault to the
        // taker (checked on the vault above) (no partial fills: enforced at commit
        // and by the making-amount check above), so nothing returns to the
        // vault. The branch that returned `custodialCollateral - consumed`
        // is gone: it was always zero for a no-partial order. The rest of
        // the collateral never left the vault.
        uint256 consumed = commit.makerAmount;

        // ── Step 6: settlement waterfall ──────────────────────────
        _runSettlement(s, loan, loanId, actualDelivered, consumed, lateFee);

        // ── Step 7 (#1566 S3e): the live count; the vault stops signing ──
        // The vault's allowance to the LOP was consumed by the LOP's own
        // transfer of the lot, and the vault's ERC-1271 stops answering
        // for this hash.
        s.intentLiveCommitCount -= 1;
        VaipakamVaultImplementation(s.userVaipakamVaults[loan.borrower]).revokeListingOrderHash(orderHash);

        // ── Step 8: storage cleanup ─────────────────────────────────
        bytes32 extensionHash = commit.extensionHash;
        delete s.orderHashToLoanId[orderHash];
        s.intentExtensionBytesRefCount[extensionHash] -= 1;
        if (s.intentExtensionBytesRefCount[extensionHash] == 0) {
            delete s.intentExtensionBytes[extensionHash];
        }
        delete s.intentCommits[loanId];
        // #2322 — release the borrower-position lock the commit took. The
        // holder was fixed for the whole auction, so the claim recorded above
        // and the remainder in the vault belong to the same holder. Reason-
        // checked, so a pre-lock commit cannot clear another flow's lock.
        LibERC721._unlockIfHeldBy(loan.borrowerTokenId, LibERC721.LockReason.SwapToRepayIntent);
        // T-087 Sub 3.B — clear the kind discriminator stamped at
        // commit time so a stale orderHash can't be replayed against
        // a different kind.
        delete s.orderHashKind[orderHash];

        // `residualToBorrowerVault` is always 0 since #1566 slice 3 (kept in
        // the event for indexer compatibility).
        emit SwapToRepayIntentFilled(loanId, orderHash, consumed, actualDelivered, 0);
    }

    /// @dev Settlement waterfall — mirrors v1
    ///      `SwapToRepayFacet.swapToRepayFull` post-swap step-for-step.
    ///      `consumed` is passed verbatim to the claim-record branch
    ///      so `claim = loan.collateralAmount - consumed`.
    function _runSettlement(
        LibVaipakam.Storage storage s,
        LibVaipakam.Loan storage loan,
        uint256 loanId,
        uint256 actualDelivered,
        uint256 consumed,
        uint256 lateFee
    ) private {
        LibSettlement.ERC20Settlement memory plan = LibSettlement.computeRepayment(
            loan, lateFee, block.timestamp
        );
        uint256 requiredPrincipal = plan.lenderDue + plan.treasuryShare;
        if (actualDelivered < requiredPrincipal) {
            revert IntentDeliveredBelowLiveFloor(actualDelivered, requiredPrincipal);
        }

        // #1383 — honor the lender Full/hold discount (§F2 / #1354) via the
        // `VPFIDiscountFacet` host, keyed on the CURRENT lender-NFT holder: the
        // lender-side consolidation runs BELOW this split, so `loan.lender` is
        // not yet re-anchored here. The shift is treasury→lender, so
        // `requiredPrincipal` (checked above) and `surplusPrincipal` (below) are
        // invariant under it. The host emits the analytics passthrough on the
        // VPFI-payment path. Dark until `feeEntitlementEnabled`.
        if (plan.treasuryShare > 0) {
            address settlingLender =
                IERC721(address(this)).ownerOf(loan.lenderTokenId);
            // #1383 — INLINED eligibility short-circuit (no cross-facet routing)
            // so an ineligible/dark loan never calls the host.
            if (LibVPFIDiscount.lenderYieldFeeEligible(loan, settlingLender)) {
                bytes memory ret = LibFacet.crossFacetCallReturn(
                    abi.encodeWithSelector(
                        VPFIDiscountFacet.resolveLenderYieldFeeFor.selector,
                        loanId,
                        settlingLender,
                        plan.interest + plan.lateFee,
                        plan.treasuryShare
                    ),
                    bytes4(0)
                );
                (uint256 lenderExtra, uint256 newTreasury, ) =
                    abi.decode(ret, (uint256, uint256, uint256));
                if (lenderExtra > 0) {
                    plan.lenderShare += lenderExtra;
                    plan.lenderDue = plan.principal + plan.lenderShare;
                    plan.treasuryShare = newTreasury;
                }
            }
        }

        // #2440 — measured, accrued as it arrived (TreasuryFeeFacet).
        LibFacet.transferToTreasury(loan.principalAsset, plan.treasuryShare);

        // #658 PR-B — the intent fill is the LENDER-side close-out of this loan
        // (the borrower side was consolidated at COMMIT; its auction lot left
        // the vault only in this fill's pre-hook (#1566 slice 3), the rest of
        // its collateral stays in the vault, liened, and the borrower position
        // has been LOCKED since the commit, so
        // the holder the commit consolidated to is still the holder here; it must
        // NOT be re-consolidated). Consolidate
        // the lender side while the loan is still Active (the flip to Repaid is
        // below), so the lender reward entry + VPFI checkpoint follow the current
        // lender-NFT holder and the proceeds/#592 reserve below key to them
        // directly. Cross-facet (Tier2 skip-not-block); no-op if not transferred.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateToHolder.selector,
                loanId,
                true
            ),
            bytes4(0)
        );

        // #954 (§1.4) — this Fusion intent fill is a MUST-COMPLETE terminal
        // swap-to-repay-full, so apply the SAME freeze pattern as the v1
        // `swapToRepayFull` (freeze, don't screen). The shared helper deposits
        // the lender proceeds behind the receive-side exemption (a lender
        // flagged after commit doesn't brick), writes the lender claim row,
        // reserves the proceeds for EVERY ERC20 (§1.1), and tier-excludes a
        // transferred-and-sanctioned holder's VPFI (§2.2). Keeping both
        // terminals on `LibCloseoutFreeze` stops them drifting.
        LibCloseoutFreeze.freezeLenderProceeds(s, loanId, loan, plan.lenderDue);

        // #954 (§1.4) — a clean holder is paid directly; a SANCTIONED holder's
        // principal surplus is frozen into loan.borrower's vault + recorded as a
        // `borrowerSurplusClaims` row (previously an UNSCREENED direct transfer).
        uint256 surplusPrincipal = actualDelivered - requiredPrincipal;
        address currentBorrowerHolder =
            IERC721(address(this)).ownerOf(loan.borrowerTokenId);
        LibCloseoutFreeze.freezeOrPayBorrowerSurplus(
            s, loanId, loan, currentBorrowerHolder, surplusPrincipal
        );

        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: loan.collateralAmount - consumed,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #998 S10 (#1006 / #1132) — the residual collateral claim is borrower-side
        // claim-gated. Both holders' fail-closed frozen-claimant markers are
        // recorded centrally at the `Repaid` transition below (via
        // `EncumbranceMutateFacet.terminalize`), covering the residual collateral whether or
        // not a sanctioned principal surplus was present. The
        // `freezeOrPayBorrowerSurplus` self-register (above) and this central
        // register are idempotent + first-write-wins.

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            bytes4(keccak256("NFTStatusUpdateFailed()"))
        );
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanRepaid
            ),
            bytes4(keccak256("NFTStatusUpdateFailed()"))
        );

        LibPrepayCleanup.clearActiveListing(loan, loanId);

        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→Repaid
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone borrower register above was folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.Repaid
            ),
            bytes4(0)
        );

        // #569 Gap B (round-6 P1) — RE-LIEN rather than tombstone. The
        // borrower's collateral claim recorded above is
        // `loan.collateralAmount - consumed`, and those tokens all sit in
        // loan.borrower's vault: the part the fill never took (#2322 — only
        // the debt-sized lot is sold, and since #1566 slice 3 it leaves the
        // vault only in this fill, so the rest stayed there, still liened).
        // That claim must stay encumbered through the Repaid→claim window
        // (released atomically by `claimAsBorrower`, with the burn backstop
        // as the structural guarantee); a bare release would let a
        // transferred-away stored borrower drain it (VPFI via
        // withdrawVPFIFromVault) before the rightful holder claims.
        //
        // So the lien is TOPPED UP to cover the claim — by the difference
        // between the claim and what is still liened, not by the whole claim
        // on top of it (which double-counted the untouched part once the
        // commit stopped zeroing the lien). With the lien equal to the loan's
        // collateral before the commit, as loan initiation writes it, the
        // result equals the claim exactly; a lien that was already larger is
        // left as it was (the claim releases the whole row either way). A
        // zero claim — the whole collateral consumed — tombstones the row.
        uint256 claimedCollateral = loan.collateralAmount - consumed;
        if (claimedCollateral > 0) {
            uint256 stillLiened = s.loanCollateralLien[loanId].released
                ? 0
                : s.loanCollateralLien[loanId].amount;
            if (claimedCollateral > stillLiened) {
                LibEncumbrance.incrementCollateralLien(loanId, claimedCollateral - stillLiened);
            }
        } else {
            LibEncumbrance.releaseCollateralLien(loanId);
        }

        LibVPFIDiscount.settleBorrowerLifProper(loan);

        LibInteractionRewards.closeLoan(
            loanId,
            true,  /* borrowerClean */
            false  /* lenderForfeit */
        );
    }

    // ─── the vault's ERC-1271 validator ──────────────────────────────

    /// @dev §5.7 #5, #1566 S3e — whether `askingVault` should sign for
    ///      `orderHash`: the hash is a live swap-to-repay commit AND the asking
    ///      vault is that loan's borrower vault (the order's maker). Pure
    ///      read-only — no `tstore`, no state mutation.
    function isOrderValidImpl(bytes32 orderHash, address askingVault) internal view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.orderHashKind[orderHash] != LibVaipakam.ORDER_KIND_SWAP_TO_REPAY) return false;
        uint256 loanId = s.orderHashToLoanId[orderHash];
        if (loanId == 0 || s.intentCommits[loanId].orderHash != orderHash) return false;
        return askingVault != address(0) && askingVault == s.userVaipakamVaults[s.loans[loanId].borrower];
    }

    /// @dev The transient slot holding the borrower vault's collateral balance
    ///      at the pre-hook, for the post-hook's exact-drop check. Derived from
    ///      the order hash (whose own transient slot holds the principal
    ///      baseline) with a fixed tag, so the two can never collide.
    function _vaultSnapshotKey(bytes32 orderHash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(orderHash, "vaipakam.intent.vaultBefore"));
    }
}
