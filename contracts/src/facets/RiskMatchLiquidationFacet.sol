// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibFacet} from "../libraries/LibFacet.sol";
import {LibSanctionedLock} from "../libraries/LibSanctionedLock.sol";
import {ConsolidationFacet} from "./ConsolidationFacet.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
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
    // #591 — `InternalMatchFallbackTopUpUnsupported` removed. Topped-up
    // FallbackPending loans are now matchable via the top-up-aware unwind:
    // the match sizes a leg against its Diamond portion only
    // (`_diamondMatchable`) and the vault top-up is returned to the borrower
    // side, so the former eligibility/skip/defence-in-depth gates are gone.
    /// @notice #591 (Codex #605 P1) — a leg has no Diamond-matchable collateral
    ///         (`LibVaipakam.internalMatchableCollateral == 0`): either a zero-
    ///         collateral loan, or a topped-up FallbackPending loan whose
    ///         at-fallback Diamond snapshot was fully consumed by an earlier
    ///         partial match (only the vault top-up remains, which never
    ///         participates in a match). Such a leg has nothing to contribute,
    ///         so it is non-matchable — matching it would hand the counterparty's
    ///         collateral to this loan's lender with no reciprocal debt
    ///         reduction. Rejected at the eligibility gate; the executors also
    ///         fail closed if any leg's `moved` amount is zero.
    error InternalMatchNoMatchableCollateral(uint256 loanId);

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
            MatchResult memory r = _executeTwoWayMatch(loanIdA, loanIdB, msg.sender);
            emit InternalMatchExecuted(
                loanIdA, loanIdB, 0,
                msg.sender,
                r.movedX, r.movedY, 0,
                r.incentiveX, r.incentiveY, 0
            );
        } else {
            MatchResult memory r =
                _executeThreeWayMatch(loanIdA, loanIdB, loanIdC, msg.sender);
            emit InternalMatchExecuted(
                loanIdA, loanIdB, loanIdC,
                msg.sender,
                r.movedX, r.movedY, r.movedZ,
                r.incentiveX, r.incentiveY, r.incentiveZ
            );
        }
    }

    /// @dev #591 — collateral eligible for the internal-match draw on this
    ///      leg. For a topped-up `FallbackPending` leg (one carrying an
    ///      active, non-released AddCollateral lien), only the Diamond-held
    ///      portion (`snapshotTotal == collateralAmount − lien.amount`) may
    ///      be matched — the vault-held top-up does not participate (it's
    ///      returned to the borrower side, see
    ///      `_settleFallbackOrTransitionPostMatch`). Drawing the full
    ///      `collateralAmount` from Diamond custody would over-draw, taking
    ///      same-token collateral belonging to OTHER fallback loans. For
    ///      every other leg (Active, or FallbackPending without a top-up)
    ///      the matchable size is the full `collateralAmount` — unchanged.
    function _diamondMatchable(LibVaipakam.Loan storage loan) private view returns (uint256) {
        // Single source of truth (shared with MetricsFacet's candidate scan).
        return LibVaipakam.internalMatchableCollateral(loan.id);
    }

    /// @dev #691 — lean MEMORY return for the per-leg moved/incentive amounts.
    ///      The 2-way and 3-way executors are single-/few-call private functions
    ///      that viaIR inlines into their orchestrators; returning the six values
    ///      as a stack tuple put `_executeThreeWayMatch` at the EXACT whole-unit
    ///      per-function stack ceiling (any further local — e.g. the #658
    ///      consolidation hook — overflowed it). Holding them in a memory struct
    ///      keeps them off the stack at the inline boundary AND lets the executor
    ///      write each field as computed (never all six live on the stack at
    ///      once), which freed the headroom the consolidation + restamp hooks
    ///      need. 2-way leaves `movedZ`/`incentiveZ` zero.
    struct MatchResult {
        uint256 movedX;
        uint256 movedY;
        uint256 movedZ;
        uint256 incentiveX;
        uint256 incentiveY;
        uint256 incentiveZ;
    }

    /// @dev #691 / #658 — single-copy cross-facet bridges to the eager
    ///      consolidation entries. RiskMatchLiquidationFacet is size-tight, so
    ///      the multi-loan internal match re-anchors each participating loan to
    ///      its current NFT holder via a few-byte cross-facet call (one body
    ///      each, compiled once). Both-side eager consolidation BEFORE settlement
    ///      re-anchors every leg's borrower/lender to the live holder so the
    ///      collateral lien + reward entry + VPFI checkpoint follow it; the
    ///      post-withdraw restamp keeps VPFI tier/staking honest after a leg's
    ///      collateral leaves the vault. Tier2 skip-not-block; FallbackPending
    ///      legs are a benign no-op (collateral already in Diamond custody, and
    ///      `consolidateToHolder` excludes them). Proceeds were already
    ///      current-holder-safe via #585 `lenderClaims` + `claimAsBorrower`;
    ///      this closes the position-effect-accounting gap (#680 F3).
    ///
    ///      NOTE (Codex #693): unlike preclose/refinance, the internal-match
    ///      executors do NOT clear active prepay / parallel-sale listings before
    ///      consolidating — by construction they can't have one. Every listing
    ///      writer requires ERC721/ERC1155 collateral (the four `NFTPrepay*`
    ///      facets revert `UnsupportedCollateralForV1`; `OfferParallelSaleFacet`
    ///      reverts `UnsupportedCollateralForParallelSale`), but an internal-
    ///      match leg requires ORACLE-PRICEABLE collateral — Active legs through
    ///      `_requireLtvAboveFloor`→`calculateLTV` (reverts on illiquid/NFT) and
    ///      FallbackPending legs through `_assertOraclePriceable(collateralAsset)`.
    ///      So an internal-match leg's `prepayListingOrderHash` /
    ///      `offerPrepayListingOrderHash` is always 0 and `_isExcludedLive`'s
    ///      listing branch can never fire here.
    function _eagerBothSidesIM(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.eagerConsolidateBothSides.selector,
                loanId
            ),
            bytes4(0)
        );
    }

    function _restampCollIM(uint256 loanId) private {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                ConsolidationFacet.restampCollateralVpfiAfterWithdraw.selector,
                loanId
            ),
            bytes4(0)
        );
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
        returns (MatchResult memory r)
    {
        // #691 / #658 (#680 F3) — consolidate ALL THREE participating loans to
        // their current NFT holders while still Active (before settlement), so
        // each leg's borrower/lender position effects (lien, reward, VPFI
        // checkpoint) follow the live holder. Done here (not the orchestrator)
        // because the single-caller 3-way executor is inlined; the lean
        // MatchResult memory return above buys the stack headroom for it.
        _eagerBothSidesIM(loanIdA);
        _eagerBothSidesIM(loanIdB);
        _eagerBothSidesIM(loanIdC);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Loan storage la = s.loans[loanIdA];
        LibVaipakam.Loan storage lb = s.loans[loanIdB];
        LibVaipakam.Loan storage lc = s.loans[loanIdC];

        // EC-007 — per-leg collateral-custody routing (see _settleLeg).
        // Statuses read here are pre-match.
        bool aFromDiamond = la.status == LibVaipakam.LoanStatus.FallbackPending;
        bool bFromDiamond = lb.status == LibVaipakam.LoanStatus.FallbackPending;
        bool cFromDiamond = lc.status == LibVaipakam.LoanStatus.FallbackPending;

        // #591 — size each leg's contribution against the MATCHABLE
        // collateral (`_diamondMatchable`), not the raw `collateralAmount`.
        // For a topped-up FallbackPending paying leg that is the Diamond
        // portion only, so the draw never over-runs Diamond custody.
        {
            uint256 matchableB = _diamondMatchable(lb);
            uint256 matchableC = _diamondMatchable(lc);
            uint256 matchableA = _diamondMatchable(la);
            r.movedX = la.principal < matchableB ? la.principal : matchableB;
            r.movedY = lb.principal < matchableC ? lb.principal : matchableC;
            r.movedZ = lc.principal < matchableA ? lc.principal : matchableA;
        }

        // #591 (Codex #605 P1) — fail closed if any leg moves zero (see the
        // 2-way executor for the rationale): a zero leg in the A→B→C→A chain
        // means an exhausted/empty leg slipped the eligibility gate and would
        // settle a one-sided transfer draining a counterparty.
        if (r.movedX == 0) revert InternalMatchNoMatchableCollateral(lb.id);
        if (r.movedY == 0) revert InternalMatchNoMatchableCollateral(lc.id);
        if (r.movedZ == 0) revert InternalMatchNoMatchableCollateral(la.id);

        {
            uint256 incentiveBps = LibVaipakam.cfgInternalMatchIncentivePerLegBps();
            // #817 — see `_executeTwoWayMatch`: a sanctioned matcher (auto-dispatch
            // only) gets a zeroed incentive, folded into each lender's share, so
            // the match still settles and no value reaches the flagged wallet.
            if (LibVaipakam.isSanctionedAddress(matcher)) incentiveBps = 0;
            r.incentiveX = (r.movedX * incentiveBps) / LibVaipakam.BASIS_POINTS;
            r.incentiveY = (r.movedY * incentiveBps) / LibVaipakam.BASIS_POINTS;
            r.incentiveZ = (r.movedZ * incentiveBps) / LibVaipakam.BASIS_POINTS;
        }

        // #569 §4.4 (2026-06-13) — decrement each ACTIVE leg's lien by
        // the consumed collateral BEFORE its `_settleLeg` vault withdraw
        // (same ordering fix as `_executeTwoWayMatch`). Leg X consumes
        // B's collateral, Leg Y consumes C's, Leg Z consumes A's.
        if (!bFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdB, r.movedX);
        }
        // Leg X: B's collateral (= A's principal asset) → A.lender + matcher.
        _settleLeg(loanIdA, lb.borrower, la.principalAsset, la.lender, r.movedX, r.incentiveX, matcher, bFromDiamond);
        if (!cFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdC, r.movedY);
        }
        // Leg Y: C's collateral (= B's principal asset) → B.lender + matcher.
        _settleLeg(loanIdB, lc.borrower, lb.principalAsset, lb.lender, r.movedY, r.incentiveY, matcher, cFromDiamond);
        if (!aFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdA, r.movedZ);
        }
        // Leg Z: A's collateral (= C's principal asset) → C.lender + matcher.
        _settleLeg(loanIdC, la.borrower, lc.principalAsset, lc.lender, r.movedZ, r.incentiveZ, matcher, aFromDiamond);

        // State updates — each loan's principal cleared by its leg,
        // each borrower's collateral debited by the NEXT loan's leg.
        la.principal -= r.movedX;
        lb.collateralAmount -= r.movedX;
        lb.principal -= r.movedY;
        lc.collateralAmount -= r.movedY;
        lc.principal -= r.movedZ;
        la.collateralAmount -= r.movedZ;

        // EC-003 Phase 1 — collateral consumed per leg:
        //   la consumed movedZ (paid out to C's lender)
        //   lb consumed movedX (paid out to A's lender)
        //   lc consumed movedY (paid out to B's lender)
        // #585 — lender proceeds per leg (the asymmetry: a loan's collateral
        // is consumed by the NEXT leg, but its OWN lender is paid by its own
        // leg). A.lender ← Leg X (movedX − incentiveX); B.lender ← Leg Y;
        // C.lender ← Leg Z.
        _settleFallbackOrTransitionPostMatch(la, r.movedZ, r.movedX - r.incentiveX);
        _settleFallbackOrTransitionPostMatch(lb, r.movedX, r.movedY - r.incentiveY);
        _settleFallbackOrTransitionPostMatch(lc, r.movedY, r.movedZ - r.incentiveZ);

        // #691 / #658 — each leg's collateral was withdrawn for the swap;
        // restamp each holder's VPFI tier/staking (no-op for non-VPFI). Keyed
        // off the live `la/lb/lc` storage pointers (`.id`) rather than the
        // `loanId*` params so those params' live range ends at the lien
        // decrements above — keeping the deep tail of this viaIR
        // stack-ceiling executor under the limit.
        _restampCollIM(la.id);
        _restampCollIM(lb.id);
        _restampCollIM(lc.id);
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
        uint256 loanId,
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
        // #821 (Codex #832 P1) — resolve the receiving (stored) lender's vault
        // under the receive-side sanctions exemption so a lender flagged after
        // loan-init doesn't BRICK the internal-match settlement. The share is
        // still frozen (the claim-side stored-owner gate in `ClaimFacet`), and a
        // `SanctionedProceedsLocked` event is emitted when the lender is flagged.
        address lenderVault = LibSanctionedLock.getOrCreateVaultLocked(
            LibVaipakam.storageSlot(), receivingLender, loanId, asset, lenderShare
        );
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
        returns (MatchResult memory r)
    {
        // #691 / #658 (#680 F3) — consolidate BOTH participating loans to their
        // current NFT holders while still Active (before settlement), so each
        // leg's borrower/lender position effects follow the live holder. Covers
        // both the explicit 2-way trigger and the auto-dispatch path (the
        // triggering loan is idempotently re-consolidated; the matched CANDIDATE
        // is consolidated here). The lean MatchResult memory return buys the
        // stack headroom.
        _eagerBothSidesIM(loanIdA);
        _eagerBothSidesIM(loanIdB);

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
        // #591 — size each leg against the MATCHABLE collateral
        // (`_diamondMatchable`): for a topped-up FallbackPending paying leg
        // that's the Diamond portion only, so the draw can never over-run
        // Diamond custody. Unchanged (= full `collateralAmount`) for all
        // other legs.
        {
            uint256 matchableB = _diamondMatchable(lb);
            uint256 matchableA = _diamondMatchable(la);
            r.movedX = la.principal < matchableB ? la.principal : matchableB;
            r.movedY = lb.principal < matchableA ? lb.principal : matchableA;
        }

        // #591 (Codex #605 P1) — fail closed if either leg moves zero. A
        // legitimate mutual match always moves >0 on both legs (both have
        // outstanding principal AND matchable collateral); a zero leg means an
        // exhausted/empty leg slipped past the eligibility gate, which would
        // settle a one-sided transfer (counterparty collateral → this lender
        // with no reciprocal debt reduction). Roll back rather than drain.
        if (r.movedX == 0) revert InternalMatchNoMatchableCollateral(la.id);
        if (r.movedY == 0) revert InternalMatchNoMatchableCollateral(lb.id);

        {
            uint256 incentiveBps = LibVaipakam.cfgInternalMatchIncentivePerLegBps();
            // #817 — deny the matcher bonus to a sanctioned caller (only reachable
            // on the auto-dispatch path; the explicit entry reverts a sanctioned
            // `msg.sender`). Zeroing the incentive folds it into each lender's
            // share, so the objective match still settles with no DEX risk, the
            // honest counterparty is made fully whole, and no fresh value reaches
            // the flagged wallet.
            if (LibVaipakam.isSanctionedAddress(matcher)) incentiveBps = 0;
            r.incentiveX = (r.movedX * incentiveBps) / LibVaipakam.BASIS_POINTS;
            r.incentiveY = (r.movedY * incentiveBps) / LibVaipakam.BASIS_POINTS;
        }

        // #569 §4.4 (2026-06-13) — decrement each ACTIVE leg's lien by
        // the consumed collateral BEFORE its `_settleLeg` vault withdraw,
        // so the chokepoint guard sees the reduced lien and passes.
        // FallbackPending legs (`*FromDiamond`) settle from Diamond
        // custody (no vault withdraw, no guard) and had their lien
        // released at the fallback transition — skip them.
        // Leg X consumes B's collateral (`movedX`); Leg Y consumes A's
        // (`movedY`).
        if (!bFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdB, r.movedX);
        }
        // Leg X — B's collateral (= A's principal asset) → A.lender + matcher.
        _settleLeg(loanIdA, lb.borrower, la.principalAsset, la.lender, r.movedX, r.incentiveX, matcher, bFromDiamond);
        if (!aFromDiamond) {
            LibEncumbrance.decrementCollateralLien(loanIdA, r.movedY);
        }
        // Leg Y — A's collateral (= B's principal asset) → B.lender + matcher.
        _settleLeg(loanIdB, la.borrower, lb.principalAsset, lb.lender, r.movedY, r.incentiveY, matcher, aFromDiamond);

        // State updates — debt cleared by the gross moved amount
        // (borrower forfeits the full amount; the incentive % they
        // "would have paid the lender" is reallocated to the matcher).
        la.principal -= r.movedX;
        lb.collateralAmount -= r.movedX;
        lb.principal -= r.movedY;
        la.collateralAmount -= r.movedY;

        // Status transitions + snapshot scaling. Full match → loan
        // transitions to `InternalMatched`; partial match keeps the
        // loan in its current status (Active or FallbackPending). The
        // helper folds FallbackPending snapshot reduction into the
        // same exit point as the Active-case transition, so both leg
        // statuses converge on a consistent terminal-or-residual shape.
        // #585 — lender proceeds per leg (asymmetric, as in the 3-way case):
        // la's collateral is consumed by Leg Y (movedY), but A.lender is paid
        // by Leg X (movedX − incentiveX); symmetrically for lb.
        _settleFallbackOrTransitionPostMatch(la, r.movedY, r.movedX - r.incentiveX);
        _settleFallbackOrTransitionPostMatch(lb, r.movedX, r.movedY - r.incentiveY);

        // #691 / #658 — both legs' collateral was withdrawn for the swap;
        // restamp each holder's VPFI tier/staking (no-op for non-VPFI). Keyed
        // off `la/lb` (`.id`) so the `loanId*` params' live range ends at the
        // lien decrements above (viaIR stack headroom).
        _restampCollIM(la.id);
        _restampCollIM(lb.id);
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
            // #591 — a topped-up FallbackPending leg is no longer excluded.
            // The match sizes its contribution against the Diamond portion
            // only (`_diamondMatchable`) and `_settleFallbackOrTransition-
            // PostMatch` returns the vault top-up to the borrower side, so
            // the draw stays bounded by Diamond custody.
            //
            // #591 (Codex #605 P1) — but a leg whose Diamond portion is fully
            // exhausted (top-up consumed the snapshot in an earlier partial
            // match; only the vault top-up remains) has NOTHING to match. Reject
            // it before any funds move — otherwise it would receive a one-sided
            // match draining the counterparty. (Active legs always have
            // matchable == collateralAmount, so this only bites exhausted
            // topped-up FallbackPending legs.)
            if (LibVaipakam.internalMatchableCollateral(loanId) == 0) {
                revert InternalMatchNoMatchableCollateral(loanId);
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
    /// @param lenderProceeds The principal-asset amount (`moved - incentive`)
    ///        this loan's lender was paid into `loan.lender`'s vault by
    ///        `_settleLeg`. On a FULL match it is recorded as a
    ///        `lenderClaims` row (#585) so the CURRENT lender-position-NFT
    ///        holder — not the stored `loan.lender` — claims it through the
    ///        standard lender-claim path. Ignored on a partial match
    ///        (the loan stays open; the lender claim is still the snapshot
    ///        residual, scaled below).
    function _settleFallbackOrTransitionPostMatch(
        LibVaipakam.Loan storage loan,
        uint256 collateralConsumed,
        uint256 lenderProceeds
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
                // #585 (Codex round-3 P1) — an internal match is a
                // LIQUIDATION-class terminal for the borrower (their
                // distressed loan was force-cleared), so forfeit the
                // borrower's VPFI Loan-Initiation-Fee custody to treasury
                // here — exactly as DefaultedFacet / RiskFacet do at their
                // liquidation terminals. Without this the Diamond-held
                // `borrowerLifRebate[loanId].vpfiHeld` would be stranded once
                // the loan settles (claimAsBorrower rejects a Settled loan).
                // Idempotent / no-op when the borrower paid no VPFI LIF.
                LibVPFIDiscount.forfeitBorrowerLif(loan);
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
                // #585 — the lender's matched proceeds were deposited into
                // `loan.lender`'s vault by `_settleLeg` but, on a full
                // close, no claim row existed: a transferred-away lender
                // position could not extract them (and the stored lender
                // can't either — protocol-tracked balances have no
                // user-facing withdraw), stranding the funds and leaving
                // the loan stuck `InternalMatched`. Record the proceeds as
                // a standard lender claim so the CURRENT lender-position-NFT
                // holder claims them via `claimAsLender` (NFT-owner-gated,
                // sanctions-checked), which also burns the lender NFT and
                // settles the loan once the borrower side clears.
                LibVaipakam.storageSlot().lenderClaims[loan.id] = LibVaipakam.ClaimInfo({
                    asset: loan.principalAsset,
                    amount: lenderProceeds,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    claimed: false
                });
                // #585 — if the proceeds are VPFI, reserve them against the
                // unstake path (`withdrawVPFIFromVault`) so the stored
                // lender can't front-run the holder's claim. Released in
                // `ClaimFacet._claimAsLenderImpl` just before the payout.
                if (loan.principalAsset == LibVaipakam.storageSlot().vpfiToken) {
                    LibEncumbrance.encumberLenderProceeds(
                        loan.id, loan.lender, loan.principalAsset, lenderProceeds
                    );
                }
            } else if (lenderProceeds > 0) {
                // #585 P1 (Codex round-2) — PARTIAL internal match: the loan
                // stays Active with reduced principal, but `_settleLeg`
                // already paid THIS leg's proceeds into the lender's vault.
                // Accumulate them into `heldForLender` so the eventual
                // terminal claim (a later full match, repay, or default)
                // pays the CURRENT lender-position holder the SUM of every
                // partial leg — not just the final one. The full-match
                // branch above records only the FINAL leg in `lenderClaims`;
                // `heldForLender` carries the priors and survives a later
                // RepayFacet `lenderClaims` overwrite because `claimAsLender`
                // pays `lenderClaims + heldForLender`. (Per-loan
                // `heldForLender` is the same accumulator Preclose uses; the
                // adds compose.)
                LibVaipakam.Storage storage sa = LibVaipakam.storageSlot();
                sa.heldForLender[loan.id] += lenderProceeds;
                if (loan.principalAsset == sa.vpfiToken) {
                    LibEncumbrance.encumberLenderProceeds(
                        loan.id, loan.lender, loan.principalAsset, lenderProceeds
                    );
                }
            }
            return;
        }

        // FallbackPending branch.
        if (status == LibVaipakam.LoanStatus.FallbackPending) {
            LibVaipakam.Storage storage s = LibVaipakam.storageSlot();

            // #591 — top-up-aware split. A topped-up FallbackPending loan's
            // collateral is split between the Diamond (the at-fallback
            // snapshot) and `loan.borrower`'s vault (the AddCollateral
            // top-up, held under an active lien `s.loanCollateralLien[id]`).
            // The match only ever consumed from the Diamond portion (sized by
            // `_diamondMatchable`), so:
            //   topUp        = the still-liened vault top-up (0 if none).
            //   diamondAfter = the Diamond residual remaining AFTER this
            //                  match's `collateralAmount` decrement
            //                  (== snapshotTotal_before − collateralConsumed).
            // `loan.collateralAmount` already reflects the decrement and
            // equals `diamondAfter + topUp`.
            uint256 topUp = LibVaipakam.hasActiveFallbackTopUp(loan.id)
                ? s.loanCollateralLien[loan.id].amount
                : 0;
            uint256 diamondAfter = loan.collateralAmount - topUp;

            if (loan.principal == 0) {
                // Full rescue. Lender was made whole in principal asset
                // via `_settleLeg`. The Diamond residual (`diamondAfter`) is
                // still in the Diamond's custody — push it to the borrower's
                // vault; any vault-held top-up already sits there (#591).
                // Treasury's at-fallback cut is forfeited.
                //
                // #585 — record the matched proceeds as a lender claim
                // (REPLACING the prior `delete`, which left a transferred
                // lender position with no way to extract the funds
                // `_settleLeg` deposited into `loan.lender`'s vault). This
                // overwrites any stale at-fallback snapshot lender claim
                // with the match proceeds owed to the current holder.
                s.lenderClaims[loan.id] = LibVaipakam.ClaimInfo({
                    asset: loan.principalAsset,
                    amount: lenderProceeds,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    claimed: false
                });
                // #585 — VPFI proceeds reservation (see the Active branch).
                if (loan.principalAsset == s.vpfiToken) {
                    LibEncumbrance.encumberLenderProceeds(
                        loan.id, loan.lender, loan.principalAsset, lenderProceeds
                    );
                }
                if (loan.collateralAmount > 0) {
                    // #577 / #591 — retain the residual as a drain-protected
                    // borrowerClaims row owed to the current borrower-position
                    // NFT holder (not freely withdrawable by a transferred-away
                    // `loan.borrower`).
                    //
                    // The residual is `diamondAfter + topUp`:
                    //   - `diamondAfter` is still in Diamond custody — push it
                    //     to the borrower's vault and ADD it to the lien.
                    //   - `topUp` is ALREADY in the borrower's vault under the
                    //     existing active lien — leave it in place; do NOT
                    //     transfer it (it never moved to the Diamond) and do
                    //     NOT re-lien it (it's already liened).
                    // Incrementing the lien by `diamondAfter` makes the lien
                    // cover the WHOLE residual (`diamondAfter + topUp ==
                    // loan.collateralAmount`); `claimAsBorrower` releases it
                    // and routes the residual to the rightful NFT owner.
                    // `incrementCollateralLien` is create-if-absent (seeds a
                    // fresh lien on the released at-fallback row when no
                    // top-up exists, i.e. `topUp == 0`).
                    if (diamondAfter > 0) {
                        address borrowerVault = VaultFactoryFacet(address(this))
                            .getOrCreateUserVault(loan.borrower);
                        IERC20(loan.collateralAsset).safeTransfer(
                            borrowerVault, diamondAfter
                        );
                        LibVaipakam.recordVaultDeposit(
                            loan.borrower, loan.collateralAsset, diamondAfter
                        );
                        LibEncumbrance.incrementCollateralLien(loan.id, diamondAfter);
                    }
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
                // #585 (Codex round-3 P1) — liquidation-class terminal:
                // forfeit the borrower VPFI LIF custody to treasury (see the
                // Active full-match branch). No-op when none was paid.
                LibVPFIDiscount.forfeitBorrowerLif(loan);
                LibLifecycle.transitionFromAny(
                    loan,
                    LibVaipakam.LoanStatus.InternalMatched
                );
                return;
            }

            // #585 P1 (Codex round-2) — a PARTIAL fallback rescue paid THIS
            // leg's matched proceeds (principal asset) into the lender's
            // vault via `_settleLeg`. The scaled snapshot below tracks only
            // the REMAINING collateral residual, so accumulate the matched
            // proceeds into `heldForLender` (the priors-carrier) — the
            // eventual terminal claim then pays the current lender holder
            // BOTH the matched principal and the residual. See the Active
            // partial branch.
            if (lenderProceeds > 0) {
                s.heldForLender[loan.id] += lenderProceeds;
                if (loan.principalAsset == s.vpfiToken) {
                    LibEncumbrance.encumberLenderProceeds(
                        loan.id, loan.lender, loan.principalAsset, lenderProceeds
                    );
                }
            }

            // Partial rescue. Loan stays FallbackPending with reduced
            // principal + collateralAmount. The residual collateral
            // remains in the Diamond's custody (EC-007 — no rehydration),
            // so the snapshot stays `active` and continues to describe
            // it. Scale the snapshot's reference fields + the claim
            // records proportionally to the surviving collateral so a
            // later match or claim sees a self-consistent, smaller
            // FallbackPending loan.
            //
            // #591 — the snapshot describes ONLY the Diamond-held portion
            // (the at-fallback collateral); the vault top-up is tracked
            // separately by the lien and is owed to the borrower untouched.
            // So scale by the consumed fraction of the DIAMOND base, not of
            // `loan.collateralAmount` (which includes the top-up):
            //   newCollat = diamondAfter                       (Diamond residual after)
            //   oldCollat = diamondAfter + collateralConsumed  (Diamond residual before)
            // The top-up lien is left UNTOUCHED below.
            uint256 oldCollat = diamondAfter + collateralConsumed;
            uint256 newCollat = diamondAfter;

            // #591 (Codex #605 round-2 P1) — if THIS partial match consumed the
            // ENTIRE Diamond portion (`diamondAfter == 0`) while a vault top-up
            // is still live, the fallback's liquidatable collateral is fully
            // gone and only the borrower's top-up remains. The Diamond-based
            // fallback claim path can't return a vault-held amount, so scaling
            // the snapshot to 0 would strand the top-up. Resolve TERMINALLY,
            // reusing the proven full-rescue mechanism: record the top-up as a
            // drain-protected `borrowerClaims` (paid from the borrower vault to
            // the CURRENT position holder by `claimAsBorrower`, which releases
            // the lien), clear the snapshot, forfeit the borrower LIF, and
            // transition to InternalMatched. The matched proceeds are already in
            // `heldForLender` (above); the remaining principal is written off as
            // the lender's fallback shortfall — the liquidatable collateral is
            // exhausted, so nothing more is recoverable. (`topUp == 0` keeps the
            // pre-existing non-topped-up behaviour: fall through and scale to 0.)
            if (diamondAfter == 0 && topUp > 0) {
                s.borrowerClaims[loan.id] = LibVaipakam.ClaimInfo({
                    asset: loan.collateralAsset,
                    amount: topUp,
                    assetType: LibVaipakam.AssetType.ERC20,
                    tokenId: 0,
                    quantity: 0,
                    claimed: false
                });
                // The matched proceeds already exited; the lender's residual
                // collateral claim is zero (Diamond consumed).
                s.lenderClaims[loan.id].amount = 0;
                loan.principal = 0; // fallback shortfall written off — loan terminal.
                s.fallbackSnapshot[loan.id].active = false;
                LibVPFIDiscount.forfeitBorrowerLif(loan);
                LibLifecycle.transitionFromAny(
                    loan, LibVaipakam.LoanStatus.InternalMatched
                );
                return;
            }

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

        // #817 — a sanctioned matcher does NOT skip the dispatch (that would let
        // a flagged caller degrade settlement: an empty/failing `adapterCalls`
        // on the fall-through external path could push an internally-matchable
        // loan into FallbackPending). Instead the objective internal match still
        // runs and the 1% bonus is denied to the flagged matcher inside
        // `_executeTwoWayMatch` (the incentive is zeroed, folding it into the
        // honest lender's share). See the `isSanctionedAddress(matcher)` guard
        // there. The explicit `triggerInternalMatchLiquidation` entry still
        // reverts a sanctioned `msg.sender` (the caller chose that path purely
        // to earn the incentive); only this auto-dispatch path keeps going.

        (bool found, uint256 candidateId) = MetricsFacet(address(this))
            .hasInternalMatchCandidate(loanId);
        if (!found) return false;

        // #591 — topped-up FallbackPending legs are no longer skipped here.
        // `_executeTwoWayMatch` sizes each leg against the Diamond portion
        // only (`_diamondMatchable`) and the post-match settlement returns
        // the vault top-up to the borrower side, so the auto-dispatch match
        // is now safe for topped-up legs on either side.
        //
        // #591 (Codex #605 P1) — but skip (non-fatally) if THIS loan's Diamond
        // portion is exhausted (topped-up FallbackPending whose snapshot a
        // prior partial match consumed; only the vault top-up remains). It has
        // nothing to contribute, so a match would be one-sided. The candidate
        // side is already filtered for the same condition by
        // `hasInternalMatchCandidate`. Returning false lets the caller fall
        // through to its normal fallback-claim / external path.
        if (LibVaipakam.internalMatchableCollateral(loanId) == 0) return false;

        // Settlement. `hasInternalMatchCandidate` has already filtered
        // candidates by status (Active or FallbackPending), oracle
        // priceability (both assets), and — for Active candidates —
        // LTV-floor eligibility. The caller-loan side has been
        // gated by the outer entry-point (HF<1 for triggerLiquidation,
        // time-default conditions for triggerDefault, FallbackPending
        // status for claim-time retry). `_executeTwoWayMatch` runs
        // the partial-match α math + per-leg settlement + post-match
        // snapshot scaling + lifecycle transition.
        MatchResult memory r = _executeTwoWayMatch(loanId, candidateId, matcher);

        emit InternalMatchExecuted(
            loanId, candidateId, 0,
            matcher,
            r.movedX, r.movedY, 0,
            r.incentiveX, r.incentiveY, 0
        );
        return true;
    }
}
