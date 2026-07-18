// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {InteractionRewardsLensFacet} from "../src/facets/InteractionRewardsLensFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/// @title  InteractionRewardDailyCapTest
/// @notice #1008 (S13, Option B) — the §4 daily cap is a PER-DAY property, but
///         the entry claim used to telescope over the whole window and cap once
///         (`min(Σ raw, Σ cap)`), letting a high-share quiet day net against
///         under-cap days. Option B bakes the per-day cap into the global
///         `cumMin*Rpn18` cumulative at finalization, so the claim reads
///         `Σ_d min(Δ_d, T_d)` — the per-day min — while staying O(1).
///
///         These tests drive the ENTRY path (seeded reward entry + per-day
///         globals + per-day thresholds via the test mutator) and assert the
///         per-day cap is enforced and that netting across days is closed.
contract InteractionRewardDailyCapTest is SetupTest {
    VPFIToken internal vpfi;
    address internal rewardLender = makeAddr("s13-rewardLender");

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;

    function setUp() public {
        setupHelper();

        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfi = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        uint256 have = vpfi.balanceOf(address(this));
        if (DIAMOND_SEED > have) vpfi.mint(address(this), DIAMOND_SEED - have);
        vpfi.transfer(address(diamond), DIAMOND_SEED);

        _facet().setInteractionLaunchTimestamp(block.timestamp);
        // Warp so days 1 + 2 are in the finalized past.
        vm.warp(block.timestamp + 5 days);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    ///  #1306 follow-up — read-only lens accessor (getters moved off
    ///      InteractionRewardsFacet into InteractionRewardsLensFacet).
    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Seed a CLOSED rewardLender entry for `rewardLender` spanning `[1, 3)` (days 1+2)
    ///      with per-day numeraire `P`, plus the day-1/day-2 global rewardLender
    ///      denominators and per-day cap thresholds. Returns `(delta1, delta2)`
    ///      = the per-day RPN Δ_d.
    function _seed(
        uint256 perDay,
        uint256 g1,
        uint256 g2,
        uint256 t1,
        uint256 t2
    ) internal returns (uint256 half, uint256 d1, uint256 d2) {
        half = _lens().getInteractionHalfPoolForDay(1);
        // Day 1 + 2 finalized globals (borrower side left 0 — rewardLender-only test).
        _mut().setKnownGlobalDailyInterest(1, g1, 0, true);
        _mut().setKnownGlobalDailyInterest(2, g2, 0, true);
        _mut().setDayCapThreshold18(1, t1);
        _mut().setDayCapThreshold18(2, t2);
        d1 = (half * 1e18) / g1;
        d2 = (half * 1e18) / g2;

        uint256 id = _mut().pushRewardEntry(
            rewardLender, 1, LibVaipakam.RewardSide.Lender, perDay, 1
        );
        _mut().closeRewardEntryRaw(id, 3); // endDay = 3 ⇒ accrues days 1 + 2
    }

    /// The load-bearing test: day 1 is far over cap, day 2 is under cap. The
    /// per-day cap pays `min(raw1,cap) + raw2`, strictly LESS than the old
    /// window cap `min(raw1+raw2, 2·cap)` — the quiet-day headroom no longer
    /// absorbs the over-cap day.
    function test_PerDayCap_NettingIsClosed() public {
        uint256 P = 1e18;
        uint256 half = _lens().getInteractionHalfPoolForDay(1);
        // Δ1 = half/half = 1e18 (day 1); Δ2 = half/(4·half) = 0.25e18 (day 2).
        // T = 0.5e18: day 1 bites (1e18 > 0.5e18), day 2 under (0.25e18 < 0.5e18).
        uint256 T = 0.5e18;
        (, uint256 d1, uint256 d2) = _seed(P, half, 4 * half, T, T);
        assertEq(d1, 1e18, "delta1");
        assertEq(d2, 0.25e18, "delta2");

        uint256 balBefore = vpfi.balanceOf(rewardLender);
        vm.prank(rewardLender);
        (uint256 paid,,) = _facet().claimInteractionRewards();

        // Per-day: min(Δ1,T) + min(Δ2,T) = 0.5e18 + 0.25e18 = 0.75e18.
        uint256 expectedPerDay = (P * (T + d2)) / 1e18;
        // Old window behaviour: min(Δ1+Δ2, 2·T) = min(1.25e18, 1e18) = 1e18.
        uint256 oldWindow = (P * ((d1 + d2) < (2 * T) ? (d1 + d2) : (2 * T))) / 1e18;

        assertEq(paid, expectedPerDay, "per-day capped total");
        assertEq(vpfi.balanceOf(rewardLender) - balBefore, expectedPerDay, "paid out");
        assertLt(paid, oldWindow, "netting is closed: pays less than the window cap");
    }

    /// When every day is under the cap, the per-day walk equals the uncapped
    /// telescoped total exactly (cumMin == cumRpn over the window).
    function test_AllDaysUnderCap_EqualsUncapped() public {
        uint256 P = 1e18;
        uint256 half = _lens().getInteractionHalfPoolForDay(1);
        // Δ1 = Δ2 = 0.25e18, T = 1e18 (never bites).
        (, uint256 d1, uint256 d2) = _seed(P, 4 * half, 4 * half, 1e18, 1e18);
        vm.prank(rewardLender);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, (P * (d1 + d2)) / 1e18, "uncapped telescoped total");
    }

    /// A disabled-cap day (threshold == max sentinel) contributes its full
    /// uncapped Δ — cumMin tracks cumRpn.
    function test_DisabledThreshold_EqualsUncapped() public {
        uint256 P = 1e18;
        uint256 half = _lens().getInteractionHalfPoolForDay(1);
        // Day 1 would bite at a finite T, but the sentinel disables it.
        (, uint256 d1, uint256 d2) =
            _seed(P, half, 4 * half, type(uint256).max, type(uint256).max);
        vm.prank(rewardLender);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, (P * (d1 + d2)) / 1e18, "disabled cap = uncapped");
    }

    /// All days over the cap ⇒ every day saturates to T, so the total is
    /// `P·T·daysInWindow / 1e18` (matches the old window cap in this degenerate
    /// case).
    function test_AllDaysOverCap_SaturatesEachDay() public {
        uint256 P = 1e18;
        uint256 half = _lens().getInteractionHalfPoolForDay(1);
        uint256 T = 0.1e18; // both Δ (1e18, 0.25e18) exceed T
        _seed(P, half, 4 * half, T, T);
        vm.prank(rewardLender);
        (uint256 paid,,) = _facet().claimInteractionRewards();
        assertEq(paid, (P * (2 * T)) / 1e18, "each day saturated at T");
    }
}
