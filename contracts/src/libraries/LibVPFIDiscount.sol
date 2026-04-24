// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibStakingRewards} from "./LibStakingRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {EscrowFactoryFacet} from "../facets/EscrowFactoryFacet.sol";

/**
 * @title LibVPFIDiscount
 * @author Vaipakam Developer Team
 * @notice Shared quote / apply helpers for both VPFI fee discount paths
 *         (docs/TokenomicsTechSpec.md §6):
 *           - Borrower Loan Initiation Fee discount (normal 0.1%)
 *           - Lender Yield Fee discount             (normal 1%)
 *         Both paths share the same tier-by-escrow-balance gate and the
 *         same platform-level consent flag `s.vpfiDiscountConsent[user]`.
 * @dev Tier semantics (`LibVaipakam` constants):
 *
 *        Tier | Escrow VPFI range              | Discount
 *          0  | x < 100                        |   0%  (no discount)
 *          1  | 100    ≤ x < 1,000             |  10%
 *          2  | 1,000  ≤ x < 5,000             |  15%
 *          3  | 5,000  ≤ x ≤ 20,000            |  20%  (20k inclusive)
 *          4  |          x > 20,000            |  24%
 *
 *      Tier resolution is a pure VPFI balance check — no Chainlink
 *      dependency — so the tier gate is deterministic and cheap.
 *
 *      The tier-adjusted fee is still paid IN VPFI out of the user's escrow
 *      (spec: "the system should automatically deduct the required VPFI
 *      amount from escrow to Treasury"). That conversion still uses
 *      Chainlink USD feeds:
 *
 *        normalFeeInAsset      = feeBase × normalFeeBps / BASIS_POINTS
 *        payBps                = BASIS_POINTS − tierDiscountBps
 *        tierFeeInAsset        = normalFeeInAsset × payBps / BASIS_POINTS
 *        tierFeeUSD            = tierFeeInAsset × price(feeAsset)
 *        tierFeeWei            = tierFeeUSD × 1e(ethDecimals) / price(ETH)
 *        vpfiRequired          = tierFeeWei × 1e18 / weiPerVpfi
 *
 *      Every Chainlink or config input can be unavailable (no feed, stale
 *      feed, unregistered asset, missing ETH reference, zero rate). On any
 *      failure the quote returns `(false, 0, 0)` and the mutating path
 *      falls back silently to the normal non-discounted fee — this matches
 *      the spec's silent-fallback rule.
 *
 *      Library functions execute in the caller facet's context under the
 *      diamond's `delegatecall`, so `address(this)` resolves to the diamond.
 */
