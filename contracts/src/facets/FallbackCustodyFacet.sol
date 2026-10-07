// src/facets/FallbackCustodyFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibFallback} from "../libraries/LibFallback.sol";
import {LibFallbackCustody} from "../libraries/LibFallbackCustody.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibConsolidation} from "../libraries/LibConsolidation.sol";
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
 *           whose code was identical, and ClaimFacet carried the retry swap,
 *           its soft-fail failover loop and the in-kind distribution. Each is
 *           written once, here, so the ORDER of each multi-step custody move
 *           is written in one place.
 *         - EIP-170. RiskFacet, DefaultedFacet and PrecloseFacet sit within a
 *           few hundred bytes of the limit and cannot absorb a multi-step row
 *           move (vault transfer, lien, tracked balance, event, restamp).
 *
 *         The custody rule (S2b, #2141). No user-owned asset rests in the
 *         Diamond's own balance when a transaction ends. When the swap fails,
 *         the collateral the caller withdrew into the Diamond goes straight
 *         back into `loan.borrower`'s vault, in the same transaction, under
 *         the loan's collateral lien, and the per-loan custody row (read and
 *         written only through {LibFallbackCustody}) records how much of that
 *         vault balance is the fallback episode's custody. The snapshot keeps
 *         saying WHO is owed WHAT; the row says how much of it is still there.
 *         Why the vault and not the Diamond: in the Diamond the custody is
 *         commingled with every other same-token balance the Diamond holds
 *         (other loans' fallbacks, the VPFI recycle bucket, treasury balances
 *         when the Diamond is the treasury), so one wrong accounting path pays
 *         one owner out of another's funds, and the reward backing (#1566)
 *         cannot tell user custody from protocol funds. In the borrower's
 *         vault it is isolated, protocol-tracked and locked by the lien, and
 *         the custody census can show the Diamond holds none of it.
 *
 *         Transparent movement. Every unit that enters or leaves the row is an
 *         explicit row move: {LibFallbackCustody.credit} / `debit` writes the
 *         row, emits `FallbackCustodyMoved` (move kind, counterparty, asset,
 *         amount, row after) and re-derives the VPFI fee-tier exclusion. A
 *         slice that leaves the vault always takes the same three steps in the
 *         same order ({_moveOut}): debit the row, decrement the lien by the
 *         same amount, then move the tokens. The lien drops first because the
 *         vault's withdraw guard refuses to dip into an active lien. It drops
 *         by EXACTLY the slice because whatever lien remains is what the
 *         Defaulted fold later records as collateral owed to the borrower: a
 *         lien left too high would let the borrower claim the departed slice
 *         out of their own unrelated balance.
 *
 *         Fail closed on a legacy row (owner decision O1 = A, 2026-10-07).
 *         Every chain that runs this code is a fresh deploy, so no snapshot
 *         can predate the row. A snapshot that is active while its total
 *         differs from the row ({LibFallbackCustody.isLegacy}) would be
 *         custody resting in the Diamond under the pre-S2b rule; every
 *         mutating entry refuses it by name (`FallbackCustodyNotVaultHeld`)
 *         rather than paying it out of the Diamond's commingled balance. There
 *         is deliberately no migration code.
 *
 *         VPFI tier. For VPFI collateral the row is an input to the fee-tier
 *         exclusion (a FallbackPending loan keeps the row out of
 *         `loan.borrower`'s tier, as it did when the custody sat in the
 *         Diamond), and the row's mutators notify the exclusion host
 *         themselves. A vault withdrawal does not restamp, so every entry
 *         that moves VPFI out of the vault ends with ONE broadcast-free local
 *         restamp of `loan.borrower` after its last move ({_restampIfVpfi});
 *         without it the stamp keeps counting VPFI that already left.
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
 *         (internal match) read and move the same custody row through
 *         {LibFallbackCustody}; one of them left on pre-S2b code would pay
 *         Diamond-held custody that no longer exists, or lien the custody a
 *         second time.
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
    ///         status plus the `s.fallbackSnapshot[loanId]` write; the custody
    ///         itself is evidenced by `FallbackCustodyMoved(Entered)`.
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

    // --- Errors -----------------------------------------------------------

    /// @notice The fallback split and the custody row disagree.
    /// @dev    The row is the custody; the snapshot is the split of it. Both
    ///         consumers of the split ({disposeFallbackCustody} and the
    ///         internal match) move slices out by the snapshot's figures, so
    ///         the two must agree to the unit or a disposal leaves custody
    ///         stranded under the row or debits past it. Raised by
    ///         {enterFallback} when, after the entry credit, the row is not
    ///         the snapshot total (a split that does not sum to the moved
    ///         collateral, or a row a previous episode left non-zero), and by
    ///         {disposeFallbackCustody} when a non-zero row is not exactly the
    ///         three slices it is about to move.
    /// @param loanId        The loan.
    /// @param snapshotTotal Lender + treasury + borrower collateral recorded.
    /// @param held          The custody row.
    error FallbackSnapshotMismatch(uint256 loanId, uint256 snapshotTotal, uint256 held);

    /// @notice The retry pull delivered to the Diamond a different amount than
    ///         the custody row it debited.
    /// @dev    The retry is the one place the custody passes through the
    ///         Diamond (for the length of the swap). The swap and, on failure,
    ///         the restore spend exactly the debited amount out of the
    ///         Diamond's commingled balance, so a short delivery (a
    ///         fee-on-transfer or rebasing collateral) would be made up out of
    ///         another owner's funds. Measured as the Diamond's balance delta
    ///         across the pull.
    /// @param loanId   The FallbackPending loan.
    /// @param received What the Diamond's balance actually rose by.
    /// @param expected The custody row debited.
    error FallbackRetryShortDelivery(uint256 loanId, uint256 received, uint256 expected);

    /// @notice {disposeFallbackCustody} was asked to label the lender slice
    ///         with a move that is not a lender-slice move.
    /// @dev    The lender slice goes vault to vault, labelled `ToLender` (the
    ///         claim) or `ToBackstop` (the backstop absorb). Any other label
    ///         would route the slice through a different transfer (the
    ///         treasury accrual or the retry pull) and misstate it in the
    ///         custody event, so the label is checked rather than trusted.
    /// @param move The rejected label.
    error FallbackLenderMoveInvalid(LibFallbackCustody.Move move);

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
    ///         swap failed: record the README §7 three-way split and both
    ///         claim rows in collateral units, return the collateral to
    ///         `loan.borrower`'s vault under the lien and credit the custody
    ///         row, transition Active -> FallbackPending, mark both position
    ///         NFTs, emit the entry events.
    /// @dev    The single fallback producer (it replaced the two identical
    ///         `_fullCollateralTransferFallback` copies in RiskFacet and
    ///         DefaultedFacet). Caller preconditions, unchanged from S2a: the
    ///         collateral lien has been released, `loan.collateralAmount` has
    ///         been withdrawn into the Diamond, and every swap adapter
    ///         reverted (approvals reset). After this returns the Diamond
    ///         keeps NOTHING of it.
    ///         The order is load-bearing:
    ///         1. Write the snapshot and the claim rows (the split sums to
    ///            `loan.collateralAmount`, {LibFallback.computeFallbackEntitlements}).
    ///         2. {_custodyIntoVault} (`Entered`), shared with the retry
    ///            restore so custody always goes back into the vault one way:
    ///            `depositLocked` into `loan.borrower`'s vault (the vault
    ///            resolves behind the receive-side pin, so a borrower flagged
    ///            after init cannot brick the forced close-out; the
    ///            protocol-tracked balance ticks; NO tier rollup), the row
    ///            credit, the lien re-created for the deposited amount
    ///            (create-if-absent on the row the caller released), then the
    ///            check that the row equals the snapshot total, so the row and
    ///            the split agree from birth.
    ///         3. The Active -> FallbackPending transition. Its exclusion sync
    ///            installs the FallbackPending clause (VPFI collateral) and
    ///            restamps the borrower ONCE, at the deposited balance minus
    ///            the row, so the tier never sees the collateral leave and
    ///            come back as a dip. Step 2 cannot restamp: the loan is still
    ///            Active and carries no exclusion record, so its notifies are
    ///            no-ops.
    ///         4. NFT statuses, then the three entry events. DefaultedFacet
    ///            still emits its own `LoanFallbackPending` after this returns.
    ///         Reads no caller context: the body depends only on `loanId`,
    ///         storage, `address(this)` and `block.timestamp`.
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
        // these to principal-asset amounts on a successful retry, or move
        // the collateral out of the borrower's vault per this split if the
        // retry fails (or none is run).
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

        // #1566 S2b - the custody goes back to the borrower's vault in this
        // transaction, under the lien, and the row records it (step 2).
        _custodyIntoVault(
            s,
            loanId,
            loan.borrower,
            loan.collateralAsset,
            loan.collateralAmount,
            LibFallbackCustody.Move.Entered
        );

        // #998 S10 (#1006 / #1132) - capture a confirmed freeze at fallback ENTRY,
        // where the oracle is up (both producers are HF- or grace-gated). Unlike an atomic
        // liquidation, the lender + borrower shares here are distributed LATER inside
        // a claim that can itself run during an oracle outage (fallback distribution
        // needs no oracle), so entry is the only reliable moment to record an
        // affirmative flag for BOTH the lender claim and the deferred borrower claim.
        // The `EncumbranceMutateFacet.terminalize` host records both holders AT this
        // Active->FallbackPending entry transition (design §2 Invariant A -
        // fallback-entry is a register-triggering edge).

        // Enter fallback-pending state. Borrower may still cure via addCollateral
        // or repayLoan until the lender claims; see LibVaipakam.LoanStatus docs.
        // #1132 (S10 central enforcement) - route through the
        // `EncumbranceMutateFacet.terminalize` host so the validated Active->FallbackPending
        // transition AND both holders' fail-closed frozen-claimant markers land
        // in one place. Its tier-exclusion sync is step 3 above.
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                EncumbranceMutateFacet.terminalize.selector,
                loanId,
                LibVaipakam.LoanStatus.Active,
                LibVaipakam.LoanStatus.FallbackPending
            ),
            bytes4(0)
        );

        // Mark NFTs with pending status - final Defaulted/Liquidated label is
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

        // §1.4 + §1.5 - informational events carry only the loanId primary
        // key. lender + split are recoverable from s.loans[loanId] and
        // s.fallbackSnapshot[loanId] respectively. The
        // {LiquidationFallbackOracleUnavailable} extra event (Phase 2
        // of AutonomousLtvAndOracleFallback.md) fires when the
        // fair-value split was impossible due to stale oracle quorum
        // - the lender absorbed everything in that case.
        emit LiquidationFallback(loanId);
        emit LiquidationFallbackSplit(loanId);
        if (!oracleAvailable) emit LiquidationFallbackOracleUnavailable(loanId);
    }

    // --- Claim-time retry -------------------------------------------------

    /// @notice Claim-time retry of the failed liquidation swap: pulls the
    ///         fallback custody out of `loan.borrower`'s vault and sells it
    ///         for the principal asset under the same slippage floor the
    ///         liquidation used. Proceeds land in the Diamond, where the
    ///         caller distributes them in the same transaction.
    /// @dev    Sells ONLY the custody row, never a FallbackPending top-up: the
    ///         top-up shares the vault and the lien but is owed to the
    ///         borrower, and the snapshot's principal-due figures the caller
    ///         distributes against describe only the fallback episode. The
    ///         expected output and the floor are computed on the row.
    ///         Fail closed on a legacy row (`FallbackCustodyNotVaultHeld`);
    ///         a zero row (a snapshot a partial internal match scaled to
    ///         nothing) returns `(false, 0)` without a pull.
    ///         The pull is a {_moveOut} (`RetryPulled`) whose delivery is
    ///         checked against the Diamond's balance delta. On failure the
    ///         custody is RESTORED before returning ({_custodyIntoVault}): the
    ///         tokens go back into the vault through the pinned deposit (a
    ///         borrower flagged after entry must not brick the lender's
    ///         recovery), the row is re-credited (`RetryRestored`; its notify
    ///         re-derives the exclusion against the restored balance, so no
    ///         dip), and the lien is raised back by the same amount. The
    ///         restore is required, not cosmetic: the backstop path may
    ///         return without disposing after a failed retry (zero lender
    ///         slice), and the custody must then be exactly where it was.
    ///         Ends with one local restamp when the collateral is VPFI.
    ///         Observability caveat (RL-2): the pull emits `VaultVpfiDebited`
    ///         for VPFI and the restore has no credit counterpart there, so a
    ///         failed VPFI retry understates the borrower's reward-retention
    ///         figure by the row; no funds are affected.
    ///         The callers (the ClaimFacet lender claim and keeper backstop)
    ///         keep `snap.retryAttempted`, `ClaimRetryExecuted` and the
    ///         proceeds distribution. `retryCalls` is `memory` (ABI-decoded
    ///         here) for the failover loop; the selector is the same as for a
    ///         calldata parameter.
    /// @param loanId     The FallbackPending loan.
    /// @param retryCalls Caller-ranked adapter try-list.
    /// @return ok        True iff an adapter committed.
    /// @return proceeds  Principal-asset proceeds on success, 0 otherwise.
    function retryFallbackSwap(
        uint256 loanId,
        LibSwap.AdapterCall[] memory retryCalls
    ) external onlyDiamondInternal returns (bool ok, uint256 proceeds) {
        LibFallbackCustody.requireVaultHeld(loanId);
        uint256 held = LibFallbackCustody.held(loanId);
        if (held == 0) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        address borrower = loan.borrower;
        address c = loan.collateralAsset;

        uint256 minOut = (LibFallback.expectedSwapOutput(
            address(this),
            c,
            loan.principalAsset,
            held
        ) * (LibVaipakam.BASIS_POINTS - LibVaipakam.cfgMaxLiquidationSlippageBps())) /
            LibVaipakam.BASIS_POINTS;

        _moveOut(s, loanId, borrower, c, held, LibFallbackCustody.Move.RetryPulled, address(this));

        // Soft-fail failover, NOT LibSwap.swapWithFailover: see
        // {_swapWithFailoverMem} for the two differences and why they hold.
        (ok, proceeds) = _swapWithFailoverMem(
            loanId,
            c,
            loan.principalAsset,
            held,
            minOut,
            address(this),
            retryCalls
        );
        if (!ok) {
            // Every adapter reverted, so its transfer rolled back and the
            // Diamond still holds exactly `held` of the pulled custody.
            _custodyIntoVault(s, loanId, borrower, c, held, LibFallbackCustody.Move.RetryRestored);
        }
        _restampIfVpfi(s, c, borrower);
    }

    // --- In-kind distribution ---------------------------------------------

    /// @notice Moves the recorded fallback split out of `loan.borrower`'s
    ///         vault: the treasury slice to the treasury, the lender slice
    ///         vault to vault into `lenderSliceOwner`'s vault, and the
    ///         borrower residual stays in place, still under the lien.
    /// @dev    Used when the claim-time retry failed or was not run, by the
    ///         lender claim (`lenderSliceOwner = loan.lender`, `ToLender`) and
    ///         by the backstop absorb (`lenderSliceOwner = backstop vault`,
    ///         `ToBackstop`). Each departing slice is a {_moveOut}: row debit,
    ///         lien decrement by the slice, then the move under the from-side
    ///         exemption (a borrower flagged after entry must not strand the
    ///         lender's or the treasury's slice). The borrower residual is a
    ///         row debit ONLY (`RetainedForBorrower`): the tokens are already
    ///         where they belong and the lien over them stays as the residual
    ///         claim's lien, so no re-lien is needed and none is done. After
    ///         this the row is 0 and the lien is the residual plus any
    ///         FallbackPending top-up, which is exactly what the Defaulted
    ///         fold records as the borrower's owed collateral.
    ///         Reads the live snapshot and NEVER mutates it; the caller clears
    ///         `snap.active` afterwards. The return values are what actually
    ///         moved, so a caller (the backstop warehouse counter) never
    ///         re-reads a snapshot field for them.
    ///         Fail closed on a legacy row. A zero row returns `(0, 0, 0)`
    ///         with nothing moved: a snapshot a partial internal match scaled
    ///         to nothing, whose proceeds already sit in `heldForLender`. The
    ///         row also bounds a repeat: a second call finds it at 0.
    ///         Ends with one local restamp when the collateral is VPFI.
    /// @param loanId           The FallbackPending loan whose snapshot is distributed.
    /// @param lenderSliceOwner Vault owner that receives the lender slice.
    /// @param lenderMove       `ToLender` or `ToBackstop`, the label of that move.
    /// @return toTreasury          Collateral moved to the treasury.
    /// @return toLenderSlice       Collateral moved into `lenderSliceOwner`'s vault.
    /// @return retainedForBorrower Collateral left in the borrower's vault under the lien.
    function disposeFallbackCustody(
        uint256 loanId,
        address lenderSliceOwner,
        LibFallbackCustody.Move lenderMove
    )
        external
        onlyDiamondInternal
        returns (uint256 toTreasury, uint256 toLenderSlice, uint256 retainedForBorrower)
    {
        if (
            lenderMove != LibFallbackCustody.Move.ToLender &&
            lenderMove != LibFallbackCustody.Move.ToBackstop
        ) revert FallbackLenderMoveInvalid(lenderMove);
        LibFallbackCustody.requireVaultHeld(loanId);
        uint256 held = LibFallbackCustody.held(loanId);
        if (held == 0) return (0, 0, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage loan = s.loans[loanId];
        LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loanId];
        address borrower = loan.borrower;
        address c = loan.collateralAsset;
        toTreasury = snap.treasuryCollateral;
        toLenderSlice = snap.lenderCollateral;
        retainedForBorrower = snap.borrowerCollateral;
        // The three slices must drain the row exactly: fewer would strand
        // custody under a row no one disposes, more would debit past it.
        if (toTreasury + toLenderSlice + retainedForBorrower != held) {
            revert FallbackSnapshotMismatch(
                loanId, toTreasury + toLenderSlice + retainedForBorrower, held
            );
        }

        _moveOut(s, loanId, borrower, c, toTreasury, LibFallbackCustody.Move.ToTreasury, s.treasury);
        _moveOut(s, loanId, borrower, c, toLenderSlice, lenderMove, lenderSliceOwner);
        if (retainedForBorrower > 0) {
            LibFallbackCustody.debit(
                loanId, retainedForBorrower, LibFallbackCustody.Move.RetainedForBorrower, borrower
            );
        }
        _restampIfVpfi(s, c, borrower);
    }

    // --- Read -------------------------------------------------------------

    /// @notice Where a loan's liquidation-fallback custody rests.
    /// @dev    The one read the custody census and the Diamond-custody
    ///         attribution invariant (#2141) consume, so neither re-derives
    ///         the rule. `vaultHeld` is the custody row: the fallback custody
    ///         held in `loan.borrower`'s vault under the lien (non-zero only
    ///         while FallbackPending; a top-up is not part of it).
    ///         `legacyDiamondHeld` is non-zero only for a legacy row
    ///         ({LibFallbackCustody.isLegacy}: active snapshot whose total
    ///         differs from the row), where it is the snapshot total resting in
    ///         the Diamond under the pre-S2b rule. On a fresh deploy (owner
    ///         decision O1 = A) it is always 0, and a non-zero value means a
    ///         consumer will refuse the loan with `FallbackCustodyNotVaultHeld`.
    ///         A resolved snapshot keeps its fields (they are not zeroed) but
    ///         holds nothing, so it reads (0, 0).
    /// @param loanId The loan to read.
    /// @return vaultHeld         Fallback custody held in the borrower's vault.
    /// @return legacyDiamondHeld Fallback custody resting in the Diamond's own balance (legacy rows only).
    function getFallbackCustody(uint256 loanId)
        external
        view
        returns (uint256 vaultHeld, uint256 legacyDiamondHeld)
    {
        vaultHeld = LibFallbackCustody.held(loanId);
        if (LibFallbackCustody.isLegacy(loanId)) {
            legacyDiamondHeld = LibFallbackCustody.snapshotTotal(loanId);
        }
    }

    // --- Custody moves (private) ------------------------------------------

    /// @dev Custody that sits in the Diamond (just withdrawn by the producer,
    ///      or pulled for a retry that failed) goes into `borrower`'s vault
    ///      under the lien, and the row is credited for it. Used by the entry
    ///      (`Entered`) and by the retry restore (`RetryRestored`), so both
    ///      put custody back the same way:
    ///      1. `depositLocked`: the vault resolves behind the receive-side pin
    ///         (a borrower flagged after init must not brick a forced
    ///         close-out or the lender's recovery), the protocol-tracked
    ///         balance ticks, and there is no tier rollup.
    ///      2. The row credit; its notify re-derives the exclusion against a
    ///         balance that already includes the deposit, so no dip.
    ///      3. The lien rises by the same amount (create-if-absent).
    ///      Afterwards the row must equal the snapshot total
    ///      (`FallbackSnapshotMismatch` otherwise): at entry that pins the
    ///      split to the collateral actually placed under the row (and a row
    ///      a previous episode left non-zero); on a restore the row returns to
    ///      the total the pull took it from.
    ///      At entry the loan is still Active and carries no exclusion
    ///      record, so steps 2 and 3 notify nothing whichever comes first and
    ///      the transition's sync does the one restamp; on a restore the
    ///      credit's notify is the restamp and the lien increment changes no
    ///      exclusion. One order therefore serves both.
    function _custodyIntoVault(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address borrower,
        address asset,
        uint256 amount,
        LibFallbackCustody.Move move
    ) private {
        LibSanctionedLock.depositLocked(s, borrower, loanId, asset, amount);
        LibFallbackCustody.credit(loanId, amount, move, borrower);
        LibEncumbrance.incrementCollateralLien(loanId, amount);
        uint256 total = LibFallbackCustody.snapshotTotal(loanId);
        uint256 row = LibFallbackCustody.held(loanId);
        if (total != row) revert FallbackSnapshotMismatch(loanId, total, row);
    }

    /// @dev The one move-out sequence for every slice that leaves the
    ///      borrower's vault (see the contract header for why the order is
    ///      fixed): row debit, lien decrement by the same amount, then the
    ///      transfer. The transfer depends on the move:
    ///      - `ToTreasury`: vault -> `to` (the treasury) under the from-side
    ///        exemption, then the treasury accrual record (credits
    ///        `treasuryBalances` when the Diamond is the treasury).
    ///      - `RetryPulled`: vault -> the Diamond under the from-side
    ///        exemption, delivery checked against the Diamond's balance delta
    ///        (`FallbackRetryShortDelivery`).
    ///      - `ToLender` / `ToBackstop`: vault -> `to`'s vault through the
    ///        pinned vault-to-vault deposit, which ticks `to`'s tracked balance.
    ///      A zero amount moves nothing and emits nothing.
    function _moveOut(
        LibVaipakam.Storage storage s,
        uint256 loanId,
        address borrower,
        address asset,
        uint256 amount,
        LibFallbackCustody.Move move,
        address to
    ) private {
        if (amount == 0) return;
        LibFallbackCustody.debit(loanId, amount, move, to);
        LibEncumbrance.decrementCollateralLien(loanId, amount);
        if (move == LibFallbackCustody.Move.ToTreasury) {
            LibSanctionedLock.vaultWithdrawERC20MoveOut(s, borrower, asset, to, amount);
            LibFacet.recordTreasuryAccrual(asset, amount);
        } else if (move == LibFallbackCustody.Move.RetryPulled) {
            uint256 before = IERC20(asset).balanceOf(address(this));
            LibSanctionedLock.vaultWithdrawERC20MoveOut(s, borrower, asset, address(this), amount);
            uint256 afterPull = IERC20(asset).balanceOf(address(this));
            if (afterPull != before + amount) {
                revert FallbackRetryShortDelivery(
                    loanId, afterPull > before ? afterPull - before : 0, amount
                );
            }
        } else {
            LibSanctionedLock.depositLockedFromVault(s, borrower, to, loanId, asset, amount);
        }
    }

    /// @dev The final local restamp after a host entry moved VPFI custody
    ///      out of (or back into) `borrower`'s vault. Broadcast-free on
    ///      purpose: these entries run inside must-complete close-outs and
    ///      claims, and a broadcasting stamp can revert on an exhausted CCIP
    ///      budget (the close-out rule `EncumbranceMutateFacet` documents).
    ///      The mirror-chain tier picks the change up at the owner's next
    ///      broadcasting mutation. No-op for any other collateral.
    function _restampIfVpfi(
        LibVaipakam.Storage storage s,
        address asset,
        address borrower
    ) private {
        if (asset == s.vpfiToken) LibConsolidation.restampUserVpfiLocal(borrower);
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
