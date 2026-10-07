// src/facets/FallbackCustodyFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {LibSwap} from "../libraries/LibSwap.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EncumbranceMutateFacet} from "./EncumbranceMutateFacet.sol";
import {VaipakamNFTFacet} from "./VaipakamNFTFacet.sol";

/**
 * @title  FallbackCustodyFacet
 * @author Vaipakam Developer Team
 * @notice The one host for liquidation-fallback custody (#1566 slice 2):
 *         entering FallbackPending when a liquidation or default swap fails
 *         ({enterFallback}), the claim-time retry swap ({retryFallbackSwap}),
 *         the in-kind split distribution ({disposeFallbackCustody}), and the
 *         single read of where that custody rests ({getFallbackCustody}).
 * @dev    Why a facet of its own:
 *         - One home per rule. RiskFacet and DefaultedFacet each carried a
 *           copy of the fallback entry (`_fullCollateralTransferFallback`)
 *           whose code was identical (only comments differed), and ClaimFacet
 *           carried the retry swap, its soft-fail failover loop and the
 *           in-kind distribution. Each is now written once, here.
 *         - EIP-170. At 90f7e85ae RiskFacet had 67 B of headroom,
 *           DefaultedFacet 457 B and PrecloseFacet 318 B. Slice 2 (S2b) moves
 *           this custody out of the Diamond's own balance and into the
 *           borrower's vault under a lien, which turns each of these flows
 *           into a multi-step row move (vault transfer, lien, tracked balance,
 *           event). None of the tight lifecycle facets can absorb that, and
 *           every multi-step flow needs ONE host so its ordering is written in
 *           one place.
 *
 *         S2a (this revision) is a pure host split. Behaviour is identical to
 *         the code it replaces: the same storage writes in the same order, the
 *         same events (the three entry events are re-declared below with
 *         byte-identical signatures, so their topic hashes are unchanged), the
 *         same reverts (the callers' self-calls bubble non-empty revert bytes
 *         verbatim; an empty inner revert surfaces as `bytes4(0)`)
 *         and the same token movements. The fallback collateral still rests in
 *         the Diamond until a claim, backstop, cure, repayment or internal
 *         match moves it.
 *
 *         Every mutating entry is Diamond-internal (`msg.sender ==
 *         address(this)`, reached through {LibFacet.crossFacetCall}) and is
 *         deliberately NOT `nonReentrant`: every caller (`triggerLiquidation`,
 *         `triggerDefault`, the lender-claim and backstop paths) already holds
 *         the Diamond-wide reentrancy guard, so a guard here would revert every
 *         legitimate call. There is no pause check for the same reason: the
 *         caller's public entry point owns that policy.
 *
 *         REFRESH TOGETHER: {FallbackCustodyFacet, RiskFacet, DefaultedFacet,
 *         ClaimFacet, AddCollateralFacet, RepayFacet,
 *         RiskMatchLiquidationFacet}. RiskFacet, DefaultedFacet and ClaimFacet
 *         self-call this facet; refreshing any of them onto this code without
 *         cutting this facet leaves the selectors unrouted, so every
 *         swap-failure liquidation and default, and every FallbackPending
 *         lender claim, reverts `FunctionDoesNotExist`. AddCollateralFacet
 *         (cure), RepayFacet (curing repayment) and RiskMatchLiquidationFacet
 *         (internal match) consume the same custody and move onto this facet's
 *         custody rule in S2b.
 */