library LibVPFIDiscount {
    // ─── Tier helpers ────────────────────────────────────────────────────────

    /**
     * @notice Resolve the VPFI discount tier for a given escrow balance.
     * @dev `view`, not `pure`: tier thresholds are now admin-configurable
     *      through {ConfigFacet} and resolved via
     *      {LibVaipakam.cfgVpfiTierThresholds}. Defaults (100 / 1k / 5k /
     *      20k) apply when no override is set. The T3/T4 split remains
     *      strict: exactly the T4 threshold is T3, not T4.
     * @param escrowBal The user's escrow VPFI balance (18 decimals).
     * @return tier 0..4 — 0 means no discount.
     */
    function tierOf(uint256 escrowBal) internal view returns (uint8 tier) {
        (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl) =
            LibVaipakam.cfgVpfiTierThresholds();
        if (escrowBal > t4Excl) return 4;
        if (escrowBal >= t3) return 3;
        if (escrowBal >= t2) return 2;
        if (escrowBal >= t1) return 1;
        return 0;
    }

    /**
     * @notice Discount BPS for a given tier. T0 is 0 (no discount).
     * @dev `view`, not `pure`: discount BPS are admin-configurable via
     *      {ConfigFacet}. Defaults (10% / 15% / 20% / 24%) apply until
     *      an override is set; the setter enforces monotonicity across
     *      tiers so a higher-balance user can never receive a smaller
     *      discount than a lower-balance one.
     * @param tier Tier index 0..4.
     * @return bps Discount applied to the NORMAL fee (e.g. 1000 = 10% off).
     */
    function discountBpsForTier(uint8 tier) internal view returns (uint256 bps) {
        return LibVaipakam.cfgVpfiTierDiscountBps(tier);
    }

    /**
     * @notice Read `user`'s escrow VPFI balance through the diamond's
     *         storage + VPFI token. Returns 0 when escrow doesn't exist or
     *         VPFI isn't registered on this chain.
     * @param user Address whose escrow balance to read.
     * @return bal Escrow VPFI balance (18 decimals), or 0 if unavailable.
     */
    function escrowVPFIBalance(address user) internal view returns (uint256 bal) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vpfiToken == address(0)) return 0;
        address escrow = s.userVaipakamEscrows[user];
        if (escrow == address(0)) return 0;
        return IERC20(s.vpfiToken).balanceOf(escrow);
    }

    // ─── Time-weighted discount rollup (§5.2a) ───────────────────────────────

    /**
     * @notice Close the current period on `user`'s VPFI discount accumulator
     *         and re-stamp the BPS against the **post-mutation** balance.
     *
     * @dev Load-bearing ordering invariant: call this at every escrow-VPFI
     *      balance mutation, passing the balance that will be in effect
     *      after the mutation. The closing period is attributed to the
     *      stamp left by the PRIOR rollup — whatever tier was in effect
     *      from then until now. Re-stamping at the post-mutation balance
     *      seeds the next period at the tier the user actually holds going
     *      forward. Pre-mutation re-stamp (the pre-Phase 5 behaviour) let
     *      a user keep collecting a high-tier stamp after unstaking down
     *      to tier-0, defeating anti-gaming on both the lender yield-fee
     *      and borrower LIF discounts.
     *
     *      Read-only callers (loan-init snapshot, yield-fee settlement
     *      before any balance change) pass the live balance — no mutation
     *      happens, so pre == post.
     *
     *      First call per user self-seeds (no accrual for a period we
     *      never measured). Pre-upgrade users and brand-new users both
     *      start at `cumulativeDiscountBpsSeconds = 0` with the stamped
     *      BPS matching the supplied `balPostMutation`.
     *
     * @param user            Address whose discount state is being rolled up.
     * @param balPostMutation Escrow VPFI balance that will be in effect for
     *                        the next period. For snapshot-only callers,
     *                        the live balance.
     */
    function rollupUserDiscount(
        address user,
        uint256 balPostMutation
    ) internal {
        LibVaipakam.UserVpfiDiscountState storage u =
            LibVaipakam.storageSlot().userVpfiDiscountState[user];

        if (u.lastRollupAt == 0) {
            // Self-seed against the post-mutation balance — that's the
            // tier in effect for the first measured period. Nothing
            // accrues for time before this moment.
            u.discountBpsAtPreviousRollup =
                uint16(discountBpsForTier(tierOf(balPostMutation)));
            u.lastRollupAt = uint64(block.timestamp);
            return;
        }

        uint256 elapsed = block.timestamp - u.lastRollupAt;
        if (elapsed > 0) {
            // Close the prior period at the stamped bps, which was seeded
            // from the pre-mutation balance of the PRIOR rollup — i.e.
            // the tier in effect across the just-closed window.
            u.cumulativeDiscountBpsSeconds +=
                uint256(u.discountBpsAtPreviousRollup) * elapsed;
        }
        // Re-stamp against the post-mutation balance: the tier that will
        // be in effect from now until the next rollup. Governance changes
        // to the tier table take effect here prospectively.
        u.discountBpsAtPreviousRollup =
            uint16(discountBpsForTier(tierOf(balPostMutation)));
        u.lastRollupAt = uint64(block.timestamp);
    }

    /**
     * @notice Time-weighted average discount BPS a lender earned across a
     *         specific loan's lifetime. Callers MUST have just invoked
     *         {rollupUserDiscount} on the lender so the accumulator reflects
     *         "as of now". A zero `loan.startTime` or a zero-duration window
     *         (loan accepted and repaid in the same block) returns 0 — no
     *         discount on degenerate loans, which matches settlement-math
     *         sanity.
     */
    function lenderTimeWeightedDiscountBps(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256 avgBps) {
        if (loan.startTime == 0 || block.timestamp <= loan.startTime) return 0;
        uint256 windowSeconds = block.timestamp - loan.startTime;
        uint256 currentAcc =
            LibVaipakam.storageSlot()
                .userVpfiDiscountState[loan.lender]
                .cumulativeDiscountBpsSeconds;
        if (currentAcc <= loan.lenderDiscountAccAtInit) return 0;
        avgBps =
            (currentAcc - loan.lenderDiscountAccAtInit) / windowSeconds;
    }

    /**
     * @notice Time-weighted average discount BPS a borrower earned across a
     *         specific loan's lifetime (Phase 5 / §5.2b). Borrower mirror
     *         of {lenderTimeWeightedDiscountBps}.
     *
     * @dev Callers MUST have just invoked {rollupUserDiscount} on the
     *      borrower so the accumulator reflects "as of now". A zero
     *      `loan.startTime`, zero-duration window, or a loan that took
     *      the lending-asset fee path at init (no anchor set, delta ==
     *      0) returns 0.
     */
    function borrowerTimeWeightedDiscountBps(
        LibVaipakam.Loan storage loan
    ) internal view returns (uint256 avgBps) {
        if (loan.startTime == 0 || block.timestamp <= loan.startTime) return 0;
        uint256 windowSeconds = block.timestamp - loan.startTime;
        uint256 currentAcc =
            LibVaipakam.storageSlot()
                .userVpfiDiscountState[loan.borrower]
                .cumulativeDiscountBpsSeconds;
        if (currentAcc <= loan.borrowerDiscountAccAtInit) return 0;
        avgBps =
            (currentAcc - loan.borrowerDiscountAccAtInit) / windowSeconds;
    }

    // ─── Quotes (view) ───────────────────────────────────────────────────────

    /**
     * @notice Quote the VPFI amount required for the borrower Loan
     *         Initiation Fee on an ERC-20 principal offer (Phase 5).
     * @dev Phase 5 semantics: the borrower pays the FULL 0.1% LIF up front
     *      in VPFI (no tier discount at init). The tier gates eligibility
     *      only — tier-0 users stay on the lending-asset path because they
     *      earn no time-weighted rebate. Tiers ≥ 1 get the discount as a
     *      claimable rebate at proper settlement, sized by the time-
     *      weighted average BPS across the loan's lifetime.
     *
     *      Caller must have already verified the offer is ERC-20 principal.
     *      Returns `(false, 0, 0)` when the borrower is in T0, or when any
     *      Chainlink / config input is unavailable. Never reverts.
     * @param principalAsset The offer's lending asset (ERC-20).
     * @param principal      The offer principal amount in lending asset wei.
     * @param borrower       The borrower whose tier is resolved.
     * @return canQuote      True iff the borrower is eligible for the VPFI
     *                       path (tier ≥ 1) and the oracle route resolves.
     * @return vpfiRequired  VPFI (18 dec) equivalent of the FULL LIF; the
     *                       amount actually pulled from borrower escrow at
     *                       init on the VPFI path.
     * @return tier          Resolved tier 1..4 (0 on canQuote == false).
     *                       Surfaces the rebate scale the borrower is
     *                       positioned to earn if they hold VPFI through
     *                       settlement.
     */
    function quote(
        address principalAsset,
        uint256 principal,
        address borrower
    )
        internal
        view
        returns (bool canQuote, uint256 vpfiRequired, uint8 tier)
    {
        if (principal == 0 || borrower == address(0)) return (false, 0, 0);

        uint256 bal = escrowVPFIBalance(borrower);
        tier = tierOf(bal);
        if (tier == 0) return (false, 0, 0);

        uint256 normalFee = (principal * LibVaipakam.cfgLoanInitiationFeeBps()) /
            LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 vpfi) = _feeAssetWeiToVPFI(principalAsset, normalFee);
        if (!ok) return (false, 0, 0);
        return (true, vpfi, tier);
    }

    /**
     * @notice Quote the VPFI required for the lender yield-fee discount on
     *         a given interest amount. Uses the TIME-WEIGHTED average
     *         discount BPS across the loan's lifetime — NOT the lender's
     *         tier at the settlement moment. This defeats the "top up
     *         just before repay" gaming vector: a lender who held VPFI
     *         for 29 of 30 days at tier 1 and jumped to tier 4 on day 30
     *         sees a fractional discount, not the full tier-4 rate.
     *
     *         Prerequisite: caller MUST have just invoked
     *         {rollupUserDiscount}(loan.lender, currentBal) so the
     *         accumulator reflects "as of now". `tryApplyYieldFee` does
     *         this implicitly; external callers shouldn't use
     *         `quoteYieldFee` directly.
     *
     * @param loan           The loan the yield fee is settling against.
     * @param interestAmount The lender's pre-split interest in principal-
     *                       asset wei.
     * @return canQuote      True iff a non-zero discount is available.
     * @return vpfiRequired  VPFI (18 dec) the lender must hold in escrow
     *                       to take the discount.
     * @return avgBps        The time-weighted average discount BPS that
     *                       applied across the loan (0 when canQuote=false).
     */
    function quoteYieldFee(
        LibVaipakam.Loan storage loan,
        uint256 interestAmount
    )
        internal
        view
        returns (bool canQuote, uint256 vpfiRequired, uint256 avgBps)
    {
        if (interestAmount == 0 || loan.lender == address(0)) return (false, 0, 0);

        avgBps = lenderTimeWeightedDiscountBps(loan);
        if (avgBps == 0) return (false, 0, 0);

        uint256 normalFee = (interestAmount * LibVaipakam.cfgTreasuryFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        uint256 payBps = LibVaipakam.BASIS_POINTS - avgBps;
        uint256 tierFee = (normalFee * payBps) / LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 vpfi) = _feeAssetWeiToVPFI(loan.principalAsset, tierFee);
        if (!ok) return (false, 0, 0);
        return (true, vpfi, avgBps);
    }

    // ─── Apply (mutating) ────────────────────────────────────────────────────

    /**
     * @notice Attempt to pay the borrower's FULL Loan Initiation Fee in
     *         VPFI out of the borrower's escrow into Diamond custody
     *         (Phase 5 / §5.2b).
     *
     * @dev Phase 5 semantics: pays the FULL 0.1% LIF equivalent (not
     *      tier-discounted) in VPFI at init. The discount is delivered as
     *      a time-weighted rebate at proper settlement via
     *      {settleBorrowerLifProper}. Tier ≥ 1 gate prevents tier-0 users
     *      from paying VPFI with no expected rebate.
     *
     *      Silent fallback on any failure (tier-0, oracle gap, escrow
     *      short, sub-call reverts) — caller falls through to the normal
     *      lending-asset fee path. On success the VPFI lands in the
     *      Diamond; caller MUST record the amount against the loan via
     *      `s.borrowerLifRebate[loanId].vpfiHeld` once the loan id is
     *      known. Treasury accrual is NOT recorded here — it happens at
     *      settlement when the final split (rebate vs. treasury) is
     *      determined.
     *
     * @param principalAsset The offer's lending asset.
     * @param principal      The offer principal.
     * @param borrower       The borrower funding the LIF in VPFI.
     * @return applied       True iff VPFI was successfully deducted.
     * @return vpfiDeducted  VPFI amount moved from borrower escrow to
     *                       Diamond custody — caller records as vpfiHeld.
     */
    function tryApplyBorrowerLif(
        address principalAsset,
        uint256 principal,
        address borrower
    ) internal returns (bool applied, uint256 vpfiDeducted) {
        (bool canQuote, uint256 vpfiRequired, ) = quote(
            principalAsset,
            principal,
            borrower
        );
        if (!canQuote) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address borrowerEscrow = s.userVaipakamEscrows[borrower];
        if (borrowerEscrow == address(0)) return (false, 0);

        uint256 escrowBal = IERC20(vpfi).balanceOf(borrowerEscrow);
        if (escrowBal < vpfiRequired) return (false, 0);

        // Staking checkpoint BEFORE the balance leaves escrow so the
        // accrual captures the pre-deduction staked amount.
        LibStakingRewards.updateUser(borrower, escrowBal - vpfiRequired);

        // Withdraw VPFI from borrower's escrow into Diamond custody (the
        // Diamond holds it until settlement splits it between rebate and
        // treasury). The withdraw reverts on insufficient balance /
        // escrow misconfiguration; silent-fallback via the call wrapper.
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                borrower,
                vpfi,
                address(this),
                vpfiRequired
            )
        );
        if (!ok) return (false, 0);

        // Rollup the borrower's discount accumulator at the post-
        // mutation balance now that the withdraw has committed. Seeds
        // the stamp so the next period's accrual reflects the tier the
        // borrower actually holds from here on. The prior rollup (at
        // `_snapshotBorrowerDiscount`) closed the period at the pre-
        // withdraw stamp.
        rollupUserDiscount(borrower, escrowBal - vpfiRequired);

        return (true, vpfiRequired);
    }

    // ─── Settlement helpers (Phase 5 / §5.2b) ────────────────────────────────

    /**
     * @notice Close out the borrower LIF custody at a proper loan
     *         settlement (repay / preclose / refinance-old-loan). Splits
     *         the held VPFI between the borrower's claimable rebate and
     *         the treasury share based on the time-weighted average
     *         discount BPS across the loan window.
     *
     * @dev No-op when `vpfiHeld == 0` (the loan took the lending-asset
     *      fee path at init, so there's nothing to split). Silently does
     *      the right thing for pre-upgrade loans — they have zero anchor
     *      and zero vpfiHeld, so the helper returns without side-effects.
     *
     *      Ordering: the caller MUST roll up the borrower's discount
     *      accumulator before invoking this helper so the window average
     *      reflects "as of now".
     *
     *      Treasury accrual is recorded for the treasury share; the
     *      rebate slice stays at the Diamond pending the borrower's
     *      claim via {ClaimFacet.claimAsBorrower}.
     *
     * @param loan Loan being settled.
     */
    function settleBorrowerLifProper(LibVaipakam.Loan storage loan) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.BorrowerLifRebate storage r = s.borrowerLifRebate[loan.id];
        uint256 held = r.vpfiHeld;
        if (held == 0) return;

        address vpfi = s.vpfiToken;
        if (vpfi == address(0)) {
            // Unrecoverable oracle/config gap — flush to treasury (no
            // rebate) rather than leave VPFI orphaned at the Diamond.
            r.vpfiHeld = 0;
            LibFacet.transferToTreasury(vpfi, held);
            return;
        }

        // Roll up "as of now" (no mutation on this read) so the window
        // average sees every period up to this settlement instant.
        uint256 borrowerBal = IERC20(vpfi).balanceOf(
            s.userVaipakamEscrows[loan.borrower]
        );
        rollupUserDiscount(loan.borrower, borrowerBal);

        uint256 avgBps = borrowerTimeWeightedDiscountBps(loan);
        uint256 rebate = (held * avgBps) / LibVaipakam.BASIS_POINTS;
        if (rebate > held) rebate = held;
        uint256 treasuryShare = held - rebate;

        r.vpfiHeld = 0;
        r.rebateAmount = rebate;

        if (treasuryShare > 0) {
            LibFacet.transferToTreasury(vpfi, treasuryShare);
        }
    }

    /**
     * @notice Forward the borrower LIF custody directly to treasury on a
     *         non-proper settlement (default / HF-liquidation). No
     *         rebate is credited — the borrower forfeits the entire
     *         up-front VPFI.
     *
     * @dev No-op when `vpfiHeld == 0`. Always safe to call; the
     *      settlement helpers on default/liquidation paths invoke this
     *      unconditionally to drain any Diamond-held VPFI for the loan.
     */
    function forfeitBorrowerLif(LibVaipakam.Loan storage loan) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.BorrowerLifRebate storage r = s.borrowerLifRebate[loan.id];
        uint256 held = r.vpfiHeld;
        if (held == 0) return;
        r.vpfiHeld = 0;
        // rebateAmount stays at 0 — no claim on forfeiture.
        LibFacet.transferToTreasury(s.vpfiToken, held);
    }

    /**
     * @notice Attempt to pay the lender's time-weighted Yield-Fee discount
     *         in VPFI out of the lender's escrow into the treasury.
     *
     * @dev On success, the lender keeps 100% of `interestAmount` in the
     *      lending asset (no full-rate treasury haircut) and the
     *      time-weighted-discounted treasury share is satisfied entirely
     *      in VPFI from the lender's escrow. Silent fallback on any
     *      failure — quote unavailable, escrow underfunded, oracle gap,
     *      zero-duration loan.
     *
     *      Caller must have verified `s.vpfiDiscountConsent[lender]`
     *      before invoking; consent is platform-level, not loan-level.
     *
     *      Ordering invariant: this function performs the lender's
     *      discount rollup BEFORE computing the quote and BEFORE
     *      checkpointing the staking accrual, so the closed period is
     *      attributed to the pre-mutation escrow balance. Read-only
     *      callers that need the quote should not invoke this mutating
     *      entrypoint; they can read the per-loan snapshot + user
     *      accumulator themselves and call {lenderTimeWeightedDiscountBps}.
     *
     * @param loan           Live loan storage slot the yield fee is
     *                       settling against. Provides the principal
     *                       asset, lender address, and the per-loan
     *                       snapshot that anchors the time-weighted
     *                       window.
     * @param interestAmount Pre-split interest in `loan.principalAsset`
     *                       wei that the yield fee is computed against.
     * @return applied       True iff VPFI was successfully deducted.
     * @return vpfiDeducted  VPFI moved from lender escrow to treasury.
     */
    function tryApplyYieldFee(
        LibVaipakam.Loan storage loan,
        uint256 interestAmount
    ) internal returns (bool applied, uint256 vpfiDeducted) {
        address lender = loan.lender;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address lenderEscrow = s.userVaipakamEscrows[lender];
        if (lenderEscrow == address(0) || vpfi == address(0)) return (false, 0);

        // 1. Roll up the lender's discount accumulator to "now" so the
        //    window-averaged BPS reflects every period right up to this
        //    settlement. No balance change on this read — pre == post at
        //    the live balance. A second rollup after the withdraw
        //    re-stamps at the post-mutation tier; splitting the two
        //    protects against silent-fallback failure committing a
        //    wrong stamp.
        uint256 escrowBal = IERC20(vpfi).balanceOf(lenderEscrow);
        rollupUserDiscount(lender, escrowBal);

        // 2. Quote against the now-current accumulator + the loan's
        //    init snapshot. This returns the time-weighted avg discount
        //    for the window, not a live tier lookup.
        (bool canQuote, uint256 vpfiRequired, ) = quoteYieldFee(loan, interestAmount);
        if (!canQuote) return (false, 0);
        if (escrowBal < vpfiRequired) return (false, 0);

        // 3. Checkpoint staking accrual at the post-mutation balance.
        //    Mirrors the pattern at every other escrow-mutation site.
        LibStakingRewards.updateUser(lender, escrowBal - vpfiRequired);

        address treasury = LibFacet.getTreasury();
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(
                EscrowFactoryFacet.escrowWithdrawERC20.selector,
                lender,
                vpfi,
                treasury,
                vpfiRequired
            )
        );
        if (!ok) return (false, 0);

        // 4. Re-stamp the accumulator at the post-mutation balance now
        //    that the withdraw has committed. Zero elapsed between this
        //    call and step 1 — purely a stamp refresh so the next period
        //    accrues at the tier the lender actually holds from here on.
        rollupUserDiscount(lender, escrowBal - vpfiRequired);

        LibFacet.recordTreasuryAccrual(vpfi, vpfiRequired);
        return (true, vpfiRequired);
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /// @dev Shared conversion: fee expressed in `feeAsset` wei → VPFI (18 dec)
    ///      via the configured Chainlink feeds and the fixed ETH→VPFI rate.
    ///      Returns `(false, 0)` on any missing oracle / config input,
    ///      malformed ERC-20 decimals, or a zero intermediate result.
    ///      Never reverts.
    /// @param feeAsset            ERC-20 the fee is denominated in.
    /// @param feeAmountInAssetWei Fee amount in `feeAsset` wei (native decimals).
    /// @return canQuote           True iff all oracle / config inputs resolved.
    /// @return vpfiRequired       VPFI (18 dec) equivalent of the fee.
    function _feeAssetWeiToVPFI(
        address feeAsset,
        uint256 feeAmountInAssetWei
    ) private view returns (bool canQuote, uint256 vpfiRequired) {
        if (feeAsset == address(0) || feeAmountInAssetWei == 0) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 weiPerVpfi = s.vpfiFixedRateWeiPerVpfi;
        address ethRefAsset = s.vpfiDiscountETHPriceAsset;
        if (weiPerVpfi == 0 || ethRefAsset == address(0)) return (false, 0);
        if (s.vpfiToken == address(0)) return (false, 0);

        uint256 lendPrice;
        uint8 lendFeedDec;
        try OracleFacet(address(this)).getAssetPrice(feeAsset) returns (
            uint256 p,
            uint8 d
        ) {
            lendPrice = p;
            lendFeedDec = d;
        } catch {
            return (false, 0);
        }

        uint256 ethPrice;
        uint8 ethFeedDec;
        try OracleFacet(address(this)).getAssetPrice(ethRefAsset) returns (
            uint256 p,
            uint8 d
        ) {
            ethPrice = p;
            ethFeedDec = d;
        } catch {
            return (false, 0);
        }

        if (lendPrice == 0 || ethPrice == 0) return (false, 0);

        uint8 lendTokenDec = _safeTokenDecimals(feeAsset);
        uint8 ethTokenDec = _safeTokenDecimals(ethRefAsset);
        if (lendTokenDec == 0 || ethTokenDec == 0) return (false, 0);

        uint256 feeUsd1e18 = (feeAmountInAssetWei * lendPrice * 1e18) /
            (10 ** lendFeedDec) /
            (10 ** lendTokenDec);
        if (feeUsd1e18 == 0) return (false, 0);

        uint256 feeWei = (feeUsd1e18 *
            (10 ** ethTokenDec) *
            (10 ** ethFeedDec)) /
            (ethPrice * 1e18);
        if (feeWei == 0) return (false, 0);

        vpfiRequired = (feeWei * 1e18) / weiPerVpfi;
        canQuote = vpfiRequired > 0;
    }

    /// @dev `decimals()` on a malformed ERC-20 can revert or return 0 —
    ///      treat either as "can't quote" by returning 0.
    /// @param token ERC-20 to inspect.
    /// @return dec  Token decimals, or 0 when the call reverts / returns 0.
    function _safeTokenDecimals(address token) private view returns (uint8 dec) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 0;
        }
    }
}
