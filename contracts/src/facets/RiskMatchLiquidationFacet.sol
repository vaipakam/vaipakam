// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {SwapToRepayIntentFacet} from "./SwapToRepayIntentFacet.sol";
import {LibLifecycle} from "../libraries/LibLifecycle.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {VaultFactoryFacet} from "./VaultFactoryFacet.sol";
import {MetricsFacet} from "./MetricsFacet.sol";
import {RiskFacet} from "./RiskFacet.sol";

/**
 * @title RiskMatchLiquidationFacet
 * @author Vaipakam Developer Team
 * @notice Internal-match liquidation — the opposing-loan settlement path
 *         that pairs two (or three, in a closed A→B→C→A chain)
 *         liquidatable loans and settles them against each other at
 *         oracle price, with zero aggregator slippage and a per-leg
 *         matcher incentive.
 * @dev    Part of the Diamond Standard (EIP-2535). Reentrancy-guarded,
 *         pausable. Extracted verbatim from {RiskFacet} (Issue #66) so
 *         neither facet exceeds the EIP-170 24,576-byte runtime
 *         contract-size limit — RiskFacet had grown 541 bytes over.
 *         This is a pure relocation: no logic change. The facet shares
 *         Diamond storage with every other facet via {LibVaipakam}, so
 *         the move needs no storage migration.
 *
 *         Surface:
 *           - {triggerInternalMatchLiquidation} — permissionless 2-loan
 *             or 3-loan internal match.
 *           - {attemptInternalMatchAutoDispatch} — cross-facet-only
 *             auto-dispatch hook the external-liquidation entry points
 *             ({RiskFacet.triggerLiquidation}, {DefaultedFacet},
 *             {ClaimFacet}) call before falling through to the
 *             aggregator path.
 */
