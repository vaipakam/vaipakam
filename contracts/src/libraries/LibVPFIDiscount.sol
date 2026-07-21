// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFacet} from "./LibFacet.sol";
import {LibOfferMatch} from "./LibOfferMatch.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {VaultFactoryFacet} from "../facets/VaultFactoryFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../facets/VPFIDiscountAccumulatorFacet.sol";

/**
 * @title LibVPFIDiscount
 * @author Vaipakam Developer Team
 * @notice Shared quote / apply helpers for both VPFI fee discount paths
 *         (docs/TokenomicsTechSpec.md §6):
 *           - Borrower Loan Initiation Fee discount (normal 0.1%)
 *           - Lender Yield Fee discount             (normal 1%)
 *         Both paths share the same tier-by-vault-balance gate and the
 *         same platform-level consent flag `s.vpfiDiscountConsent[user]`.
 * @dev Tier semantics (`LibVaipakam` constants):
 *
 *        Tier | Vault VPFI range              | Discount
 *          0  | x < 100                        |   0%  (no discount)
 *          1  | 100    ≤ x < 1,000             |  10%
 *          2  | 1,000  ≤ x < 5,000             |  15%
 *          3  | 5,000  ≤ x ≤ 20,000            |  20%  (20k inclusive)
 *          4  |          x > 20,000            |  24%
 *
 *      Tier resolution is a pure VPFI balance check — no Chainlink
 *      dependency — so the tier gate is deterministic and cheap.
 *
 *      The tier-adjusted fee is still paid IN VPFI out of the user's vault
 *      (spec: "the system should automatically deduct the required VPFI
 *      amount from vault to Treasury"). That conversion still uses
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
     * @notice Resolve the VPFI discount tier for a given vault balance.
     * @dev `view`, not `pure`: tier thresholds are now admin-configurable
     *      through {ConfigFacet} and resolved via
     *      {LibVaipakam.cfgVpfiTierThresholds}. Defaults (100 / 1k / 5k /
     *      20k) apply when no override is set. The T3/T4 split remains
     *      strict: exactly the T4 threshold is T3, not T4.
     * @param vaultBal The user's vault VPFI balance (18 decimals).
     * @return tier 0..4 — 0 means no discount.
     */
    function tierOf(uint256 vaultBal) internal view returns (uint8 tier) {
        (uint256 t1, uint256 t2, uint256 t3, uint256 t4Excl) =
            LibVaipakam.cfgVpfiTierThresholds();
        if (vaultBal > t4Excl) return 4;
        if (vaultBal >= t3) return 3;
        if (vaultBal >= t2) return 2;
        if (vaultBal >= t1) return 1;
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
     * @notice Read `user`'s vault VPFI balance through the diamond's
     *         storage + VPFI token. Returns 0 when vault doesn't exist or
     *         VPFI isn't registered on this chain.
     * @param user Address whose vault balance to read.
     * @return bal Vault VPFI balance (18 decimals), or 0 if unavailable.
     */
    function vaultVpfiBalance(address user) internal view returns (uint256 bal) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vpfiToken == address(0)) return 0;
        address vault = s.userVaipakamVaults[user];
        if (vault == address(0)) return 0;
        return IERC20(s.vpfiToken).balanceOf(vault);
    }

    /// @notice Returns the protocol-tracked VPFI balance for `user`,
    ///         used to clamp the yield-bearing balance against
    ///         unsolicited dust. Mirrors {vaultVpfiBalance}'s
    ///         defensive zero-returns when VPFI / vault are
    ///         unset.
    function trackedVpfiBalance(address user) internal view returns (uint256) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.vpfiToken == address(0)) return 0;
        return s.protocolTrackedVaultBalance[user][s.vpfiToken];
    }

    /**
     * @notice The VPFI balance that should drive `user`'s fee-tier stamp:
     *         their post-mutation vault balance MINUS any VPFI frozen in
     *         their vault but economically owed to a delistable position
     *         holder (`s.frozenVpfiOwedByVault[user]`), floored at 0.
     *
     * @dev    Sanctions close-outs (swap-to-repay full / Fusion intent-fill)
     *         can freeze a transferred position's VPFI surplus / proceeds
     *         into the STORED party's vault (§1.1 / §2.1). That VPFI lands in
     *         `protocolTrackedVaultBalance` — which the tier ring buffer is
     *         stamped from — yet belongs to the current NFT holder, not the
     *         vault owner. Subtracting the dedicated
     *         `frozenVpfiOwedByVault` counter (bumped ONLY for the
     *         transferred-position case, never a flagged self-holder) keeps
     *         those funds out of the vault owner's tier without touching the
     *         shared `s.encumbered` bucket — which legitimately holds the
     *         user's OWN liens / intent / offer capital and must stay in-tier.
     *
     *         Takes the balance as an argument and never re-reads it: every
     *         stamp caller feeds `rollupUserDiscount` a *post-mutation*
     *         balance computed before storage is written (deposit/withdraw/
     *         fee-deduction), so re-reading `protocolTrackedVaultBalance`
     *         here would miscount an in-flight mutation (Codex #986 r3). The
     *         `frozen` counter, by contrast, only changes at freeze/claim —
     *         never mid deposit/withdraw — so reading it from storage is safe.
     *
     * @param user            Vault owner whose tier balance is being computed.
     * @param postMutationBal Post-mutation vault VPFI balance the caller has
     *                        already computed for this stamp.
     * @return The frozen-adjusted balance to stamp the tier from.
     */
    function tierVpfiBalance(
        address user,
        uint256 postMutationBal
    ) internal view returns (uint256) {
        uint256 frozen = LibVaipakam.storageSlot().frozenVpfiOwedByVault[user];
        return postMutationBal > frozen ? postMutationBal - frozen : 0;
    }

    /// @notice Pure clamp helper — returns
    ///         `min(actualBalance, trackedAfter)`. Used by every
    ///         staking-checkpoint and discount-accumulator caller to
    ///         exclude unsolicited dust from yield + tier accrual.
    /// @dev    The two arguments are the post-mutation values the
    ///         caller already computed (typically `prevBal ± amount`
    ///         and `prevTracked ± amount`). For legitimate flows
    ///         post-T-051 the two numbers track each other, so the
    ///         clamp is a no-op. Where the actual balance is inflated
    ///         by direct `IERC20.transfer` dust the protocol never
    ///         saw, the tracked side is unchanged and the clamp
    ///         excludes the dust.
    function clampToTracked(
        uint256 actualBalance,
        uint256 trackedAfter
    ) internal pure returns (uint256) {
        return actualBalance < trackedAfter ? actualBalance : trackedAfter;
    }

    // ─── Time-weighted discount rollup (§5.2a) ───────────────────────────────

    /**
     * @notice Close the current period on `user`'s VPFI discount accumulator
     *         and re-stamp the BPS against the **post-mutation** balance.
     *
     * @dev Load-bearing ordering invariant: call this at every vault-VPFI
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
     * @param balPostMutation Vault VPFI balance that will be in effect for
     *                        the next period. For snapshot-only callers,
     *                        the live balance.
     */
    function rollupUserDiscount(
        address user,
        uint256 balPostMutation
    ) internal {
        // T-087 Sub 1.B — route through {VPFIDiscountAccumulatorFacet}
        // to keep the heavy ring-buffer + lifecycle bytecode out of
        // every settlement-facet's inlined surface (see that facet's
        // top-of-file rationale for the EIP-170 motivation). The
        // wrapper preserves the public library API so call sites
        // stay unchanged.
        //
        // Low-level call + silent fallback: many bespoke unit-test
        // fixtures (LoanFacetTest, RepayFacetTest, ...) build a
        // minimal diamond that doesn't cut the accumulator facet
        // because they don't exercise the discount path. A direct
        // typed call would revert `FunctionDoesNotExist`. The
        // silent fallback preserves the pre-T-087 semantics on
        // those fixtures (the rollup becomes a no-op) while
        // production deployments + the SetupTest fixture get the
        // full accumulator behaviour.
        // Codex Sub 2.D round-3 P1 #1 — the outer-wrapper silent
        // fallback on `FunctionDoesNotExist()` is only safe when
        // we KNOW the revert can't have come from the broadcast
        // path. The accumulator's own broadcast call is gated on
        // `rewardMessenger != 0`, so if the messenger is unset
        // the accumulator never reaches the broadcast facet and
        // a returned `FunctionDoesNotExist` selector unambiguously
        // means "the accumulator facet itself isn't cut" — silent
        // fallback is correct for minimal-fixture tests.
        //
        // If the messenger IS set, however, the accumulator WILL
        // attempt the broadcast call, and a `FunctionDoesNotExist`
        // selector could equally well come from a missing
        // ProtocolBroadcastFacet cut OR a misconfigured messenger
        // contract — both are real production bugs that must
        // bubble to the caller, not be silently swallowed.
        // #954 (Codex #981/#986 §2.2) — every tier stamp funnels through this
        // wrapper, so applying the frozen-owed exclusion HERE covers every
        // caller (deposit/withdraw/fee/consolidation/loan-init) uniformly and
        // future-proofs new call sites. `balPostMutation` is already the
        // post-mutation balance the caller computed; `tierVpfiBalance` only
        // subtracts the frozen-owed counter, never re-reads the mutating
        // balance.
        balPostMutation = tierVpfiBalance(user, balPostMutation);
        address messenger = LibVaipakam.storageSlot().rewardMessenger;
        (bool ok, bytes memory returnData) = address(this).call(
            abi.encodeWithSelector(
                VPFIDiscountAccumulatorFacet.rollupUserDiscount.selector,
                user,
                balPostMutation
            )
        );
        if (!ok) {
            if (messenger == address(0)) {
                // Unconfigured — selector-discriminator silent
                // fallback safely handles minimal-fixture diamonds.
                bytes4 functionDoesNotExistSelector = bytes4(
                    keccak256(bytes("FunctionDoesNotExist()"))
                );
                if (
                    returnData.length >= 4
                        && bytes4(returnData) == functionDoesNotExistSelector
                ) {
                    return;
                }
            }
            // Either the messenger is wired (production / configured
            // testnet — any revert IS a real bug) or a non-selector
            // revert raced through unconfigured paths. Bubble in
            // both cases.
            assembly {
                revert(add(32, returnData), mload(returnData))
            }
        }
    }

    /**
     * @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — broadcast-FREE
     *         sibling of {rollupUserDiscount}. Identical local accumulator
     *         writes (frozen-owed exclusion included), but routes to
     *         {VPFIDiscountAccumulatorFacet.rollupUserDiscountLocal}, which
     *         never attempts the CCIP tier push.
     *
     * @dev Used by the Diamond-funded vault credit primitive on the reward
     *      claim-to-vault path, where inheriting the broadcast path's
     *      failure modes (`ProtocolBudgetExhausted`, messenger misconfig)
     *      would regress claim availability. The deferred push is carried
     *      by the user's next broadcasting rollup.
     *
     *      Silent-fallback rule is SIMPLER than {rollupUserDiscount}'s: the
     *      local entry never reaches the broadcast facet, so a returned
     *      `FunctionDoesNotExist()` selector can only mean "the accumulator
     *      facet isn't cut" (minimal-fixture test diamonds) — safe to no-op
     *      regardless of messenger configuration. Every other revert
     *      bubbles.
     *
     * @param user            Address whose discount state is being rolled up.
     * @param balPostMutation Vault VPFI balance in effect after the caller's
     *                        mutation.
     */
    function rollupUserDiscountLocal(
        address user,
        uint256 balPostMutation
    ) internal {
        balPostMutation = tierVpfiBalance(user, balPostMutation);
        (bool ok, bytes memory returnData) = address(this).call(
            abi.encodeWithSelector(
                VPFIDiscountAccumulatorFacet.rollupUserDiscountLocal.selector,
                user,
                balPostMutation
            )
        );
        if (!ok) {
            bytes4 functionDoesNotExistSelector = bytes4(
                keccak256(bytes("FunctionDoesNotExist()"))
            );
            if (
                returnData.length >= 4
                    && bytes4(returnData) == functionDoesNotExistSelector
            ) {
                return;
            }
            assembly {
                revert(add(32, returnData), mload(returnData))
            }
        }
    }

    /// @notice T-087 Sub 1.B — read entry point used by every fee-charging
    ///         path on Base. Returns the user's EFFECTIVE_TIER and the
    ///         BPS to apply, both already past the min-history gate and
    ///         the min-tier-over-history clamp.
    /// @dev    Pure view; the caller MUST have invoked
    ///         {rollupUserDiscount} first so the ring buffer reflects
    ///         "as of now". Mirror chains read from
    ///         `s.userTierCache[user]` instead (Sub 1.C wires that path).
    function effectiveTierAndBps(address user)
        internal
        view
        returns (uint8 effTier, uint16 effBps)
    {
        // T-087 Sub 1.C — dispatch by chain identity. On Base
        // (canonical VPFI chain) the call routes through the
        // accumulator facet's cross-facet staticcall (the heavy
        // ring-buffer + min-tier scan stays out of every consumer
        // facet's inlined bytecode per Sub 1.B's EIP-170 carve).
        // On mirror chains the read goes against the cached
        // per-user `CachedTier` slot — written by the CCIP
        // `TierUpdated` inbound handler (Sub 2) — and applies
        // the per-design freshness gates locally without a Base
        // round-trip.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.isCanonicalVpfiChain) {
            return _baseEffectiveTierAndBps(user);
        }
        return _mirrorEffectiveTierAndBps(s, user);
    }

    /// @dev Base-side: cross-facet staticcall to the accumulator
    ///      facet. Silent (0, 0) fallback keeps minimal-fixture
    ///      tests that don't cut the accumulator facet working
    ///      (rollup becomes a no-op on those fixtures).
    function _baseEffectiveTierAndBps(address user)
        private
        view
        returns (uint8 effTier, uint16 effBps)
    {
        (bool ok, bytes memory ret) = address(this).staticcall(
            abi.encodeWithSelector(
                VPFIDiscountAccumulatorFacet.effectiveTierAndBps.selector,
                user
            )
        );
        if (!ok || ret.length < 64) return (0, 0);
        (effTier, effBps) = abi.decode(ret, (uint8, uint16));
    }

    /// @dev Mirror-side: read from `s.userTierCache[user]` and
    ///      apply all three freshness gates locally:
    ///       1. The cached effective tier must be non-zero
    ///          (a fresh / never-pushed cache entry means
    ///          "no propagated tier yet" → no discount).
    ///       2. The cached `tierTableVersion` must match
    ///          `s.currentTierTableVersion` so a governance
    ///          tier-threshold change on Base invalidates every
    ///          cached entry until a fresh push catches it up
    ///          (Codex design round-6 P1 #10 + round-10 P1 #1).
    ///       3. `now < tierExpirySec` — the projected decay
    ///          expiry baked into the cached tier at push time
    ///          (round-3 P1 #1 + sentinel `type(uint40).max`
    ///          round-6 P1 #9). Sub 1.B / 1.C ship with the
    ///          sentinel set on every write so the gate is
    ///          effectively "never expires from decay alone"
    ///          until Sub 2 wires the projected-trajectory scan.
    ///       4. `now - lastUpdateSec <= cfgMirrorTierMaxAgeSec`
    ///          is the secondary backstop for the "stake then
    ///          never return + no broadcast" worst case
    ///          (round-2 P1 #3); default 60 days.
    ///
    ///      The cached `effectiveBps` is applied directly so a
    ///      governance change to the per-tier BPS table on Base
    ///      reaches mirrors atomically with the version bump
    ///      (round-11 P1 #6); mirrors deliberately do NOT call
    ///      `discountBpsForTier(tier)` against their local
    ///      constants.
    function _mirrorEffectiveTierAndBps(
        LibVaipakam.Storage storage s,
        address user
    ) private view returns (uint8 effTier, uint16 effBps) {
        // Sub 1.C round-1 P2 #3: a mirror with a valid cached
        // entry but no local `vpfiToken` set would otherwise let
        // `quote()` succeed; the downstream `tryApplyBorrowerLif`
        // then reaches `IERC20(vpfi).balanceOf(...)` with
        // `vpfi == address(0)` and reverts instead of taking the
        // documented silent fallback path. Treat unconfigured VPFI
        // as "no discount available on this chain" upfront.
        if (s.vpfiToken == address(0)) return (0, 0);
        LibVaipakam.CachedTier storage cache = s.userTierCache[user];
        if (cache.effectiveTier == 0) return (0, 0);
        if (cache.tierTableVersion != s.currentTierTableVersion) return (0, 0);
        if (block.timestamp >= uint256(cache.tierExpirySec)) return (0, 0);
        uint256 ageBudget =
            uint256(LibVaipakam.cfgMirrorTierMaxAgeSecEffective());
        if (block.timestamp > uint256(cache.lastUpdateSec) + ageBudget) {
            return (0, 0);
        }
        return (cache.effectiveTier, cache.effectiveBps);
    }

    // Heavy ring-buffer + lifecycle helpers live in
    // {VPFIDiscountAccumulatorFacet}; this library accesses them
    // via the cross-facet wrappers above so the consumers
    // (RepayFacet / PrecloseFacet / RefinanceFacet) don't inline
    // ~2 kB of bytecode each and breach EIP-170.


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
        // T-087 Sub 1.B: the design replaces the Phase-5 loan-window
        // averaging with INSTANT EFFECTIVE_BPS lookup at the moment of
        // fee application (design §3 reuse row). The `loan.startTime`
        // gate is kept defensively — a zero-duration loan (accepted
        // and repaid in the same block) returns 0 by parity with
        // the previous semantics. The `loan.lenderDiscountAccAtInit`
        // anchor stays populated (vestigial) but is no longer read.
        if (loan.startTime == 0 || block.timestamp <= loan.startTime) return 0;
        ( , uint16 effBps) = effectiveTierAndBps(loan.lender);
        avgBps = uint256(effBps);
        // #1352 (Codex P2): the 50% fee-discount ceiling is a UNIFORM cap.
        // `ConfigFacet.setVpfiTierDiscountBps` still permits per-tier values
        // above `MAX_FEE_DISCOUNT_BPS` (up to 9000), so clamp here — the same
        // clamp `holdOnlyBorrowerLif` applies to the borrower LIF — or a
        // lender could realize a >50% yield-fee reduction and under-collect
        // treasury on repay/preclose/refinance settlements.
        if (avgBps > LibVaipakam.MAX_FEE_DISCOUNT_BPS) {
            avgBps = LibVaipakam.MAX_FEE_DISCOUNT_BPS;
        }
    }

    /**
     * @notice #1354 (M2 PR-6) — the TOTAL lender yield-fee discount BPS for a
     *         settlement: the consent-gated hold-tier discount plus the +10%
     *         Full-tariff bump, capped at the uniform 50% ceiling. This is the
     *         `d = min(d_hold + d_tariff, 5000)` of formula §F2, and it is what
     *         both yield-fee delivery paths ({quoteYieldFee} VPFI-payment and
     *         {directReductionYieldFee} peg-unset) charge against.
     *
     * @dev Unlike {lenderTimeWeightedDiscountBps} — a pure hold-tier primitive
     *      that assumes the caller already verified consent — this wrapper
     *      internalises the §F2 consent split:
     *        - `d_hold` counts ONLY when `vpfiDiscountConsent[lender]` is set;
     *          without consent the hold slice is 0.
     *        - `d_tariff` (+10%) counts whenever the lender absorbed the Full
     *          `C*` tariff (`feeEntitlementByLoanId[loan.id].lenderMode ==
     *          Full`, #1347). The Full opt-in is itself the consent, so the
     *          bump applies even to a lender with no separate hold consent —
     *          symmetric with the borrower LIF bump in {holdOnlyBorrowerLif}.
     *
     *      DARK until the Full tariff path (#1347) is enabled: no loan carries
     *      a `Full` lender stamp yet, so `d_tariff` is 0 for every current loan
     *      and this returns exactly the pre-#1354 consent-gated hold discount.
     */
    function _effectiveYieldFeeDiscountBps(
        LibVaipakam.Loan storage loan,
        bool includeHold
    ) private view returns (uint256 d) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // d_hold — the VPFI-contingent hold-tier slice, gated on the lender's
        // platform VPFI-discount consent (§F2). `includeHold` is false when the
        // caller is delivering the peg-set fallback, where the hold slice is
        // VPFI-payment-authoritative and only the paid tariff slice survives.
        if (includeHold && s.vpfiDiscountConsent[loan.lender]) {
            d = lenderTimeWeightedDiscountBps(loan);
        }
        // d_tariff — +10% PAID Full own-side bump (the lender absorbed `C*` at
        // origination, #1347). Not contingent on holding VPFI or on the hold
        // consent, so it is the slice the peg-set fallback still honors.
        if (
            s.feeEntitlementByLoanId[loan.id].lenderMode ==
            LibVaipakam.FeeEntitlementMode.Full
        ) {
            d += LibVaipakam.FULL_MODE_FEE_DISCOUNT_BONUS_BPS;
        }
        // Uniform 50% ceiling — `min(d_hold + d_tariff, 5000)` (§F2).
        if (d > LibVaipakam.MAX_FEE_DISCOUNT_BPS) {
            d = LibVaipakam.MAX_FEE_DISCOUNT_BPS;
        }
    }

    /**
     * @notice #1354 (M2 PR-6) — whether a loan's lender qualifies for ANY
     *         yield-fee discount at settlement, i.e. whether the settlement
     *         sites should attempt the discount delivery at all.
     *
     * @dev Eligibility is `consent OR lenderMode == Full`. A lender who
     *      absorbed the Full `C*` tariff earns the +10% even with no separate
     *      hold-discount consent (§F2/§F3 — the Full opt-in is the consent), so
     *      the pre-#1354 consent-only gate would have wrongly skipped them. The
     *      actual discount magnitude (0 when neither slice applies) is computed
     *      by {_effectiveYieldFeeDiscountBps}; this is only the cheap
     *      attempt-or-skip guard the call sites branch on.
     *
     *      DARK-safe: while no loan is `Full`-stamped this reduces to the
     *      original `vpfiDiscountConsent[lender]` gate.
     */
    function lenderYieldFeeEligible(
        LibVaipakam.Loan storage loan
    ) internal view returns (bool) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return
            s.vpfiDiscountConsent[loan.lender] ||
            s.feeEntitlementByLoanId[loan.id].lenderMode ==
            LibVaipakam.FeeEntitlementMode.Full;
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
        // T-087 Sub 1.B — instant EFFECTIVE_BPS lookup, symmetric with
        // {lenderTimeWeightedDiscountBps}. See the rationale there.
        if (loan.startTime == 0 || block.timestamp <= loan.startTime) return 0;
        ( , uint16 effBps) = effectiveTierAndBps(loan.borrower);
        avgBps = uint256(effBps);
        // #1352 (Codex P2): uniform 50% fee-discount ceiling — symmetric with
        // {lenderTimeWeightedDiscountBps} and `holdOnlyBorrowerLif`.
        if (avgBps > LibVaipakam.MAX_FEE_DISCOUNT_BPS) {
            avgBps = LibVaipakam.MAX_FEE_DISCOUNT_BPS;
        }
    }

    /**
     * @notice HoldOnly hybrid borrower Loan-Initiation Fee (#1352, redesign
     *         §F3) — the LENDING-ASSET LIF reduced by the borrower's
     *         consent-gated hold-tier discount. Two-step per §F3:
     *         `baseLifAsset = principal × LIF_BPS / BPS`, then
     *         `lifAsset = baseLifAsset × (BPS − d_borrower) / BPS`.
     * @dev    `d_borrower` is the borrower's effective hold-tier discount bps
     *         (0 without platform consent), clamped to `MAX_FEE_DISCOUNT_BPS`
     *         (50%). Resolved from the LIVE tier at the call — callers invoke
     *         it at ACCEPT so it is pinned at origination (no settle-time
     *         top-up gaming). No VPFI is moved: a pure direct reduction, NOT
     *         the retired peg-custody path. Shared by `_acceptOffer` (the
     *         charge) and `OfferPreviewFacet` (the quote), so those two agree to
     *         the wei — including the two-step rounding. The `OfferMatched`
     *         matcher-fee field is deliberately NOT computed from this helper:
     *         it logs the GROSS list-rate matcher slice (folding the discount in
     *         pushed `OfferMatchFacet` past EIP-170), so the actual matcher
     *         transfer on a HoldOnly-discounted fill is lower than the event
     *         reports — treat that field as a display-only upper bound, never
     *         the charged amount. The discount applies on LIQUID lending assets
     *         only (see `isLiquid`); illiquid loans pay the full LIF.
     * @param  borrower  The borrowing party whose tier is read.
     * @param  principal The loan principal in lending-asset wei.
     * @param  isLiquid  Whether the lending asset is liquid. The discount
     *                   applies ONLY on a liquid asset (illiquid loans pay the
     *                   full LIF — the legacy §6b posture); pass `false` to
     *                   force the un-discounted LIF.
     * @param  fullMode  #1347 — whether the borrower's per-party Full VPFI
     *                   tariff opt-in was CONFIRMED for this loan (kill-switch
     *                   on, `C* ≤ maxCStar`, vault funded). When true the
     *                   own-side discount is bumped by
     *                   `FULL_MODE_FEE_DISCOUNT_BONUS_BPS` (`+10%`) —
     *                   `min(d_hold + 1000, 5000)` (§F3) — on the liquid path
     *                   ONLY, and independent of `vpfiDiscountConsent` (the
     *                   Full opt-in is itself the consent). Callers pass `false`
     *                   whenever the Full opt-in was not confirmed (the dark
     *                   default, and every non-Full accept), so behaviour is
     *                   byte-identical to the pre-#1347 path.
     * @return lifAsset  The discounted LIF in lending-asset wei.
     */
    function holdOnlyBorrowerLif(
        address borrower,
        uint256 principal,
        bool isLiquid,
        bool fullMode
    ) internal view returns (uint256 lifAsset) {
        uint256 dBorrower;
        if (isLiquid && LibVaipakam.storageSlot().vpfiDiscountConsent[borrower]) {
            ( , uint16 effBps) = effectiveTierAndBps(borrower);
            dBorrower = uint256(effBps);
            if (dBorrower > LibVaipakam.MAX_FEE_DISCOUNT_BPS) {
                dBorrower = LibVaipakam.MAX_FEE_DISCOUNT_BPS;
            }
        }
        // #1347 §F3 — Full own-side bump: `min(d_hold + 1000, 5000)`, liquid
        // only (an illiquid loan pays full LIF and cannot be Full — it has no
        // numeraire price for `C*`). Applied on top of any hold-tier discount,
        // and even with no `vpfiDiscountConsent` (the Full opt-in is the
        // consent). `fullMode` is only ever true when the borrower's Full
        // opt-in is CONFIRMED, so the LIF bonus and the `C*` charge stay in
        // lockstep.
        if (fullMode && isLiquid) {
            dBorrower += LibVaipakam.FULL_MODE_FEE_DISCOUNT_BONUS_BPS;
            if (dBorrower > LibVaipakam.MAX_FEE_DISCOUNT_BPS) {
                dBorrower = LibVaipakam.MAX_FEE_DISCOUNT_BPS;
            }
        }
        // baseLifAsset = principal × LIF_BPS / BPS  (§F3)
        lifAsset = (principal * LibVaipakam.cfgLoanInitiationFeeBps()) /
            LibVaipakam.BASIS_POINTS;
        // discounted = baseLifAsset × (BPS − d_borrower) / BPS
        lifAsset = (lifAsset * (LibVaipakam.BASIS_POINTS - dBorrower)) /
            LibVaipakam.BASIS_POINTS;
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
     *                       amount actually pulled from borrower vault at
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

        // T-087 Sub 1.B — read EFFECTIVE_TIER from the ring-buffer
        // accumulator, NOT raw vault balance. The min-history gate
        // and min-tier-over-history clamp must apply here too;
        // otherwise a fresh wallet could quote a tier-4 LIF on Base
        // even though the discount path will refuse to apply
        // (Codex round-6 P1 #5).
        (tier, ) = effectiveTierAndBps(borrower);
        if (tier == 0) return (false, 0, 0);

        uint256 normalFee = (principal * LibVaipakam.cfgLoanInitiationFeeBps()) /
            LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 vpfi) = _feeAssetWeiToVpfi(principalAsset, normalFee);
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
     * @return vpfiRequired  VPFI (18 dec) the lender must hold in vault
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

        // #1354 (Codex r1 P2) — the VPFI-PAYMENT delivery DEBITS `loan.lender`'s
        // vault, so it requires that party's own platform consent. Settlement
        // hosts consolidate `loan.lender` to the CURRENT position-NFT holder
        // before quoting, so without this gate an unsolicited transfer of a
        // Full-stamped lender position could spend the (non-consenting)
        // recipient's VPFI. A Full lender WITHOUT consent still receives the
        // +10% bump — but only through the no-token-move direct-reduction path
        // ({directReductionYieldFee}), never a vault debit. This is a no-op for
        // the pre-existing hold path (callers only reached here with consent).
        if (!LibVaipakam.storageSlot().vpfiDiscountConsent[loan.lender]) {
            return (false, 0, 0);
        }

        // #1354 §F2 — total discount `min(d_hold + d_tariff, 5000)`: the
        // (consent-verified above) hold slice PLUS the +10% Full-tariff bump.
        avgBps = _effectiveYieldFeeDiscountBps(loan, true);
        if (avgBps == 0) return (false, 0, 0);

        // #957 (#921 item 6) — size the yield-fee VPFI requirement against the
        // loan's snapshotted treasury BPS so the discount matches the treasury
        // cut `splitTreasury` will actually charge at settlement.
        uint256 normalFee = (interestAmount *
            LibVaipakam.effectiveTreasuryFeeBps(loan)) / LibVaipakam.BASIS_POINTS;
        uint256 payBps = LibVaipakam.BASIS_POINTS - avgBps;
        uint256 tierFee = (normalFee * payBps) / LibVaipakam.BASIS_POINTS;

        (bool ok, uint256 vpfi) = _feeAssetWeiToVpfi(loan.principalAsset, tierFee);
        if (!ok) return (false, 0, 0);
        return (true, vpfi, avgBps);
    }

    // ─── Apply (mutating) ────────────────────────────────────────────────────

    /**
     * @notice Attempt to pay the borrower's FULL Loan Initiation Fee in
     *         VPFI out of the borrower's vault into Diamond custody
     *         (Phase 5 / §5.2b).
     *
     * @dev Phase 5 semantics: pays the FULL 0.1% LIF equivalent (not
     *      tier-discounted) in VPFI at init. The discount is delivered as
     *      a time-weighted rebate at proper settlement via
     *      {settleBorrowerLifProper}. Tier ≥ 1 gate prevents tier-0 users
     *      from paying VPFI with no expected rebate.
     *
     *      Silent fallback on any failure (tier-0, oracle gap, vault
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
     * @return vpfiDeducted  VPFI amount moved from borrower vault to
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
        address borrowerVault = s.userVaipakamVaults[borrower];
        if (borrowerVault == address(0)) return (false, 0);

        uint256 vaultBal = IERC20(vpfi).balanceOf(borrowerVault);
        if (vaultBal < vpfiRequired) return (false, 0);

        // T-054 PR-2 — clamp checkpoint balance against the tracked
        // counter so unsolicited dust isn't counted as stake.
        uint256 prevTracked = s.protocolTrackedVaultBalance[borrower][vpfi];
        uint256 newStakedBal = clampToTracked(
            vaultBal - vpfiRequired,
            prevTracked - vpfiRequired
        );

        // Withdraw VPFI from borrower's vault into Diamond custody (the
        // Diamond holds it until settlement splits it between rebate and
        // treasury). The withdraw reverts on insufficient balance /
        // vault misconfiguration; silent-fallback via the call wrapper.
        // #569 Codex #572 round-4 P2 — the encumbrance guard can now
        // revert this withdraw when the borrower's VPFI is locked as loan
        // collateral. The staking + discount checkpoints are therefore
        // stamped ONLY AFTER a successful withdraw (below), so the
        // silent-fallback path (`ok == false`) can't leave reward state
        // stamped as if VPFI had moved when the vault balance didn't
        // change.
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
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
        rollupUserDiscount(borrower, newStakedBal);

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

        // T-087 Sub 1.B — no rollup at settlement: EFFECTIVE_BPS is
        // an instantaneous read from the ring buffer (design §3 reuse
        // row), so settlement only needs to LOOK at the borrower's
        // current effective state, not mutate it. Dropping the rollup
        // here keeps the heavy lifecycle / nonce-bump path out of
        // every settlement facet's inlined bytecode (PrecloseFacet
        // would otherwise breach EIP-170).
        uint256 avgBps = borrowerTimeWeightedDiscountBps(loan);
        uint256 rebate = (held * avgBps) / LibVaipakam.BASIS_POINTS;
        if (rebate > held) rebate = held;
        uint256 treasuryShare = held - rebate;

        r.vpfiHeld = 0;
        r.rebateAmount = rebate;

        if (treasuryShare > 0) {
            // Range Orders Phase 1 — VPFI-path 1% LIF matcher kickback.
            // Per design §"1% match fee mechanic": when LIF flows to
            // treasury, 1% goes to the matcher recorded on the loan.
            // VPFI path kickback fires here at proper-close (rather
            // than at match) because the borrower's VPFI sits in
            // Diamond custody until terminal. Zero-matcher loans
            // (legacy pre-Phase-1) skip the split — full amount goes
            // to treasury.
            uint256 matcherCut = loan.matcher == address(0)
                ? 0
                : LibOfferMatch.matcherShareOf(treasuryShare);
            uint256 net = treasuryShare - matcherCut;
            if (matcherCut > 0) {
                SafeERC20.safeTransfer(IERC20(vpfi), loan.matcher, matcherCut);
            }
            if (net > 0) {
                LibFacet.transferToTreasury(vpfi, net);
            }
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
        // Range Orders Phase 1 — VPFI-path 1% LIF matcher kickback.
        // Default / HF-liquidation forfeits the full VPFI to treasury;
        // the matcher's slice still applies because LIF reaching
        // treasury is the trigger (per design §"1% match fee mechanic").
        // Zero-matcher loans (legacy) skip the split.
        address vpfi = s.vpfiToken;
        uint256 matcherCut = loan.matcher == address(0)
            ? 0
            : LibOfferMatch.matcherShareOf(held);
        uint256 net = held - matcherCut;
        if (matcherCut > 0) {
            SafeERC20.safeTransfer(IERC20(vpfi), loan.matcher, matcherCut);
        }
        if (net > 0) {
            LibFacet.transferToTreasury(vpfi, net);
        }
    }

    /**
     * @notice Attempt to pay the lender's time-weighted Yield-Fee discount
     *         in VPFI out of the lender's vault into the treasury.
     *
     * @dev On success, the lender keeps 100% of `interestAmount` in the
     *      lending asset (no full-rate treasury haircut) and the
     *      time-weighted-discounted treasury share is satisfied entirely
     *      in VPFI from the lender's vault. Silent fallback on any
     *      failure — quote unavailable, vault underfunded, oracle gap,
     *      zero-duration loan.
     *
     *      Caller must have verified `s.vpfiDiscountConsent[lender]`
     *      before invoking; consent is platform-level, not loan-level.
     *
     *      Ordering invariant: this function performs the lender's
     *      discount rollup BEFORE computing the quote and BEFORE
     *      checkpointing the staking accrual, so the closed period is
     *      attributed to the pre-mutation vault balance. Read-only
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
     * @return vpfiDeducted  VPFI moved from lender vault to treasury.
     */
    function tryApplyYieldFee(
        LibVaipakam.Loan storage loan,
        uint256 interestAmount
    ) internal returns (bool applied, uint256 vpfiDeducted) {
        address lender = loan.lender;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address vpfi = s.vpfiToken;
        address lenderVault = s.userVaipakamVaults[lender];
        if (lenderVault == address(0) || vpfi == address(0)) return (false, 0);

        // T-087 Sub 1.B — no pre-withdraw rollup. EFFECTIVE_BPS is an
        // instant read; the second rollup AFTER the withdraw at the
        // bottom of this function still captures the post-mutation
        // balance for the ring buffer + lifecycle bookkeeping.
        // Dropping this duplicate rollup keeps PrecloseFacet under
        // EIP-170.
        uint256 vaultBal = IERC20(vpfi).balanceOf(lenderVault);
        uint256 prevTracked = s.protocolTrackedVaultBalance[lender][vpfi];

        // Quote against the live accumulator + the loan's init
        // snapshot. This returns the time-weighted avg discount
        // for the window, not a live tier lookup.
        (bool canQuote, uint256 vpfiRequired, ) = quoteYieldFee(loan, interestAmount);
        if (!canQuote) return (false, 0);
        if (vaultBal < vpfiRequired) return (false, 0);
        // #1354 (Codex r3 P2) — require TRACKED coverage, not just the raw
        // vault balance. Since the Full tariff bump can make `quoteYieldFee`
        // return a positive `vpfiRequired` for a lender with little/no
        // protocol-tracked VPFI, unsolicited VPFI dust sent directly to the
        // vault could satisfy the raw `vaultBal` check above while
        // `prevTracked < vpfiRequired` — underflowing `prevTracked - vpfiRequired`
        // below and reverting settlement instead of falling back to the
        // no-token-move direct-reduction bump. Bail to the fallback here.
        if (prevTracked < vpfiRequired) return (false, 0);

        // 3. Checkpoint staking accrual at the post-mutation balance.
        //    Mirrors the pattern at every other vault-mutation site.
        //    Clamped against tracked-after-withdraw.
        uint256 newStakedBal = clampToTracked(
            vaultBal - vpfiRequired,
            prevTracked - vpfiRequired
        );

        // #569 Codex #572 round-4 P2 — stamp the staking + discount
        // checkpoints ONLY AFTER a successful withdraw. The encumbrance
        // guard can now revert this withdraw when the lender's VPFI is
        // locked as loan collateral; on that silent-fallback path
        // (`ok == false`) we must not leave reward state stamped as if
        // VPFI had moved.
        address treasury = LibFacet.getTreasury();
        (bool ok, ) = address(this).call(
            abi.encodeWithSelector(
                VaultFactoryFacet.vaultWithdrawERC20.selector,
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
        rollupUserDiscount(lender, newStakedBal);

        LibFacet.recordTreasuryAccrual(vpfi, vpfiRequired);
        return (true, vpfiRequired);
    }

    /**
     * @notice E-1 (#1203) — direct-reduction delivery of the lender yield-fee
     *         discount when no VPFI price source is configured.
     *
     * @dev The hold-tier discount (`effectiveTierAndBps` of `loan.lender`) is
     *      delivered as a REDUCTION of the lending-asset treasury fee instead
     *      of a VPFI vault payment, so vaulted VPFI carries day-one fee utility
     *      without the price peg being set. No token moves — the caller simply
     *      keeps `reduction` on the lender side and hands treasury the smaller
     *      remainder (`lenderShare += reduction; treasuryShare -= reduction`).
     *
     *      Returns the lending-asset amount to move from treasury to the
     *      lender. What it carries depends on the peg (see the body): peg-unset
     *      → the whole `min(d_hold + d_tariff, 5000)`; peg-set → only the paid
     *      `d_tariff` Full slice (the hold slice is VPFI-payment-authoritative
     *      when the peg is set). Returns `0` when the resulting slice is
     *      tier-0 / non-Full zero, or the fee is zero.
     *
     *      Consent handling (#1354): the hold slice is consent-gated INSIDE
     *      {_effectiveYieldFeeDiscountBps}, so a lender with no
     *      `vpfiDiscountConsent` contributes `d_hold = 0`. The call sites guard
     *      the whole attempt on {lenderYieldFeeEligible} (`consent OR lenderMode
     *      == Full`), and the VPFI-DEBIT path ({quoteYieldFee}) additionally
     *      requires consent — so a Full lender without consent, or a consenting
     *      Full lender who lacked free VPFI, always still receives the +10%
     *      here without any vault debit.
     *
     * @param loan             Live loan the yield fee settles against.
     * @param treasuryShareFull The full (undiscounted) lending-asset treasury
     *                          share for this settlement.
     * @return reduction        Lending-asset amount to shift treasury → lender.
     */
    function directReductionYieldFee(
        LibVaipakam.Loan storage loan,
        uint256 treasuryShareFull
    ) internal view returns (uint256 reduction) {
        if (treasuryShareFull == 0) return 0;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // This helper is only ever reached as the FALLBACK after the
        // VPFI-payment attempt ({tryApplyYieldFee}) did NOT apply, so delivering
        // here can never double-pay. What it delivers depends on the peg:
        //
        //  - Peg UNSET (Phase-1 launch posture, §F2): direct-reduction is the
        //    SOLE delivery, so it carries the whole discount — the consent-gated
        //    hold slice PLUS the +10% Full-tariff bump.
        //  - Peg SET: the VPFI-contingent HOLD slice is delivered only by the
        //    authoritative VPFI-payment path (holding VPFI is the peg-set
        //    model), so this fallback drops it. But the +10% Full-tariff slice
        //    is a PAID entitlement (the lender already paid `C*`), NOT contingent
        //    on holding VPFI, so it MUST still be honored here whenever
        //    VPFI-payment couldn't run — whether because the lender has no
        //    consent (#1354 Codex r1 P2) OR because a consenting Full lender
        //    lacked enough free VPFI to pay the discounted fee (#1354 Codex r2
        //    P2). Otherwise a Full lender would be WORSE off for consenting.
        //
        // Keyed on the config fields directly (not `canQuote`, which is also
        // false on a transient oracle gap even when the peg IS set).
        bool pegSet = s.vpfiDiscountWeiPerVpfi != 0 &&
            s.vpfiDiscountEthPriceAsset != address(0);
        // Peg-unset → whole discount (hold + tariff); peg-set → tariff slice
        // only (the hold slice is VPFI-payment-authoritative when the peg is
        // set — see the body comment above). `includeHold = !pegSet`.
        uint256 effBps = _effectiveYieldFeeDiscountBps(loan, !pegSet);
        if (effBps == 0) return 0;
        reduction = (treasuryShareFull * effBps) / LibVaipakam.BASIS_POINTS;
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
    function _feeAssetWeiToVpfi(
        address feeAsset,
        uint256 feeAmountInAssetWei
    ) private view returns (bool canQuote, uint256 vpfiRequired) {
        if (feeAsset == address(0) || feeAmountInAssetWei == 0) return (false, 0);

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 weiPerVpfi = s.vpfiDiscountWeiPerVpfi;
        address ethRefAsset = s.vpfiDiscountEthPriceAsset;
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
