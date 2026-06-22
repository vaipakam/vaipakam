// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibEncumbrance} from "./LibEncumbrance.sol";
import {LibCollateralSettlement} from "./LibCollateralSettlement.sol";
import {LibSettlement} from "./LibSettlement.sol";
import {LibLifecycle} from "./LibLifecycle.sol";
import {LibPrepayCleanup} from "./LibPrepayCleanup.sol";
import {LibVPFIDiscount} from "./LibVPFIDiscount.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {VaipakamNFTFacet} from "../facets/VaipakamNFTFacet.sol";
import {ConsolidationFacet} from "../facets/ConsolidationFacet.sol";

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
 * The behaviour is byte-for-byte identical to the original T-090 v1.1
 * GA path — the extraction is mechanical, with no logic changes. Events
 * + custom errors that the bodies emit / revert are re-declared here so
 * library-scope emission keeps the diamond as the on-chain emitter.
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

    // ─── Errors ──────────────────────────────────────────────────────

    error IntentNotRegistered(bytes32 orderHash);
    error IntentPostInteractionUnauthorized(address caller);
    error IntentPreInteractionUnauthorized(address caller);
    error IntentPreInteractionUnknownOrder(bytes32 orderHash);
    error IntentDeliveredBelowLiveFloor(uint256 actualDelivered, uint256 liveFloor);

    // ─── preInteraction body ─────────────────────────────────────────

    /// @dev §5.1 preInteraction — snapshot the diamond's principal
    ///      balance into transient storage keyed by orderHash.
    ///      `postInteractionImpl` reads this back to compute
    ///      `actualDelivered` via balance-delta. Auth-pinned to
    ///      `commit.lopAtCommit` (Codex round-11 P2 #6 — runs on
    ///      Fusion's normal CALL).
    function preInteractionImpl(bytes32 orderHash) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

        // ── Reverse-index lookup ────────────────────────────────────
        uint256 loanId = s.orderHashToLoanId[orderHash];
        if (loanId == 0 || s.intentCommits[loanId].orderHash != orderHash) {
            revert IntentPreInteractionUnknownOrder(orderHash);
        }

        // ── Authorized-caller check against pinned LOP (Codex
        //    round-11 P2 #6) ───────────────────────────────────────────
        if (msg.sender != s.intentCommits[loanId].lopAtCommit) {
            revert IntentPreInteractionUnauthorized(msg.sender);
        }

        // ── Snapshot the diamond's principal balance pre-fill into
        //    transient storage keyed by orderHash. EIP-1153 transient
        //    storage is the right primitive: per-tx-scoped, free at
        //    tx-end, safe against same-tx reentry.
        address principal = s.loans[loanId].principalAsset;
        uint256 baseline = IERC20(principal).balanceOf(address(this));
        assembly ("memory-safe") {
            tstore(orderHash, baseline)
        }
    }

    // ─── postInteraction body ────────────────────────────────────────

    /// @dev §5.1 postInteraction — atomic settlement waterfall +
    ///      residual safeTransfer to vault + claim record + commit
    ///      teardown + aggregate-allowance decrement. `nonReentrant`
    ///      lives on the caller (IntentDispatchFacet).
    function postInteractionImpl(bytes32 orderHash, uint256 makingAmount) internal {
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

        // ── Step 5: residual handling — `safeTransfer` to vault THEN
        //    `recordVaultDeposit` (Codex round-10 P1 #2 + round-11
        //    P1 #1 — direct recordVaultDeposit doesn't move tokens) ─
        uint256 consumed = makingAmount;
        uint256 residual = commit.custodialCollateral - consumed;
        if (residual > 0) {
            address borrowerVault = LibFacet.getOrCreateVault(loan.borrower);
            IERC20(loan.collateralAsset).safeTransfer(borrowerVault, residual);
            LibVaipakam.recordVaultDeposit(
                loan.borrower, loan.collateralAsset, residual
            );
        }

        // ── Step 6: settlement waterfall ──────────────────────────
        _runSettlement(s, loan, loanId, actualDelivered, consumed, lateFee);

        // ── Step 7: aggregate allowance + live count decrement ──────
        s.intentAggregateAllowance[loan.collateralAsset] -= commit.custodialCollateral;
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
        // T-087 Sub 3.B — clear the kind discriminator stamped at
        // commit time so a stale orderHash can't be replayed against
        // a different kind.
        delete s.orderHashKind[orderHash];

        emit SwapToRepayIntentFilled(loanId, orderHash, consumed, actualDelivered, residual);
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

        if (plan.treasuryShare > 0) {
            address treasury = LibFacet.getTreasury();
            IERC20(loan.principalAsset).safeTransfer(treasury, plan.treasuryShare);
            LibFacet.recordTreasuryAccrual(loan.principalAsset, plan.treasuryShare);
        }

        // #658 PR-B — the intent fill is the LENDER-side close-out of this loan
        // (the borrower side was consolidated at COMMIT and its collateral is in
        // Diamond custody, so it must NOT be re-consolidated here). Consolidate
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

        address lenderVault = LibFacet.getOrCreateVault(loan.lender);
        IERC20(loan.principalAsset).safeTransfer(lenderVault, plan.lenderDue);
        LibVaipakam.recordVaultDeposit(loan.lender, loan.principalAsset, plan.lenderDue);

        uint256 surplusPrincipal = actualDelivered - requiredPrincipal;
        if (surplusPrincipal > 0) {
            address currentBorrowerHolder =
                IERC721(address(this)).ownerOf(loan.borrowerTokenId);
            IERC20(loan.principalAsset).safeTransfer(
                currentBorrowerHolder, surplusPrincipal
            );
        }

        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.principalAsset,
            amount: plan.lenderDue,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        // #592 — intent-based swap-to-repay mirrors the v1 terminal waterfall:
        // `plan.lenderDue` lands in the (possibly transferred-away) stored
        // lender's vault and is owed to the current holder via the claim above.
        // Reserve VPFI proceeds against the unstake path until the holder
        // claims (released path-agnostically in ClaimFacet). Terminal close →
        // `loan.lender` fixed. No-op for non-VPFI principal.
        if (loan.principalAsset == s.vpfiToken) {
            LibEncumbrance.encumberLenderProceeds(
                loanId, loan.lender, loan.principalAsset, plan.lenderDue
            );
        }
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: loan.collateralAmount - consumed,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });

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

        LibLifecycle.transition(
            loan,
            LibVaipakam.LoanStatus.Active,
            LibVaipakam.LoanStatus.Repaid
        );

        // #569 Gap B (round-6 P1) — RE-LIEN the residual rather than
        // tombstoning. `commitSwapToRepayIntent` decremented the lien to
        // zero when it pulled the collateral into custody; on a partial
        // fill (`makingAmount < custodialCollateral`) the residual was
        // pushed BACK into loan.borrower's vault above and recorded as the
        // borrower claim. This is the custody RETURN leg, so the residual
        // must be re-encumbered to stay protected through the Repaid→claim
        // window (released atomically by `claimAsBorrower`, with the burn
        // backstop as the structural guarantee). A bare release here would
        // let a transferred-away stored borrower drain the residual (VPFI
        // via withdrawVPFIFromVault) before the rightful holder claims. On
        // a full fill (residual 0) tombstone the now-zeroed row.
        // `residual` recomputed here as `loan.collateralAmount - consumed`
        // (identical to the borrower-claim amount recorded above; the fill
        // residual lives in the earlier `_runFill` scope, not here).
        uint256 intentResidual = loan.collateralAmount - consumed;
        if (intentResidual > 0) {
            LibEncumbrance.incrementCollateralLien(loanId, intentResidual);
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