contract RiskMatchLiquidationFacet is DiamondReentrancyGuard, DiamondPausable {
    using SafeERC20 for IERC20;

    /// @dev EC-003 Phase 3 — restricts a call to cross-facet only
    ///      (`msg.sender == address(this)`, i.e., another facet inside
    ///      the Diamond reached us via `address(this).call(...)`).
    ///      External callers via the Diamond's fallback have
    ///      `msg.sender == EOA`. Same pattern `VaultFactoryFacet` uses
    ///      for its cross-facet-only entry-points.
    error OnlyDiamondInternal();
    /// @dev Extracted modifier body — keeps the modifier a thin wrapper
    ///      so each call site inlines one function call, deduping bytecode.
    function _checkDiamondInternal() private view {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
    }
    modifier onlyDiamondInternal() {
        _checkDiamondInternal();
        _;
    }

    // ── Internal-match validation errors ──────────────────────────────
    /// @notice The master kill-switch (`internalMatchEnabled`) is off.
    error InternalMatchDisabled();
    /// @notice One of the loans referenced isn't in a matchable status
    ///         (`Active` or `FallbackPending`). EC-003 Phase 1 widened the
    ///         allowed set from `{Active}` to `{Active, FallbackPending}`
    ///         so loans whose at-fallback swap failed transiently can
    ///         still be rescued via internal match when conditions
    ///         normalize.
    error InternalMatchLoanNotMatchable(uint256 loanId);
    /// @notice One of the leg assets has no trustworthy oracle price right
    ///         now. Reached when the primary feed is stale past the
    ///         volatile/stable ceiling OR the Soft 2-of-N secondary quorum
    ///         disagrees. Internal match settles at oracle price (no DEX
    ///         swap), so the only blocking condition is "we can't trust
    ///         any number for this asset." EC-003 Phase 1.
    error InternalMatchAssetUnpriceable(address asset);
    /// @notice Caller passed the same loan ID for two legs of a match.
    error InternalMatchSelfPair(uint256 loanId);
    /// @notice The two loans don't form an opposing pair —
    ///         `A.principalAsset == B.collateralAsset` AND
    ///         `A.collateralAsset == B.principalAsset` must both hold.
    error InternalMatchAssetMismatch(uint256 loanIdA, uint256 loanIdB);
    /// @notice The 3-loan chain doesn't form a closed `A→B→C→A` cycle.
    error InternalMatchChainBroken(uint256 loanIdA, uint256 loanIdB, uint256 loanIdC);
    /// @notice The loan's current LTV is below its snapshotted
    ///         liquidation threshold — it isn't liquidatable yet, so
    ///         internal-match can't fire.
    error InternalMatchLtvBelowFloor(uint256 loanId, uint256 currentLtvBps, uint256 floorBps);
    /// @notice A FallbackPending loan still carries a vault-held AddCollateral
    ///         top-up (an active, non-released collateral lien on the released
    ///         at-fallback row). Internal-match settlement draws the moved
    ///         collateral from Diamond custody, which mis-accounts against that
    ///         vault-held top-up across the full / partial / zero-residual
    ///         settlement branches. Until the top-up-aware unwind lands (#585)
    ///         such a loan is ineligible for internal match — rejected at the
    ///         eligibility gate (`_gateMatchableLeg`), before any funds move, so
    ///         the residual can never be mis-settled. Auto-dispatch skips the
    ///         same condition without reverting.
    error InternalMatchFallbackTopUpUnsupported(uint256 loanId);

    /// @notice Emitted by `triggerInternalMatchLiquidation` on a valid
    ///         match. PR4 is validation-only and emits this from the
    ///         no-op success path; PR5 will repurpose the same event
    ///         after the execution body lands (cross-vault collateral
    ///         transfer + incentive payout + status transition).
    ///         The two indexed leg fields make event-grep cheap for
    ///         the keeper-bot detector that scans matches.
    /// @custom:event-category state-change/loan-mutation
    event InternalMatchExecuted(
        uint256 indexed loanIdA,
        uint256 indexed loanIdB,
        uint256 loanIdC,
        address matcher,
        uint256 notionalA,
        uint256 notionalB,
        uint256 notionalC,
        uint256 incentivePaidA,
        uint256 incentivePaidB,
        uint256 incentivePaidC
    );

    /**
     * @notice Internal-liquidation match path (B.2 / PR4) — validates a
     *         2-loan or 3-loan match without yet mutating state.
     *
     *         The validation surface ratified in plan-mode Q&A:
     *           1. Kill-switch (`internalMatchEnabled`) must be on.
     *           2. Loans referenced must be `LoanStatus.Active`.
     *           3. No leg may repeat (self-pair / chain-repeat).
     *           4. Asset opposition — 2-loan: `A.principalAsset ==
     *              B.collateralAsset && A.collateralAsset ==
     *              B.principalAsset`; 3-loan chain: `A.principalAsset
     *              == B.collateralAsset && B.principalAsset ==
     *              C.collateralAsset && C.principalAsset ==
     *              A.collateralAsset`.
     *           5. Each leg's current LTV must be at or above its
     *              snapshotted liquidation threshold (`HF < 1` ⇔
     *              loan is liquidatable).
     *           6. Tier-1 sanctions gate on `msg.sender`.
     *
     *         PR4 ships intentionally body-less: after all gates pass
     *         the function emits a placeholder `InternalMatchExecuted`
     *         with zero notional / incentive fields and returns. PR5
     *         fills in the matched-collateral movement + incentive
     *         payout + status transitions. The kill-switch defaults
     *         `false` so production deploys never reach this path
     *         until governance flips it on AFTER PR5 has landed.
     *
     * @param  loanIdA  First leg loan ID.
     * @param  loanIdB  Second leg loan ID (must oppose A).
     * @param  loanIdC  Third leg loan ID for a 3-loan chain, or `0`
     *                  to skip the chain branch and run a 2-loan
     *                  match.
     */
    function triggerInternalMatchLiquidation(
        uint256 loanIdA,
        uint256 loanIdB,
        uint256 loanIdC
    ) external nonReentrant whenNotPaused {
        // T-090 v1.1 (#389) §5.8 layer 2 — force-cancel any live
        // v1.1 commit on each leg if HF below liquidation
        // threshold; otherwise revert `IntentPending`. The
        // internal-match liquidator withdraws from every leg's
        // borrower vault simultaneously, so any live commit on
        // any of the three legs would orphan its custodial slot.
        if (LibVaipakam.storageSlot().intentCommits[loanIdA].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanIdA);
        }
        if (LibVaipakam.storageSlot().intentCommits[loanIdB].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanIdB);
        }
        if (LibVaipakam.storageSlot().intentCommits[loanIdC].orderHash != bytes32(0)) {
            SwapToRepayIntentFacet(address(this)).forceCancelIntentIfHFBelowOrRevert(loanIdC);
        }
        // Tier-1 sanctions: matcher receives 1% per leg in PR5;
        // blocking sanctioned wallets here keeps the value-receipt
        // path closed.
        LibVaipakam._assertNotSanctioned(msg.sender);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.internalMatchEnabled) revert InternalMatchDisabled();

        // Self-pair / chain-repeat. Includes the C=A and C=B cases
        // when C is non-zero. A zero C means "skip 3-way", so the
        // A/B duplicate is the only check that matters there.
        if (loanIdA == loanIdB) revert InternalMatchSelfPair(loanIdA);
        if (loanIdC != 0) {
            if (loanIdC == loanIdA) revert InternalMatchSelfPair(loanIdA);
            if (loanIdC == loanIdB) revert InternalMatchSelfPair(loanIdB);
        }

        // EC-003 Phase 1 — matchable status set widened from {Active} to
        // {Active, FallbackPending}. FallbackPending loans that failed at-
        // fallback swap transiently (slippage > 6%, DEX revert, oracle stale
        // at that moment) can still be rescued via internal match in a
        // later block when conditions normalize. The oracle gate below
        // filters out FallbackPending legs whose asset *truly* lost its
        // price feed.
        if (
            s.loans[loanIdA].id == 0 ||
            !_isMatchableStatus(s.loans[loanIdA].status)
        ) revert InternalMatchLoanNotMatchable(loanIdA);
        if (
            s.loans[loanIdB].id == 0 ||
            !_isMatchableStatus(s.loans[loanIdB].status)
        ) revert InternalMatchLoanNotMatchable(loanIdB);

        // Asset opposition — 2-loan symmetric form.
        if (loanIdC == 0) {
            if (
                s.loans[loanIdA].principalAsset != s.loans[loanIdB].collateralAsset ||
                s.loans[loanIdA].collateralAsset != s.loans[loanIdB].principalAsset
            ) {
                revert InternalMatchAssetMismatch(loanIdA, loanIdB);
            }
        } else {
            // 3-loan cycle A→B→C→A.
            if (
                s.loans[loanIdC].id == 0 ||
                !_isMatchableStatus(s.loans[loanIdC].status)
            ) revert InternalMatchLoanNotMatchable(loanIdC);
            if (
                s.loans[loanIdA].principalAsset != s.loans[loanIdB].collateralAsset ||
                s.loans[loanIdB].principalAsset != s.loans[loanIdC].collateralAsset ||
                s.loans[loanIdC].principalAsset != s.loans[loanIdA].collateralAsset
            ) {
                revert InternalMatchChainBroken(loanIdA, loanIdB, loanIdC);
            }
        }

        // Per-leg gates. Active legs go through the LTV-floor check
        // (which requires a fresh oracle reading and reverts if the
        // collateral is illiquid or the loan is below the trigger).
        // FallbackPending legs are by definition past the LTV threshold
        // (they already attempted liquidation) — they only need the
        // oracle to be PRICEABLE so the cross-vault transfer settles
        // at a trustworthy number. EC-003 Phase 1.
        _gateMatchableLeg(loanIdA);
        _gateMatchableLeg(loanIdB);
        if (loanIdC != 0) _gateMatchableLeg(loanIdC);

        // PR5 / PR5.5 execution body. Implements partial-match α from
        // §7 of InternalLiquidationLedger.md: each leg moves
        // `min(debt, opposingCollateral)` of the receiving lender's
        // asset, configured % withheld for `msg.sender` (the matcher),
        // remainder to the lender's vault. Loans whose principal hits
        // zero transition to `LoanStatus.InternalMatched`; partial
        // residuals stay `Active`. PR5.5 extends the 2-way body to
        // 3-loan cycles A→B→C→A — three independent min-match legs.
        if (loanIdC == 0) {
            (
                uint256 movedX,
                uint256 movedY,
                uint256 incentiveX,
                uint256 incentiveY
            ) = _executeTwoWayMatch(loanIdA, loanIdB, msg.sender);
            emit InternalMatchExecuted(
                loanIdA, loanIdB, 0,
                msg.sender,
                movedX, movedY, 0,
                incentiveX, incentiveY, 0
            );
        } else {
            (
                uint256 movedX,
                uint256 movedY,
                uint256 movedZ,
                uint256 incentiveX,
                uint256 incentiveY,
                uint256 incentiveZ
            ) = _executeThreeWayMatch(loanIdA, loanIdB, loanIdC, msg.sender);
            emit InternalMatchExecuted(
                loanIdA, loanIdB, loanIdC,
                msg.sender,
                movedX, movedY, movedZ,
                incentiveX, incentiveY, incentiveZ
            );
        }
    }

    /// @dev Execute the 3-loan chain A→B→C→A version of partial-match α.
    ///      Independent min-match on each leg:
    ///        movedX = min(A.principal, B.collateralAmount)  [B.X → A.lender + matcher]
    ///        movedY = min(B.principal, C.collateralAmount)  [C.Y → B.lender + matcher]
    ///        movedZ = min(C.principal, A.collateralAmount)  [A.Z → C.lender + matcher]
    ///      Each loan whose principal hits zero transitions to
    ///      InternalMatched. Residuals stay Active for the next
    ///      block's matching attempt or external fallback.
    function _executeThreeWayMatch(uint256 loanIdA, uint256 loanIdB, uint256 loanIdC, address matcher)
        private
        returns (
            uint256 movedX,
            uint256 movedY,
            uint256 movedZ,
            uint256 incentiveX,
            uint256 incentiveY,
            uint256 incentiveZ
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage la = s.loans[loanIdA];
        LibVaipakam.Loan storage lb = s.loans[loanIdB];
        LibVaipakam.Loan storage lc = s.loans[loanIdC];

        // EC-007 — per-leg collateral-custody routing (see _settleLeg).
        // Statuses read here are pre-match.
        bool aFromDiamond = la.status == LibVaipakam.LoanStatus.FallbackPending;
        bool bFromDiamond = lb.status == LibVaipakam.LoanStatus.FallbackPending;
        bool cFromDiamond = lc.status == LibVaipakam.LoanStatus.FallbackPending;

        movedX = la.principal < lb.collateralAmount ? la.principal : lb.collateralAmount;
        movedY = lb.principal < lc.collateralAmount ? lb.principal : lc.collateralAmount;
        movedZ = lc.principal < la.collateralAmount ? lc.principal : la.collateralAmount;

        uint256 incentiveBps = LibVaipakam.cfgInternalMatchIncentivePerLegBps();
        incentiveX = (movedX * incentiveBps) / LibVaipakam.BASIS_POINTS;
        incentiveY = (movedY * incentiveBps) / LibVaipakam.BASIS_POINTS;
        incentiveZ = (movedZ * incentiveBps) / LibVaipakam.BASIS_POINTS;

        // #569 §4.4 (2026-06-13) — decrement each ACTIVE leg's lien by
        // the consumed collateral BEFORE its `_settleLeg` vault withdraw
        // (same ordering fix as `_executeTwoWayMatch`). Leg X consumes
        // B's collateral, Leg Y consumes C's, Leg Z consumes A's.
        if (!bFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdB, movedX);
        }
        // Leg X: B's collateral (= A's principal asset) → A.lender + matcher.
        _settleLeg(lb.borrower, la.principalAsset, la.lender, movedX, incentiveX, matcher, bFromDiamond);
        if (!cFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdC, movedY);
        }
        // Leg Y: C's collateral (= B's principal asset) → B.lender + matcher.
        _settleLeg(lc.borrower, lb.principalAsset, lb.lender, movedY, incentiveY, matcher, cFromDiamond);
        if (!aFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdA, movedZ);
        }
        // Leg Z: A's collateral (= C's principal asset) → C.lender + matcher.
        _settleLeg(la.borrower, lc.principalAsset, lc.lender, movedZ, incentiveZ, matcher, aFromDiamond);

        // State updates — each loan's principal cleared by its leg,
        // each borrower's collateral debited by the NEXT loan's leg.
        la.principal -= movedX;
        lb.collateralAmount -= movedX;
        lb.principal -= movedY;
        lc.collateralAmount -= movedY;
        lc.principal -= movedZ;
        la.collateralAmount -= movedZ;

        // EC-003 Phase 1 — collateral consumed per leg:
        //   la consumed movedZ (paid out to C's lender)
        //   lb consumed movedX (paid out to A's lender)
        //   lc consumed movedY (paid out to B's lender)
        _settleFallbackOrTransitionPostMatch(la, movedZ);
        _settleFallbackOrTransitionPostMatch(lb, movedX);
        _settleFallbackOrTransitionPostMatch(lc, movedY);
    }

    /// @dev Settle one leg of an internal match — the receiving
    ///      lender gets `moved - incentive`, the matcher gets
    ///      `incentive`. Extracted helper so the 2-way and 3-way
    ///      bodies share the cross-vault transfer logic without
    ///      duplication.
    ///
    ///      EC-007 — the paying-leg's collateral lives in one of two
    ///      places depending on the loan's status:
    ///        - `Active` leg → collateral is in the borrower's vault;
    ///          withdraw via `vaultWithdrawERC20`.
    ///        - `FallbackPending` leg → collateral was already pulled
    ///          into the Diamond's own balance during the failed
    ///          at-fallback swap; transfer directly with
    ///          `IERC20.safeTransfer` from `address(this)`.
    ///      `fromDiamondCustody` selects the path. This replaced the
    ///      EC-003 Phase 1 "rehydrate the borrower's vault first"
    ///      approach, which scattered a partial-match residual into
    ///      the borrower's vault and broke the lender's later claim
    ///      (the claim path withdraws from the LENDER's vault).
    ///      Settling FallbackPending legs straight from Diamond
    ///      custody keeps the residual in the Diamond, where the
    ///      snapshot-driven claim distribution expects it.
    /// @param matcher Beneficiary of the 1% per-leg incentive. The
    ///        caller MUST pass the genuine matcher explicitly — NOT
    ///        rely on `msg.sender`. On the auto-dispatch path the
    ///        match body runs inside an `onlyDiamondInternal`
    ///        cross-facet call, so `msg.sender` is `address(this)`
    ///        (the Diamond); paying the incentive to `msg.sender`
    ///        there would strand it on the Diamond instead of the
    ///        keeper / lender who triggered settlement.
    function _settleLeg(
        address payingBorrower,
        address asset,
        address receivingLender,
        uint256 moved,
        uint256 incentive,
        address matcher,
        bool fromDiamondCustody
    ) private {
        if (moved == 0) return;
        uint256 lenderShare = moved - incentive;
        address lenderVault = VaultFactoryFacet(address(this))
            .getOrCreateUserVault(receivingLender);
        if (lenderShare > 0) {
            if (fromDiamondCustody) {
                IERC20(asset).safeTransfer(lenderVault, lenderShare);
            } else {
                VaultFactoryFacet(address(this)).vaultWithdrawERC20(
                    payingBorrower, asset, lenderVault, lenderShare
                );
            }
            VaultFactoryFacet(address(this)).recordVaultDepositERC20(
                receivingLender, asset, lenderShare
            );
        }
        if (incentive > 0) {
            // EC-007 custody routing × #21 matcher-recipient fix: pay
            // the incentive to `matcher` (never `msg.sender` — see the
            // @param note), sourced from wherever the collateral sits.
            if (fromDiamondCustody) {
                IERC20(asset).safeTransfer(matcher, incentive);
            } else {
                VaultFactoryFacet(address(this)).vaultWithdrawERC20(
                    payingBorrower, asset, matcher, incentive
                );
            }
        }
    }

    /// @dev Execute the partial-match α swap between two opposing
    ///      loans. Returns the gross moved amounts and the
    ///      bot-incentive amounts in each leg's asset. Splits the
    ///      withdraws into a 99% lender share + 1% matcher share so
    ///      neither party touches the diamond's balance directly.
    ///      Loans whose principal clears transition to
    ///      `InternalMatched`; partial residuals stay `Active`.
    function _executeTwoWayMatch(uint256 loanIdA, uint256 loanIdB, address matcher)
        private
        returns (uint256 movedX, uint256 movedY, uint256 incentiveX, uint256 incentiveY)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage la = s.loans[loanIdA];
        LibVaipakam.Loan storage lb = s.loans[loanIdB];

        // EC-007 — the paying leg's collateral is in the Diamond's
        // custody when that leg is FallbackPending (pulled there during
        // the failed at-fallback swap), or in the borrower's vault when
        // it's Active. `_settleLeg` routes accordingly. Statuses read
        // here are pre-match — they're only mutated below.
        bool aFromDiamond = la.status == LibVaipakam.LoanStatus.FallbackPending;
        bool bFromDiamond = lb.status == LibVaipakam.LoanStatus.FallbackPending;

        // Independent mins on each leg (design §7.1 α): each leg
        // moves the smaller of the receiving lender's owed amount
        // and the paying borrower's available collateral.
        movedX = la.principal < lb.collateralAmount ? la.principal : lb.collateralAmount;
        movedY = lb.principal < la.collateralAmount ? lb.principal : la.collateralAmount;

        uint256 incentiveBps = LibVaipakam.cfgInternalMatchIncentivePerLegBps();
        incentiveX = (movedX * incentiveBps) / LibVaipakam.BASIS_POINTS;
        incentiveY = (movedY * incentiveBps) / LibVaipakam.BASIS_POINTS;

        // #569 §4.4 (2026-06-13) — decrement each ACTIVE leg's lien by
        // the consumed collateral BEFORE its `_settleLeg` vault withdraw,
        // so the chokepoint guard sees the reduced lien and passes.
        // FallbackPending legs (`*FromDiamond`) settle from Diamond
        // custody (no vault withdraw, no guard) and had their lien
        // released at the fallback transition — skip them.
        // Leg X consumes B's collateral (`movedX`); Leg Y consumes A's
        // (`movedY`).
        if (!bFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdB, movedX);
        }
        // Leg X — B's collateral (= A's principal asset) → A.lender + matcher.
        _settleLeg(lb.borrower, la.principalAsset, la.lender, movedX, incentiveX, matcher, bFromDiamond);
        if (!aFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdA, movedY);
        }
        // Leg Y — A's collateral (= B's principal asset) → B.lender + matcher.
        _settleLeg(la.borrower, lb.principalAsset, lb.lender, movedY, incentiveY, matcher, aFromDiamond);

        // State updates — debt cleared by the gross moved amount
        // (borrower forfeits the full amount; the incentive % they
        // "would have paid the lender" is reallocated to the matcher).
        la.principal -= movedX;
        lb.collateralAmount -= movedX;
        lb.principal -= movedY;
        la.collateralAmount -= movedY;

        // Status transitions + snapshot scaling. Full match → loan
        // transitions to `InternalMatched`; partial match keeps the
        // loan in its current status (Active or FallbackPending). The
        // helper folds FallbackPending snapshot reduction into the
        // same exit point as the Active-case transition, so both leg
        // statuses converge on a consistent terminal-or-residual shape.
        _settleFallbackOrTransitionPostMatch(la, movedY);
        _settleFallbackOrTransitionPostMatch(lb, movedX);
    }

    /// @dev Internal helper for `triggerInternalMatchLiquidation` —
    ///      reverts `InternalMatchLtvBelowFloor` when the loan's
    ///      current LTV hasn't reached its snapshotted liquidation
    ///      threshold. Illiquid loans (LTV math reverts) revert
    ///      `IlliquidLoanNoRiskMath` from inside `calculateLTV`.
    function _requireLtvAboveFloor(uint256 loanId) private view {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        uint256 floor = uint256(loan.liquidationLtvBpsAtInit);
        uint256 currentLtv = RiskFacet(address(this)).calculateLTV(loanId);
        if (currentLtv < floor) {
            revert InternalMatchLtvBelowFloor(loanId, currentLtv, floor);
        }
    }

    /// @dev EC-003 Phase 1 — status-aware leg gate. Active legs go through
    ///      the LTV-floor check (which implicitly requires a fresh oracle
    ///      via `calculateLTV`). FallbackPending legs skip the LTV check
    ///      (they're past the threshold by definition — they reached
    ///      FallbackPending only because at-fallback liquidation already
    ///      tried and failed) and instead only need the oracle to be
    ///      priceable for BOTH the principal and collateral assets, since
    ///      internal match settles at oracle price.
    function _gateMatchableLeg(uint256 loanId) private view {
        LibVaipakam.Loan storage loan = LibVaipakam.storageSlot().loans[loanId];
        if (loan.status == LibVaipakam.LoanStatus.FallbackPending) {
            _assertOraclePriceable(loan.principalAsset);
            _assertOraclePriceable(loan.collateralAsset);
            // #577 / #585 — reject a FallbackPending leg that still carries a
            // vault-held AddCollateral top-up, BEFORE any funds move. Settling
            // it would draw the moved collateral from Diamond custody while
            // part of `loan.collateralAmount` sits in the vault, mis-accounting
            // the top-up across the full / partial / zero-residual branches.
            // The top-up-aware unwind lands with #585; until then this is the
            // single pre-settlement eligibility gate for the direct trigger
            // (auto-dispatch checks the same condition and skips instead).
            if (LibVaipakam.hasActiveFallbackTopUp(loanId)) {
                revert InternalMatchFallbackTopUpUnsupported(loanId);
            }
        } else {
            _requireLtvAboveFloor(loanId);
        }
    }

    /// @dev EC-003 Phase 1 — reverts `InternalMatchAssetUnpriceable` when
    ///      the oracle stack can't return a fresh price for `asset`.
    ///      Mirrors the gate `LibFallback.collateralEquivalent` uses for
    ///      the at-fallback equivalent-value path: `tryGetAssetPrice` must
    ///      return `ok=true` and the price must be non-zero. The
    ///      `getAssetPrice` view this delegates to runs the full Soft
    ///      2-of-N secondary quorum on its way back, so quorum disagreement
    ///      surfaces as `ok=false` here.
    function _assertOraclePriceable(address asset) private view {
        (bool ok, uint256 price, ) = OracleFacet(address(this)).tryGetAssetPrice(asset);
        if (!ok || price == 0) revert InternalMatchAssetUnpriceable(asset);
    }

    /// @dev EC-003 Phase 1 — small predicate keeping the status-set
    ///      widening logic in one place so the gate body in
    ///      `triggerInternalMatchLiquidation` stays scannable.
    function _isMatchableStatus(LibVaipakam.LoanStatus status) private pure returns (bool) {
        return status == LibVaipakam.LoanStatus.Active ||
               status == LibVaipakam.LoanStatus.FallbackPending;
    }

    /// @dev #577 — retain an Active full-internal-match RESIDUAL so it's
    ///      retrievable by the current borrower-position NFT holder rather
    ///      than tombstoned + freed. At the call site the loan's debt is
    ///      zero (full match) and `loan.collateralAmount` holds the
    ///      over-collateralization residual, still liened in
    ///      `loan.borrower`'s vault (the pre-withdraw decrement left the
    ///      lien at exactly the residual). Record a `borrowerClaims` row +
    ///      KEEP the lien; `ClaimFacet.claimAsBorrower` (which accepts
    ///      `InternalMatched`) releases the lien atomically at claim and
    ///      routes the residual to the rightful NFT owner — the same
    ///      anti-drain release-at-claim flow proper closes use. An
    ///      exactly-collateralized match (residual 0) tombstones the
    ///      already-zero lien cleanly. ERC-20 collateral only (NFT-rental
    ///      loans never internal-match-liquidate; the lien is ERC-20-gated
    ///      per D-1).
    function _retainInternalMatchResidual(LibVaipakam.Loan storage loan) private {
        if (loan.collateralAmount == 0) {
            LibEncumbrance.releaseCollateralLien(loan.id);
            return;
        }
        LibVaipakam.storageSlot().borrowerClaims[loan.id] = LibVaipakam.ClaimInfo({
            asset: loan.collateralAsset,
            amount: loan.collateralAmount,
            assetType: loan.collateralAssetType,
            tokenId: loan.collateralTokenId,
            quantity: loan.collateralQuantity,
            claimed: false
        });
        // Lien intentionally retained — released inside `claimAsBorrower`.
    }

    /// @dev EC-003 Phase 1 / EC-007 — post-settlement housekeeping for a
    ///      loan whose principal was reduced by an internal match.
    ///      Handles three cases:
    ///        1. Loan was Active and is now fully matched (`principal == 0`)
    ///           → transition Active → InternalMatched (existing B.2 path).
    ///           Active partial matches stay Active — a no-op here.
    ///        2. Loan was FallbackPending and is now fully matched →
    ///           transition FallbackPending → InternalMatched. The lender
    ///           was made whole in principal asset via `_settleLeg`; the
    ///           residual collateral still sits in the Diamond's custody
    ///           (EC-007 — no rehydration), so push it to the borrower's
    ///           vault. Treasury's at-fallback entitlement is forfeited
    ///           (same as Active → InternalMatched — no treasury cut on an
    ///           internal-match rescue). Clear claim records + neutralise
    ///           the snapshot.
    ///        3. Loan was FallbackPending and is still partially open
    ///           (`principal > 0`) → stays FallbackPending. The residual
    ///           collateral REMAINS in the Diamond's custody (EC-007). The
    ///           snapshot stays `active` and describes that residual;
    ///           scale its reference fields + the claim records
    ///           proportionally to the surviving collateral. A later
    ///           match OR claim resolves the residual via the standard
    ///           snapshot-driven path (`_distributeFallbackCollateral`,
    ///           Diamond → vaults) — exactly as a fresh, smaller
    ///           FallbackPending loan would.
    function _settleFallbackOrTransitionPostMatch(
        LibVaipakam.Loan storage loan,
        uint256 collateralConsumed
    ) private {
        LibVaipakam.LoanStatus status = loan.status;

        // Active branch — same shape as the original B.2 code.
        // #569 §4.4 (2026-06-13) — the lien DECREMENT for the consumed
        // collateral now happens BEFORE the `_settleLeg` withdraw in
        // `_executeTwoWayMatch` / `_executeThreeWayMatch` (the chokepoint
        // guard reads the lien at withdraw time, so a post-withdraw
        // decrement reverted every internal match — Codex #571 P1).
        // Here we only tombstone the now-zeroed lien on a full close.
        if (status == LibVaipakam.LoanStatus.Active) {
            if (loan.principal == 0) {
                LibLifecycle.transition(
                    loan,
                    LibVaipakam.LoanStatus.Active,
                    LibVaipakam.LoanStatus.InternalMatched
                );
                // #577 — a full internal-match closes the loan, but an
                // OVER-collateralized loan leaves a residual
                // (`loan.collateralAmount`) still in `loan.borrower`'s
                // vault, liened (the pre-withdraw decrement left the lien
                // at exactly the residual). Retain it as a borrowerClaims
                // row + KEEP the lien instead of tombstoning it — see
                // `_retainInternalMatchResidual`. The earlier code released
                // the lien on the (false) assumption the decrement always
                // zeroed it; for the over-collateralized case that freed
                // the residual with no claim path (stranded, and drainable
                // by a transferred-away `loan.borrower`).
                _retainInternalMatchResidual(loan);
            }
            // Partial internal match — loan stays Active with reduced
            // collateral. The pre-withdraw decrement already adjusted
            // the lien; nothing to do here.
            return;
        }

        // FallbackPending branch.
        if (status == LibVaipakam.LoanStatus.FallbackPending) {
            LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

            // #577 / #585 — defence in depth. Topped-up FallbackPending loans
            // are rejected/skipped at the eligibility gate (`_gateMatchableLeg`
            // for the direct trigger, the skip in `attemptInternalMatchAuto-
            // Dispatch`), so a live (non-released) collateral lien must NOT
            // reach settlement: every branch below — full rescue, zero-residual
            // full rescue, and partial rescue — assumes all of
            // `loan.collateralAmount` is Diamond-held and would mis-account a
            // vault-held top-up otherwise. If one slips through, fail closed
            // (rolls the whole match back atomically) rather than corrupt
            // custody. Unreachable in practice; upholds the gate's invariant.
            if (LibVaipakam.hasActiveFallbackTopUp(loan.id)) {
                revert InternalMatchFallbackTopUpUnsupported(loan.id);
            }

            if (loan.principal == 0) {
                // Full rescue. Lender was made whole in principal asset
                // via `_settleLeg`. The residual collateral
                // (`loan.collateralAmount`) is still in the Diamond's
                // custody — push it to the borrower's vault.
                // Treasury's at-fallback cut is forfeited.
                delete s.lenderClaims[loan.id];
                if (loan.collateralAmount > 0) {
                    // #577 — retain the residual as a drain-protected
                    // borrowerClaims row owed to the current borrower-position
                    // NFT holder (not freely withdrawable by a transferred-away
                    // `loan.borrower`). Topped-up FallbackPending loans are
                    // excluded from internal match upstream (`_gateMatchableLeg`
                    // / auto-dispatch skip) and the defensive guard above has
                    // confirmed no live lien, so the ENTIRE residual is in
                    // Diamond custody here — push it all to the borrower's vault
                    // and lien it. `incrementCollateralLien` is create-if-absent,
                    // seeding a fresh lien on the released at-fallback row.
                    address borrowerVault = VaultFactoryFacet(address(this))
                        .getOrCreateUserVault(loan.borrower);
                    IERC20(loan.collateralAsset).safeTransfer(
                        borrowerVault, loan.collateralAmount
                    );
                    LibVaipakam.recordVaultDeposit(
                        loan.borrower, loan.collateralAsset, loan.collateralAmount
                    );
                    LibEncumbrance.incrementCollateralLien(loan.id, loan.collateralAmount);
                    s.borrowerClaims[loan.id] = LibVaipakam.ClaimInfo({
                        asset: loan.collateralAsset,
                        amount: loan.collateralAmount,
                        assetType: loan.collateralAssetType,
                        tokenId: loan.collateralTokenId,
                        quantity: loan.collateralQuantity,
                        claimed: false
                    });
                } else {
                    delete s.borrowerClaims[loan.id];
                }
                s.fallbackSnapshot[loan.id].active = false;
                LibLifecycle.transitionFromAny(
                    loan,
                    LibVaipakam.LoanStatus.InternalMatched
                );
                return;
            }

            // Partial rescue. Loan stays FallbackPending with reduced
            // principal + collateralAmount. The residual collateral
            // remains in the Diamond's custody (EC-007 — no rehydration),
            // so the snapshot stays `active` and continues to describe
            // it. Scale the snapshot's reference fields + the claim
            // records proportionally to the surviving collateral so a
            // later match or claim sees a self-consistent, smaller
            // FallbackPending loan.
            uint256 oldCollat = loan.collateralAmount + collateralConsumed;
            uint256 newCollat = loan.collateralAmount;
            if (oldCollat == 0 || newCollat >= oldCollat) return;

            LibVaipakam.FallbackSnapshot storage snap = s.fallbackSnapshot[loan.id];
            snap.lenderCollateral = (snap.lenderCollateral * newCollat) / oldCollat;
            snap.treasuryCollateral = (snap.treasuryCollateral * newCollat) / oldCollat;
            snap.borrowerCollateral = (snap.borrowerCollateral * newCollat) / oldCollat;
            snap.lenderPrincipalDue = (snap.lenderPrincipalDue * newCollat) / oldCollat;
            snap.treasuryPrincipalDue = (snap.treasuryPrincipalDue * newCollat) / oldCollat;

            LibVaipakam.ClaimInfo storage lenderClaim = s.lenderClaims[loan.id];
            lenderClaim.amount = snap.lenderCollateral;
            LibVaipakam.ClaimInfo storage borrowerClaim = s.borrowerClaims[loan.id];
            borrowerClaim.amount = snap.borrowerCollateral;
            borrowerClaim.claimed = snap.borrowerCollateral == 0;
        }
    }

    /// @dev EC-003 Phase 3 — auto-dispatch helper. Called from every
    ///      external-liquidation entry-point (`triggerLiquidation`,
    ///      `triggerDefault`, `claimAsLenderWithRetry`) BEFORE the
    ///      external-aggregator path so that any opposing-direction
    ///      internal-match candidate gets settled at oracle price
    ///      (zero aggregator slippage) first.
    ///
    ///      Returns `true` iff the auto-dispatch fired and the
    ///      caller should NOT fall through to the external path.
    ///      Returns `false` when:
    ///        - the kill-switch is off,
    ///        - no opposing candidate exists in the asset-pair index,
    ///        - the candidate fails the per-leg gates (oracle
    ///          priceability + Active-leg LTV-floor) — all already
    ///          filtered by `hasInternalMatchCandidate`.
    ///
    ///      The 1% matcher bonus is paid to `matcher` — which the
    ///      outer entry-point MUST pass as its own `msg.sender`. It
    ///      cannot be derived from `msg.sender` here: this function
    ///      runs inside an `onlyDiamondInternal` cross-facet call, so
    ///      `msg.sender` is `address(this)` (the Diamond). Threading
    ///      the beneficiary explicitly keeps the incentive flowing to
    ///      the keeper / lender who triggered settlement instead of
    ///      stranding it on the Diamond.
    /// @param loanId  The loan being liquidated / claimed.
    /// @param matcher The 1%-per-leg incentive beneficiary — the
    ///        `msg.sender` of the outer `triggerLiquidation` /
    ///        `triggerDefault` / `claimAsLender*` call.
    function attemptInternalMatchAutoDispatch(uint256 loanId, address matcher)
        external
        onlyDiamondInternal
        returns (bool dispatched)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.protocolCfg.internalMatchEnabled) return false;

        (bool found, uint256 candidateId) = MetricsFacet(address(this))
            .hasInternalMatchCandidate(loanId);
        if (!found) return false;

        // #577 / #585 — skip (no dispatch) when either leg is a FallbackPending
        // loan still carrying a vault-held AddCollateral top-up. Settling such
        // a leg mis-accounts the vault top-up against the Diamond-custody draw.
        // Returning false here — rather than letting `_executeTwoWayMatch`
        // revert `InternalMatchFallbackTopUpUnsupported` mid-settlement — keeps
        // auto-dispatch non-fatal: the caller (a claim-time / liquidation /
        // default rescue) falls through to its normal fallback-claim or
        // external-liquidation path instead of bubbling the revert and
        // stranding recovery. The direct trigger rejects the same condition at
        // `_gateMatchableLeg`. (#585 replaces this skip with a real match.)
        if (
            LibVaipakam.hasActiveFallbackTopUp(loanId) ||
            LibVaipakam.hasActiveFallbackTopUp(candidateId)
        ) return false;

        // Settlement. `hasInternalMatchCandidate` has already filtered
        // candidates by status (Active or FallbackPending), oracle
        // priceability (both assets), and — for Active candidates —
        // LTV-floor eligibility. The caller-loan side has been
        // gated by the outer entry-point (HF<1 for triggerLiquidation,
        // time-default conditions for triggerDefault, FallbackPending
        // status for claim-time retry). `_executeTwoWayMatch` runs
        // the partial-match α math + per-leg settlement + post-match
        // snapshot scaling + lifecycle transition.
        (
            uint256 movedX,
            uint256 movedY,
            uint256 incentiveX,
            uint256 incentiveY
        ) = _executeTwoWayMatch(loanId, candidateId, matcher);

        emit InternalMatchExecuted(
            loanId, candidateId, 0,
            matcher,
            movedX, movedY, 0,
            incentiveX, incentiveY, 0
        );
        return true;
    }
}
