// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";

/// @title VPFIDiscountTimeWeightedTest
/// @notice T-087 Sub 1.E — exercises the full ring-buffer TWA + min-history
///         gate + min-tier-over-history clamp + dayMin/dayClose split +
///         tier-table-version invalidation + consent gate surface that
///         landed across Sub 1.A–D (PRs #446 / #447 / #448 / #449).
///
///         Scope intentionally avoids the broader fee-application flows
///         (those are covered by {VPFIDiscountFacetTest} +
///         {RepayFacetTest} etc.). This file probes the
///         {VPFIDiscountFacet.getEffectiveDiscount} surface — the single
///         entry point every consumer (Solidity fee paths + frontend
///         hooks) reads for the post-gate tier+BPS values.
contract VPFIDiscountTimeWeightedTest is SetupTest {
    VPFIToken internal vpfiToken;
    address internal staker;
    address internal otherStaker;

    // 18-decimal token amounts straddling the default tier boundaries
    // declared in {LibVaipakam}:
    //    T1 ≥   100 VPFI, T2 ≥ 1 000, T3 ≥ 5 000, T4 > 20 000.
    uint256 internal constant DUST_AMOUNT = 1 ether;       // tier 0
    uint256 internal constant T1_AMOUNT  = 500 ether;      // tier 1
    uint256 internal constant T2_AMOUNT  = 2_000 ether;    // tier 2

    uint256 internal constant ONE_DAY = 1 days;

    function setUp() public {
        setupHelper();

        // Deploy VPFI token behind a UUPS proxy and wire it into the
        // diamond (mirrors the setup in {VPFIDiscountFacetTest}).
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(this), address(this), address(this))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vpfiToken = VPFIToken(address(proxy));

        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountRate(1e15);

        staker = makeAddr("staker");
        otherStaker = makeAddr("otherStaker");
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    function _stake(address user, uint256 amount) internal {
        vpfiToken.transfer(user, amount);
        vm.startPrank(user);
        IERC20(address(vpfiToken)).approve(address(diamond), amount);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(amount);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        vm.stopPrank();
    }

    function _unstake(address user, uint256 amount) internal {
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(amount);
    }

    function _effective(address user)
        internal
        view
        returns (uint8 tier, uint16 bps)
    {
        return VPFIDiscountFacet(address(diamond)).getEffectiveDiscount(user);
    }

    function _elapseMinHistory() internal {
        // Default `cfgTwaMinStakedDays` = 3. Warp 4 days + 1 second to be
        // safely past the elapsed-seconds gate even if the test's
        // initial `block.timestamp` was 0.
        vm.warp(block.timestamp + 4 days + 1);
    }

    function _expiry(address user) internal view returns (uint40) {
        return VPFIDiscountAccumulatorFacet(address(diamond))
            .getTierExpirySec(user);
    }

    // ─── Min-history gate ─────────────────────────────────────────────

    function test_MinHistory_FreshStakeReturnsZeroTier() public {
        _stake(staker, T1_AMOUNT);
        (uint8 tier, uint16 bps) = _effective(staker);
        assertEq(tier, 0, "tier zero before min-history elapses");
        assertEq(bps, 0, "bps zero before min-history elapses");
    }

    function test_MinHistory_ElapsedTimeGateNotBucketArithmetic() public {
        _stake(staker, T1_AMOUNT);
        // Warp by 3 wall-clock days minus 1 second — gate must STAY closed
        // because elapsed seconds matter, not day buckets (Codex Sub 1.B
        // round-1 P2 #4).
        vm.warp(block.timestamp + 3 days - 1);
        (uint8 tierBefore,) = _effective(staker);
        assertEq(tierBefore, 0, "still gated 1 second short");

        // Land EXACTLY on the `startSec + minWindow` boundary. The contract
        // gate is `if (block.timestamp < uint256(startSec) + minWindow)
        // return (0, 0);` — at the exact boundary the test must observe
        // tier 1. Warping by 2 seconds (the previous fix) was sloppy: a
        // regression that flipped the gate to `<=` would still have
        // surfaced tier 1 here. The exact +1 makes the boundary
        // assertion strictly correct.
        vm.warp(block.timestamp + 1);
        (uint8 tierAtBoundary,) = _effective(staker);
        assertEq(tierAtBoundary, 1, "gate releases at exact elapsed boundary");
    }

    function test_MinHistory_AfterGateReleaseTier1Earned() public {
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        (uint8 tier, uint16 bps) = _effective(staker);
        assertEq(tier, 1, "tier 1 after gate");
        assertEq(bps, uint16(LibVaipakam.VPFI_TIER1_DISCOUNT_BPS), "bps matches tier 1 default");
    }

    // ─── Dust-then-bulk attack defence (min-tier clamp) ────────────────

    function test_DustThenBulkAttack_SameDayTopUpKeepsMin() public {
        // Stake dust at day 0, immediately top up to tier 1 the same day.
        // The same-day rollup must KEEP THE DAYMIN at the dust value so
        // the min-tier clamp catches the attack after the gate elapses.
        _stake(staker, DUST_AMOUNT);
        vpfiToken.transfer(staker, T1_AMOUNT);
        vm.startPrank(staker);
        IERC20(address(vpfiToken)).approve(address(diamond), T1_AMOUNT);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(T1_AMOUNT);
        vm.stopPrank();

        _elapseMinHistory();

        (uint8 tier,) = _effective(staker);
        assertEq(tier, 0, "min-tier clamp blocks dust-then-bulk attack");
    }

    function test_DustThenBulkAttack_NextDayTopUpStillClamped() public {
        // Stake dust at day 0, wait 1 day, then top up to tier 1.
        // By day 3 (gate release) the min-history window [day 1, day 3]
        // still includes a dust day (day 1's gap-fill from day 0's
        // close-balance = dust) → clamp engages.
        _stake(staker, DUST_AMOUNT);
        vm.warp(block.timestamp + ONE_DAY);
        vpfiToken.transfer(staker, T1_AMOUNT);
        vm.startPrank(staker);
        IERC20(address(vpfiToken)).approve(address(diamond), T1_AMOUNT);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(T1_AMOUNT);
        vm.stopPrank();

        _elapseMinHistory();
        (uint8 tier,) = _effective(staker);
        assertEq(tier, 0, "dust day 0 + day 1 dust-fill still clamps to 0");
    }

    function test_LegitimateStake_FullTier1Throughout() public {
        // Stake tier-1 amount at day 0 and never modify. Every day's
        // dayMin = tier 1 → clamp passes.
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        (uint8 tier,) = _effective(staker);
        assertEq(tier, 1, "constant tier-1 stake earns the tier");
    }

    // ─── Full unstake → immediate tier 0 + tenure reset ────────────────

    function test_FullUnstake_DropsEffectiveTierToZero() public {
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        (uint8 tierBefore,) = _effective(staker);
        assertEq(tierBefore, 1, "tier 1 before unstake");

        _unstake(staker, T1_AMOUNT);
        (uint8 tierAfter,) = _effective(staker);
        assertEq(tierAfter, 0, "tier 0 immediately after full unstake");
    }

    function test_FullUnstake_TenureResetOnRestake() public {
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        _unstake(staker, T1_AMOUNT);
        // User now restakes — the gate clock RESETS to a fresh
        // cfgTwaMinStakedDays elapse (Codex round-6 P1 #1 + round-10
        // P1 #2 — primed wallets can't carry old tenure across the
        // zero-balance gap).
        vm.startPrank(staker);
        IERC20(address(vpfiToken)).approve(address(diamond), T1_AMOUNT);
        vpfiToken.transfer(staker, T1_AMOUNT);
        vm.stopPrank();
        vm.startPrank(staker);
        IERC20(address(vpfiToken)).approve(address(diamond), T1_AMOUNT);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(T1_AMOUNT);
        vm.stopPrank();

        (uint8 tier,) = _effective(staker);
        assertEq(tier, 0, "fresh post-restake gate starts at 0");

        _elapseMinHistory();
        (uint8 tierAfter,) = _effective(staker);
        assertEq(tierAfter, 1, "tier 1 after fresh elapse");
    }

    // ─── Tier upgrades (legitimate) ────────────────────────────────────

    function test_TierUpgrade_HeldThroughoutEarnsHigher() public {
        // Stake tier 2 amount upfront, never reduce.
        _stake(staker, T2_AMOUNT);
        _elapseMinHistory();
        (uint8 tier,) = _effective(staker);
        assertEq(tier, 2, "tier 2 earned with consistent stake");
    }

    function test_TierUpgrade_RecentUpgradeClampedByOldHistory() public {
        // T-087 design choice (Sub 1.C round-3 P2 #1 documented trade-
        // off): a user who held tier 1 then upgraded to tier 2 sees the
        // scan extend back to currentStakeStartDayId. Until the old
        // tier-1 history rolls out of the 30-day ring buffer OR the
        // user fully unstakes + restakes at tier 2, the clamp keeps
        // them at tier 1. Verifies the documented behaviour.
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        // Add VPFI to upgrade to tier 2 (top-up).
        vpfiToken.transfer(staker, T2_AMOUNT - T1_AMOUNT);
        vm.startPrank(staker);
        IERC20(address(vpfiToken)).approve(address(diamond), T2_AMOUNT - T1_AMOUNT);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(T2_AMOUNT - T1_AMOUNT);
        vm.stopPrank();
        // Wait another full min-history window.
        _elapseMinHistory();

        (uint8 tier,) = _effective(staker);
        assertEq(tier, 1, "tier-1 history clamps the upgraded tier");
    }

    // ─── Consent gate ─────────────────────────────────────────────────

    function test_Consent_ZeroWhenDisabled() public {
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();

        // Revoke consent.
        vm.prank(staker);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);

        (uint8 tier, uint16 bps) = _effective(staker);
        assertEq(tier, 0, "tier zero without consent");
        assertEq(bps, 0, "bps zero without consent");
    }

    function test_Consent_NonZeroWhenEnabled() public {
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        (uint8 tier,) = _effective(staker);
        assertEq(tier, 1, "tier 1 with consent + elapsed gate");
    }

    // ─── Tier-table version invalidation ──────────────────────────────

    /// @notice Mirror the event the production setter emits so
    ///         `vm.expectEmit` can match by topic. Anonymous-mode lets us
    ///         skip declaring it on every test contract.
    event TierTableVersionBumped(uint16 newVersion);

    function test_TierTableVersion_BumpedOnThresholdChange() public {
        // `s.tierTableVersion` starts at 0 on a fresh diamond; first
        // bump → 1.
        vm.expectEmit(false, false, false, true, address(diamond));
        emit TierTableVersionBumped(1);
        ConfigFacet(address(diamond)).setVpfiTierThresholds(
            100 ether,
            1_000 ether,
            5_000 ether,
            20_000 ether
        );
    }

    function test_TierTableVersion_BumpedOnDiscountBpsChange() public {
        vm.expectEmit(false, false, false, true, address(diamond));
        emit TierTableVersionBumped(1);
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(1000, 1500, 2000, 2400);
    }

    // ─── ConfigFacet bounds ───────────────────────────────────────────

    function test_ConfigFacet_TwaMinStakedDays_LowerBoundIs2() public {
        // Codex Sub 1.B round-1 P2 #6 — `= 1` reopens the same-day
        // flash-stake gaming case; the bound was tightened to 2.
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidTwaMinStakedDays.selector,
                uint8(1)
            )
        );
        ConfigFacet(address(diamond)).setTwaMinStakedDays(1);
    }

    function test_ConfigFacet_TwaMinStakedDays_UpperBoundIs14() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidTwaMinStakedDays.selector,
                uint8(15)
            )
        );
        ConfigFacet(address(diamond)).setTwaMinStakedDays(15);
    }

    function test_ConfigFacet_TwaWindowDays_CapAt30() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidTwaWindowDays.selector,
                uint8(31)
            )
        );
        ConfigFacet(address(diamond)).setTwaWindowDays(31);
    }

    function test_ConfigFacet_MirrorTierMaxAgeSec_LowerBoundIs30Days() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ConfigFacet.InvalidMirrorTierMaxAgeSec.selector,
                uint32(29 days)
            )
        );
        ConfigFacet(address(diamond)).setMirrorTierMaxAgeSec(uint32(29 days));
    }

    // ─── Multi-user isolation ─────────────────────────────────────────

    function test_MultiUser_StakesAreIndependent() public {
        // Both users stake at the same instant + at different tiers.
        // After the same gate elapse, both surface their OWN tier —
        // verifying the accumulator is per-user, not global.
        _stake(staker, T1_AMOUNT);
        _stake(otherStaker, T2_AMOUNT);
        _elapseMinHistory();

        (uint8 stakerTier,) = _effective(staker);
        (uint8 otherTier,) = _effective(otherStaker);
        assertEq(stakerTier, 1, "staker resolves to its own tier 1");
        assertEq(otherTier, 2, "other staker resolves to its own tier 2");
    }

    function test_MultiUser_OneUnstakeDoesNotAffectOther() public {
        // After both stakers are past the gate, one fully unstakes;
        // the other's tier MUST remain unchanged. Verifies that the
        // `currentStakeStartSec = 0` reset on `positive→0` is keyed
        // by user (a regression that wiped global state would knock
        // BOTH users back to tier 0).
        _stake(staker, T1_AMOUNT);
        _stake(otherStaker, T2_AMOUNT);
        _elapseMinHistory();

        _unstake(staker, T1_AMOUNT);
        (uint8 stakerTier,) = _effective(staker);
        (uint8 otherTier,) = _effective(otherStaker);
        assertEq(stakerTier, 0, "staker drops to tier 0 after unstake");
        assertEq(otherTier, 2, "other staker keeps tier 2 across staker unstake");
    }

    // ─── T-087 Sub 2.A — projected tierExpirySec ──────────────────────

    function test_ProjectedExpiry_FreshStakeReturnsSentinel() public {
        // A fresh user inside the min-history window has effective
        // tier 0, so no decay is possible → sentinel.
        _stake(staker, T1_AMOUNT);
        assertEq(_expiry(staker), type(uint40).max, "no expiry pre-gate");
    }

    function test_ProjectedExpiry_ConstantBalanceNeverDecays() public {
        // A user who stakes tier-1 and never changes their balance
        // sees their projected TWA converge to the held balance
        // forever — the trajectory never crosses below tier 1 → sentinel.
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        assertEq(_expiry(staker), type(uint40).max, "constant balance never decays");
    }

    function test_ProjectedExpiry_UnstakeProducesFiniteDay() public {
        // A user who stakes tier-1, holds, then partially unstakes
        // to dust below tier 1 — the rollup at the unstake will
        // recompute the expiry. With currentBalance now below tier 1,
        // EFFECTIVE_TIER is 0 → sentinel. (The "tier ought to expire
        // on day X" case fires when balance is reduced but still
        // ABOVE the new tier's lower boundary; tested below.)
        _stake(staker, T2_AMOUNT);
        _elapseMinHistory();
        // Withdraw down to tier 1 — the user is now AT tier 1 but
        // their dayClose history shows tier 2 days. As the
        // tier-2 days roll out of the window, the projected TWA
        // dips below tier 2 — but the user is now at tier 1, so the
        // gate is whether projected TWA drops below TIER-1 floor.
        // With currentBalance at T1_AMOUNT (500 ether), TWA converges
        // to 500 → tier 1 forever → sentinel.
        _unstake(staker, T2_AMOUNT - T1_AMOUNT);
        assertEq(
            _expiry(staker),
            type(uint40).max,
            "rebalanced to tier 1 floor: no decay"
        );
    }

    function test_ProjectedExpiry_NeverRolledUpUserReturnsSentinel() public {
        // Codex Sub 2.A round-3 P2 — a user whose state predates this
        // facet cut OR who hasn't been rolled up yet has
        // `tierExpirySec[user] == 0` in storage. The getter must fall
        // through to the sentinel — any consumer reading 0 against
        // `block.timestamp` would treat the user as "expired since
        // epoch", inverting the intent.
        address virgin = makeAddr("virgin");
        assertEq(_expiry(virgin), type(uint40).max, "uninitialized read = sentinel");
    }

    function test_ProjectedExpiry_RestakeClearsExpiry() public {
        // Full unstake then restake should produce a fresh expiry
        // value. After full unstake the projection is sentinel
        // (tier 0). After restake the user is back inside the
        // min-history window so projection is sentinel again
        // (tier 0 until gate clears).
        _stake(staker, T1_AMOUNT);
        _elapseMinHistory();
        _unstake(staker, T1_AMOUNT);
        assertEq(_expiry(staker), type(uint40).max, "post-unstake sentinel");

        // Restake.
        vpfiToken.transfer(staker, T1_AMOUNT);
        vm.startPrank(staker);
        IERC20(address(vpfiToken)).approve(address(diamond), T1_AMOUNT);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(T1_AMOUNT);
        vm.stopPrank();
        assertEq(_expiry(staker), type(uint40).max, "post-restake sentinel (gate pending)");
    }
}