contract FallbackCustodyFacet is IVaipakamErrors {
    using SafeERC20 for IERC20;

    // --- Events -----------------------------------------------------------

    /// @notice Emitted when an HF-triggered liquidation ({RiskFacet}) or a
    ///         time-based default ({DefaultedFacet}) falls back to the
    ///         claim-time settlement path because the DEX swap reverted or
    ///         exceeded the slippage ceiling (README §7).
    /// @dev    Re-declared from {RiskFacet} / {DefaultedFacet} with a
    ///         byte-identical signature, so the topic hash is unchanged; those
    ///         facets keep their declarations so their ABIs still decode it.
    ///         Informational: the storage transition is the FallbackPending
    ///         status plus the `s.fallbackSnapshot[loanId]` write.
    ///         EventSourcingAudit §1.4 + §1.5 - primary-key-only payload.
    /// @param loanId The loan that entered fallback.
    /// @custom:event-category informational/liquidation
    event LiquidationFallback(uint256 indexed loanId);

    /// @notice Emitted alongside {LiquidationFallback} with the README §7
    ///         three-way split.
    /// @dev    Re-declared with a byte-identical signature (see
    ///         {LiquidationFallback}). The lender / treasury / borrower
    ///         allocation is stored verbatim in `s.fallbackSnapshot[loanId]`.
    /// @param loanId The loan that entered fallback.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackSplit(uint256 indexed loanId);

    /// @notice Emitted in addition to {LiquidationFallback} and
    ///         {LiquidationFallbackSplit} when the fallback ran without an
    ///         oracle-quorum price: the fair-value split was impossible, so the
    ///         lender's claim takes the whole collateral (treasury and borrower
    ///         zero). Lets indexers tell "lender claim exceeded collateral"
    ///         apart from "oracle quorum stale".
    /// @dev    Re-declared with a byte-identical signature (see
    ///         {LiquidationFallback}). Phase 2 of
    ///         AutonomousLtvAndOracleFallback.md.
    /// @param loanId The loan that entered fallback.
    /// @custom:event-category informational/liquidation
    event LiquidationFallbackOracleUnavailable(uint256 indexed loanId);

    // --- Access -----------------------------------------------------------

    /// @notice A Diamond-internal entry was called from outside the Diamond.
    /// @dev    Same name and signature as the `onlyDiamondInternal` error of
    ///         {EncumbranceMutateFacet} and VaultFactoryFacet, so the selector
    ///         is shared and decoders already know it.
    error OnlyDiamondInternal();

    function _checkDiamondInternal() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }

    /// @dev The repo's Diamond-internal gate (mirrors EncumbranceMutateFacet):
    ///      only the Diamond itself, through a self-call, may move fallback
    ///      custody. An EOA reaching these selectors could otherwise enter,
    ///      retry or distribute a fallback out of turn.
    modifier onlyDiamondInternal() {
        _checkDiamondInternal();
        _;
    }

    // --- Entry ------------------------------------------------------------

    /// @notice Enter FallbackPending for a loan whose liquidation or default
    ///         swap failed: record the README §7 three-way split, write both
    ///         claim rows in collateral units, transition Active ->
    ///         FallbackPending, mark both position NFTs, emit the entry events.
    /// @dev    The single fallback producer. It replaced
    ///         `RiskFacet._fullCollateralTransferFallback` and
    ///         `DefaultedFacet._fullCollateralTransferFallback`, whose code was
    ///         identical (only comments differed), so there is no per-caller
    ///         behaviour to parameterise.
    ///         Caller preconditions, unchanged: the collateral lien has been
    ///         released, `loan.collateralAmount` has been withdrawn into the
    ///         Diamond, and every swap adapter reverted. The collateral stays
    ///         in the Diamond (S2a) so {ClaimFacet} may retry the swap once at
    ///         the lender claim; if that also fails (or no retry is supplied),
    ///         {disposeFallbackCustody} distributes it per this split.
    ///         Reads no caller context: the body depends only on `loanId`,
    ///         storage, `address(this)` (the Diamond in either frame) and
    ///         `block.timestamp`, so the self-call is behaviour-identical.
    ///         DefaultedFacet still emits its own `LoanFallbackPending` after
    ///         this returns.
    /// @param loanId The loan entering fallback.
    function enterFallback(uint256 loanId) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];

        (
            uint256 lenderCol,
            uint256 treasuryCol,
            uint256 borrowerCol,
            uint256 lenderPrincDue,
            uint256 treasuryPrincDue,
            bool oracleAvailable
        ) = LibFallback.computeFallbackEntitlements(address(this), loan, loanId);

        s.fallbackSnapshot[loanId] = LibVaipakam.FallbackSnapshot({
            lenderCollateral: lenderCol,
            treasuryCollateral: treasuryCol,
            borrowerCollateral: borrowerCol,
            lenderPrincipalDue: lenderPrincDue,
            treasuryPrincipalDue: treasuryPrincDue,
            active: true,
            retryAttempted: false
        });

        // Record claims in collateral units. ClaimFacet will either rewrite
        // these to principal-asset amounts on a successful retry, or push
        // the collateral to lender/treasury/borrower vaults per this split
        // if the retry fails (or the borrower claims first).
        s.lenderClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: lenderCol,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: false
        });
        s.borrowerClaims[loanId] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: borrowerCol,
            assetType: LibVaipakam.AssetType.ERC20,
            tokenId: 0,
            quantity: 0,
            claimed: borrowerCol == 0
        });

        // #998 S10 (#1006 / #1132) — capture a confirmed freeze at fallback ENTRY,
        // where the oracle is up (both producers are HF- or grace-gated). Unlike an atomic
        // liquidation, the lender + borrower shares here are distributed LATER inside
        // a claim that can itself run during an oracle outage (fallback distribution
        // needs no oracle), so entry is the only reliable moment to record an
        // affirmative flag for BOTH the lender claim and the deferred borrower claim.
        // The `EncumbranceMutateFacet.terminalize` host records both holders AT this
        // Active→FallbackPending entry transition (design §2 Invariant A —
        // fallback-entry is a register-triggering edge).

        // Enter fallback-pending state. Borrower may still cure via addCollateral
        // or repayLoan until the lender claims; see LibVaipakam.LoanStatus docs.
        // #1132 (S10 central enforcement) — route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active→FallbackPending
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place (the standalone registers above were folded here).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.FallbackPending
            ),
            bytes4(0)
        );

        // Mark NFTs with pending status — final Defaulted/Liquidated label is
        // written once the lender claims (or the borrower cures back to Active).
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.lenderTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanFallbackPending
            ),
            NFTStatusUpdateFailed.selector
        );

        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                VaipakamNFTFacet.updateNFTStatus.selector,
                loan.borrowerTokenId,
                loanId,
                LibVaipakam.LoanPositionStatus.LoanFallbackPending
            ),
            NFTStatusUpdateFailed.selector
        );

        // §1.4 + §1.5 — informational events carry only the loanId primary
        // key. lender + split are recoverable from s.loans[loanId] and
        // s.fallbackSnapshot[loanId] respectively. The
        // {LiquidationFallbackOracleUnavailable} extra event (Phase 2
        // of AutonomousLtvAndOracleFallback.md) fires when the
        // fair-value split was impossible due to stale oracle quorum
        // — the lender absorbed everything in that case.
        emit LiquidationFallback(loanId);
        emit LiquidationFallbackSplit(loanId);
        if (!oracleAvailable) emit LiquidationFallbackOracleUnavailable(loanId);
    }

    // --- Claim-time retry -------------------------------------------------

    /// @notice Claim-time retry of the failed liquidation swap: sells the
    ///         Diamond-held fallback collateral for the principal asset under
    ///         the same slippage floor the liquidation used. Proceeds land in
    ///         the Diamond.
    /// @dev    Moved unchanged from `ClaimFacet._attemptRetrySwap` (S2a).
    ///         The callers (the ClaimFacet lender claim and keeper backstop)
    ///         keep `snap.retryAttempted`, `ClaimRetryExecuted` and the
    ///         proceeds distribution; this host only runs the swap.
    ///         The expected output reads {LibFallback.expectedSwapOutput},
    ///         which is the computation ClaimFacet's private
    ///         `_expectedSwapOutput` copy performed (same oracle reads in the
    ///         same order, same early return, same formula), so the rule now
    ///         has one home. `retryCalls` is `memory` (ABI-decoded here) so the
    ///         failover loop below moves byte-for-byte; the selector is the
    ///         same as for a calldata parameter.
    /// @param loanId     The FallbackPending loan.
    /// @param retryCalls Caller-ranked adapter try-list.
    /// @return ok        True iff an adapter committed.
    /// @return proceeds  Principal-asset proceeds on success, 0 otherwise.
    function retryFallbackSwap(
        uint256 loanId,
        LibSwap.AdapterCall[] memory retryCalls
    ) external onlyDiamondInternal returns (bool ok, uint256 proceeds) {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        // #591 — swap ONLY the Diamond-held portion of the collateral. For a
        // topped-up FallbackPending loan, `loan.collateralAmount` includes the
        // AddCollateral top-up which sits in the borrower's vault (liened), NOT
        // in Diamond custody; swapping the whole `collateralAmount` from the
        // Diamond would draw on same-token custody belonging to OTHER fallback
        // loans. The snapshot `lenderPrincipalDue` / `treasuryPrincipalDue`
        // that ClaimFacet's `_distributeRetryProceeds` distributes against
        // already describe only the Diamond (snapshot) portion, and the vault
        // top-up stays liened — owed to the borrower — through the in-kind
        // path. For a loan with no top-up the lien amount is 0, so this equals
        // `loan.collateralAmount` (unchanged behaviour).
        uint256 diamondPortion = LibVaipakam.hasActiveFallbackTopUp(loanId)
            ? loan.collateralAmount - LibVaipakam.storageSlot().loanCollateralLien[loanId].amount
            : loan.collateralAmount;
        uint256 expected = LibFallback.expectedSwapOutput(
            address(this),
            loan.collateralAsset,
            loan.principalAsset,
            diamondPortion
        );
        uint256 minOut = (expected *
            (LibVaipakam.BASIS_POINTS -
                LibVaipakam.cfgMaxLiquidationSlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        // Soft-fail failover, NOT LibSwap.swapWithFailover: see
        // {_swapWithFailoverMem} for the two differences and why they hold.
        return _swapWithFailoverMem(
            loanId,
            loan.collateralAsset,
            loan.principalAsset,
            diamondPortion,
            minOut,
            address(this),
            retryCalls
        );
    }

    // --- In-kind distribution ---------------------------------------------

    /// @notice Pushes the recorded fallback collateral split from the Diamond
    ///         into the treasury, the stored lender's vault and the stored
    ///         borrower's vault, and re-liens the borrower residual.
    /// @dev    Moved unchanged from `ClaimFacet._distributeFallbackCollateral`
    ///         (S2a). Used when the claim-time retry swap failed or was not
    ///         run. Reads the live snapshot and does NOT mutate it; the caller
    ///         clears `snap.active` afterwards, exactly as before. Returns
    ///         nothing, as before: the claim rows were written in the
    ///         collateral asset at fallback entry.
    /// @param loanId The FallbackPending loan whose snapshot is distributed.
    function disposeFallbackCustody(uint256 loanId) external onlyDiamondInternal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];

        if (snap.treasuryCollateral > 0) {
            IERC20(loan.collateralAsset).safeTransfer(
                s.treasury,
                snap.treasuryCollateral
            );
            LibFacet.recordTreasuryAccrual(loan.collateralAsset, snap.treasuryCollateral);
        }

        if (snap.lenderCollateral > 0) {
            // #821 (Codex #832 r4 P1) — vault-lock so a flagged stored lender
            // doesn't brick the fallback-collateral distribution.
            LibSanctionedLock.depositLocked(
                s, loan.lender, loanId, loan.collateralAsset, snap.lenderCollateral
            );
        }
        if (snap.borrowerCollateral > 0) {
            // #821 (Codex #832 r4 P1) — vault-lock so a flagged stored borrower
            // doesn't brick the fallback-collateral distribution.
            LibSanctionedLock.depositLocked(
                s, loan.borrower, loanId, loan.collateralAsset, snap.borrowerCollateral
            );
            // #998 S10 (#1006) — the borrower freeze marker is recorded by the
            // Class A `recordSanctionsFrozenClaimantBoth` at the top of the
            // lender claim, `ClaimFacet._claimAsLenderImpl` (registry-aware),
            // plus the fallback-ENTRY marker.
            // #569 Gap A — RE-LIEN the borrower residual pushed BACK into
            // the vault here. The lien was released at liquidation/default
            // ENTRY (when the full collateral left to Diamond custody); the
            // borrower-residual claim row was recorded then too. This is the
            // custody RETURN leg — the residual now sits in loan.borrower's
            // vault owed to the borrower-position holder, so it must be
            // encumbered through the window until `claimAsBorrower` releases
            // it (and the burn backstop guarantees release). Without this,
            // a transferred-away stored borrower could drain the residual
            // (VPFI via withdrawVPFIFromVault) before the rightful holder
            // claims. ERC20-only (create-if-absent on the released row).
            LibFacet.crossFacetCall(
                abi.encodeWithSelector(
                    EncumbranceMutateFacet.incrementCollateralLien.selector,
                    loanId,
                    snap.borrowerCollateral
                ),
                bytes4(0)
            );
        }
        // Claim records were already written in the collateral asset at
        // fallback time; nothing to rewrite here.
    }

    // --- Read -------------------------------------------------------------

    /// @notice Where a loan's liquidation-fallback custody rests.
    /// @dev    The one read the custody census and the Diamond-custody
    ///         attribution invariant (#2141) consume, so neither re-derives
    ///         the rule. S2a: no fallback custody is vault-held yet, so
    ///         `vaultHeld` is always 0, and an ACTIVE snapshot's whole split
    ///         (lender + treasury + borrower collateral) rests in the Diamond.
    ///         A resolved snapshot (`active == false`) keeps its fields (they
    ///         are not zeroed on resolution) but holds nothing, so it reads 0.
    ///         A partial internal match scales the snapshot by integer
    ///         division, so wei-level dust it drops is in the Diamond but in
    ///         no snapshot field (the #2141 rounding question). S2b moves the
    ///         custody into the borrower's vault and redefines both figures
    ///         from the custody row.
    /// @param loanId The loan to read.
    /// @return vaultHeld         Fallback collateral held in the borrower's vault (0 before S2b).
    /// @return legacyDiamondHeld Fallback collateral resting in the Diamond's own balance.
    function getFallbackCustody(uint256 loanId)
        external
        view
        returns (uint256 vaultHeld, uint256 legacyDiamondHeld)
    {
        LibVaipakam.FallbackSnapshot storage snap = LibVaipakam.storageSlot().fallbackSnapshot[loanId];
        if (snap.active) {
            legacyDiamondHeld =
                snap.lenderCollateral + snap.treasuryCollateral + snap.borrowerCollateral;
        }
        vaultHeld = 0; // nothing is vault-held before S2b
    }

    // --- Internal ---------------------------------------------------------

    /// @dev Soft-fail adapter failover for the claim-time retry, moved
    ///      unchanged from ClaimFacet (S2a). The try-list is `memory` because
    ///      {retryFallbackSwap} ABI-decodes it from the self-call.
    ///      It is deliberately NOT {LibSwap.swapWithFailover}, which differs
    ///      in two ways: (1) an empty try-list returns `(false, 0)` here before
    ///      the loop, with no `SwapAllAdaptersFailed`; (2) when every listed
    ///      venue is governance-disabled, this loop emits
    ///      `SwapAllAdaptersFailed` and returns `(false, 0)`, where LibSwap
    ///      reverts `NoEnabledSwapRoute` (#1005, which guards the fallback
    ///      ENTRY against a zero-attempt forced close). A retry that
    ///      soft-fails leaves the in-kind distribution as the outcome; the
    ///      callers never pass an empty list. Approvals are exact-scope per
    ///      attempt and reset to zero after it.
    function _swapWithFailoverMem(
        uint256 loanId,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        LibSwap.AdapterCall[] memory calls
    ) internal returns (bool, uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 registered = s.swapAdapters.length;
        if (registered == 0) revert LibSwap.NoSwapAdaptersConfigured();
        uint256 n = calls.length;
        if (n == 0) return (false, 0);

        for (uint256 i = 0; i < n; ++i) {
            uint256 idx = calls[i].adapterIdx;
            if (idx >= registered) {
                revert LibSwap.AdapterIndexOutOfRange(idx, registered);
            }
            address adapter = s.swapAdapters[idx];
            // #633 — skip a governance-paused venue (mirrors LibSwap.swapWithFailover),
            // so the per-venue kill-switch also covers claim/backstop retry swaps.
            if (s.swapAdapterDisabled[adapter]) continue;
            SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
            SafeERC20.forceApprove(IERC20(inputToken), adapter, inputAmount);
            try
                ISwapAdapter(adapter).execute(
                    inputToken,
                    outputToken,
                    inputAmount,
                    minOutputAmount,
                    recipient,
                    calls[i].data
                )
            returns (uint256 out_) {
                SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
                emit LibSwap.SwapAdapterAttempted(loanId, idx, adapter, true);
                emit LibSwap.SwapAdapterSucceeded(loanId, idx, adapter, out_);
                return (true, out_);
            } catch {
                SafeERC20.forceApprove(IERC20(inputToken), adapter, 0);
                emit LibSwap.SwapAdapterAttempted(loanId, idx, adapter, false);
            }
        }
        emit LibSwap.SwapAllAdaptersFailed(loanId);
        return (false, 0);
    }
}
