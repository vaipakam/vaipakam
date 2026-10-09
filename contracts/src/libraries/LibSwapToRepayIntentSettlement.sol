// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";
import {LibCloseoutFreeze} from "./LibCloseoutFreeze.sol";
import {LibCollateralSettlement} from "./LibCollateralSettlement.sol";
import {LibSettlement} from "./LibSettlement.sol";
import {LibPrepayCleanup} from "./LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {EncumbranceMutateFacet} from "../facets/EncumbranceMutateFacet.sol";
import {ConsolidationFacet} from "../facets/ConsolidationFacet.sol";
import {VPFIDiscountFacet} from "../facets/VPFIDiscountFacet.sol";
import {LibERC721} from "./LibERC721.sol";

/**
 * @title LibSwapToRepayIntentSettlement — T-087 Sub 3.B extraction
 *
 * Internal logic for the SWAP_TO_REPAY arm of the IntentDispatchFacet.
 * The bodies of the three 1inch LOP v4 hooks (`preInteraction`,
 * `postInteraction`, `isValidSignature`) that previously lived in
 * `SwapToRepayIntentFacet` move here so the same selectors can be
 * dispatched from `IntentDispatchFacet` for both order kinds
 * (SWAP_TO_REPAY and BUYBACK).
 *
 * The extraction itself was mechanical. Events + custom errors that the
 * bodies emit / revert are re-declared here so library-scope emission
 * keeps the diamond as the on-chain emitter.
 *
 * #1566 slice 3 -- PULL AT USE. The commit no longer moves the lot: it
 * stays in `loan.borrower`'s vault, liened with the rest of the
 * collateral, until its own fill. {preInteractionImpl} takes it out
 * there, under the fill lock the dispatcher acquired first, and
 * {postInteractionImpl} settles exactly the committed lot against
 * exactly the taking amount. So no user collateral rests in the
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

    /// @notice #1566 slice 3 -- the fill's pre-hook took the committed lot out of
    ///         `borrower`'s vault into the Diamond, inside the fill, under the fill
    ///         lock. The provenance of the one move the commit no longer makes: the
    ///         LOP's maker-to-taker transfer carries it on to the taker in the same
    ///         call, so it never rests in the Diamond.
    /// @custom:event-category state-change/loan-mutation
    event SwapToRepayIntentLotPulled(
        uint256 indexed loanId,
        bytes32 indexed orderHash,
        address indexed borrower,
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
    /// @notice The pull out of the vault did not raise the Diamond's balance by
    ///         exactly the lot (fee-on-transfer or rebasing collateral). The fill
    ///         reverts; the commit stays cancellable. Same selector as the facet's.
    error IntentCollateralFeeOnTransferUnsupported(uint256 received, uint256 requested);

    // ─── preInteraction body ─────────────────────────────────────────

    /// @dev §5.1 preInteraction -- #1566 slice 3, PULL AT USE. Runs inside the
    ///      fill, after the dispatcher acquired the fill lock and before the
    ///      LOP's maker-to-taker transfer:
    ///        1. the commit lookup, and the caller pinned to the commit's LOP
    ///           (Codex round-11 P2 #6);
    ///        2. a commit stamped with the old custody is refused by name (O1);
    ///        3. the LOP's making amount must be the committed lot;
    ///        4. ONE step (design: "lien decrement, pull, and VPFI restamp are
    ///           ONE atomic step ... under the pinned sanctions-safe MOVE-OUT
    ///           exemption"): the lien drops by the lot; the lot moves out of
    ///           `loan.borrower`'s vault into the Diamond through the move-out
    ///           path, so a borrower flagged after the commit cannot block the
    ///           fill that repays their lender; the Diamond's balance must rise
    ///           by exactly the lot (fee-on-transfer and rebasing collateral are
    ///           refused here, and the commit stays cancellable); and a VPFI
    ///           holder's tier is restamped at the reduced balance,
    ///           broadcast-free (D16) so a third party's fill never spends the
    ///           CCIP budget -- the mirror-chain tier catches up at the
    ///           borrower's next broadcasting action;
    ///        5. the principal baseline for the post-hook's delta, in transient
    ///           storage keyed by the order hash. A loan's collateral and
    ///           principal differ (self-collateralized offers are refused at
    ///           creation), so the pull cannot move this baseline.
    ///      Any failure reverts the whole fill, so a lot is never half-pulled.
    function preInteractionImpl(bytes32 orderHash, uint256 makingAmount) internal {
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
        uint256 balanceBefore = IERC20(collateral).balanceOf(address(this));
        LibEncumbrance.decrementCollateralLien(loanId, lot);
        LibSanctionedLock.vaultWithdrawERC20MoveOut(s, loan.borrower, collateral, address(this), lot);
        uint256 received = IERC20(collateral).balanceOf(address(this)) - balanceBefore;
        if (received != lot) revert IntentCollateralFeeOnTransferUnsupported(received, lot);
        if (collateral == s.vpfiToken) {
            // Through the Diamond-internal host, not inlined: the tier rollup is
            // large and this facet hosts every LOP callback.
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    ConsolidationFacet.restampUserVpfiLocalInternal.selector, loan.borrower
                ),
                bytes4(0)
            );
        }
        emit SwapToRepayIntentLotPulled(loanId, orderHash, loan.borrower, collateral, lot);

        uint256 baseline = IERC20(loan.principalAsset).balanceOf(address(this));
        assembly ("memory-safe") {
            tstore(orderHash, baseline)
        }
    }

    // ─── postInteraction body ────────────────────────────────────────

    /// @dev §5.1 postInteraction — atomic settlement waterfall + claim
    ///      record + commit teardown + aggregate-allowance decrement. The
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

        // ── Step 4: live floor re-check (Codex round-2 P1 #8 +
        //    round-10 P1 #5 + round-11 P1 #3 — add `lateFee`) ───────
        uint256 endTime = uint256(loan.startTime)
            + uint256(loan.durationDays) * LibVaipakam.ONE_DAY;
        uint256 lateFee = LibVaipakam.calculateLateFee(loanId, endTime);
        uint256 liveLenderLeg = LibCollateralSettlement.principalPlusAccruedInterest(
            loanId, block.timestamp
        );
        uint256 liveTreasuryLeg = LibCollateralSettlement.treasuryAndPrecloseFee(
            loanId, block.timestamp
        );
        uint256 liveFloor = liveLenderLeg + liveTreasuryLeg + lateFee;
        if (actualDelivered < liveFloor) {
            revert IntentDeliveredBelowLiveFloor(actualDelivered, liveFloor);
        }

        // ── Step 5 (#1566 slice 3): the whole lot is consumed ───────
        // The pre-hook pulled exactly the committed lot and the LOP moved
        // exactly that to the taker (no partial fills: enforced at commit
        // and by the making-amount check above), so nothing returns to the
        // vault. The branch that returned `custodialCollateral - consumed`
        // is gone: it was always zero for a no-partial order. The rest of
        // the collateral never left the vault.
        uint256 consumed = commit.makerAmount;

        // ── Step 6: settlement waterfall ──────────────────────────
        _runSettlement(s, loan, loanId, actualDelivered, consumed, lateFee);

        // ── Step 7: aggregate allowance + live count decrement ──────
        s.intentAggregateAllowance[loan.collateralAsset] -= commit.makerAmount;
        s.intentLiveCommitCount -= 1;
        IERC20(loan.collateralAsset).forceApprove(commit.lopAtCommit, 0);
        if (s.intentAggregateAllowance[loan.collateralAsset] != 0) {
            IERC20(loan.collateralAsset).forceApprove(
                commit.lopAtCommit,
                s.intentAggregateAllowance[loan.collateralAsset]
            );
        }

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

        if (plan.treasuryShare > 0) {
            address treasury = LibFacet.getTreasury();
            IERC20(loan.principalAsset).safeTransfer(treasury, plan.treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
        }

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
        // the debt-sized lot is sold, and #1566 slice 3 pulls it only in this
        // fill's pre-hook, so the rest stayed in the vault, still liened).
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

    // ─── isValidSignature body ───────────────────────────────────────

    /// @dev §5.7 #5 — yes/no on whether this orderHash is a
    ///      registered live commit. Returns the ERC-1271 magic
    ///      value IFF `orderHashToLoanId[hash] != 0 AND
    ///      intentCommits[loanId].orderHash == hash`. Pure
    ///      read-only — no `tstore`, no state mutation.
    function isValidSignatureImpl(bytes32 orderHash)
        internal
        view
        returns (bytes4)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 loanId = s.orderHashToLoanId[orderHash];
        if (loanId == 0) return bytes4(0xffffffff);
        if (s.intentCommits[loanId].orderHash != orderHash) {
            return bytes4(0xffffffff);
        }
        return IERC1271.isValidSignature.selector;
    }
}
