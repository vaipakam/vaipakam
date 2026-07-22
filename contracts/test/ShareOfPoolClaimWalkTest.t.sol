// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {RewardClaimFacet} from "../src/facets/RewardClaimFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title  ShareOfPoolClaimWalkTest
/// @notice #1351 (M2 PR-2, slice 2c) — the CLAIM-side day walk.
///
///         Slice 2b's suite covers the day primitive in isolation. This covers
///         what 2c adds on top: the claim routes ShareOfPool days THROUGH that
///         primitive, keeps pre-`D*` days on the O(1) window product, persists
///         its cursors between chunks, and never pays a day twice.
///
///         Seeding note: the cumulative RPN series is built LAZILY by the claim
///         from each day's stamp + global denominator, so these tests seed only
///         the day records — hand-seeding the cumulatives would move the cursor
///         without building the capped series the window product reads.
contract ShareOfPoolClaimWalkTest is SetupTest {
    VPFIToken internal vpfi;
    address internal alice = makeAddr("2c-alice");

    uint256 constant DIAMOND_SEED = 100_000_000 ether;
    uint64 constant LOAN = 91;

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

        InteractionRewardsFacet(address(diamond))
            .setInteractionLaunchTimestamp(block.timestamp);
        vm.warp(block.timestamp + 60 days); // many finalized past days
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev One ARMED (ShareOfPool) day where `alice` is the whole lender side:
    ///      fresh half 1e18 against a 1e18 global ⇒ Δ = 1e18, so an entry with
    ///      `perDay = 1e18` contributes exactly 1e18 on that day. `cap` is the
    ///      D1 `(user, side, day)` ceiling.
    function _armedDay(uint256 d, uint256 cap) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0); // freshHalf = 1e18
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max); // #1008 off
        _mut().setDayCapModeRaw(d, 1); // ShareOfPool
        _mut().setDayUserSideCapRaw(d, cap);
    }

    /// @dev A pre-cutover day, priced by the legacy O(1) window product.
    function _legacyDay(uint256 d) internal {
        _mut().setDayPoolStampRaw(d, uint128(2e18), 0);
        _mut().setKnownGlobalDailyInterest(d, 1e18, 0, true);
        _mut().setDayCapThreshold18(d, type(uint256).max);
    }

    /// @dev Loan-side ceiling deliberately non-binding: this suite is about the
    ///      D1 ceiling and the walk, not the #1353 loan-side cap.
    function _loanSideOpen(uint32 openDays) internal {
        _mut().setFeeEntitlementRaw(
            LOAN,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: openDays,
                rewardHaircutBpsAtOpen: 0,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0,
                loanSideRewardCapOpen: type(uint128).max
            })
        );
    }

    function _entry(uint32 startDay, uint32 endDay) internal returns (uint256) {
        uint256 id = _mut().pushRewardEntry(
            alice, LOAN, LibVaipakam.RewardSide.Lender, 1e18, startDay
        );
        _mut().closeRewardEntryRaw(id, endDay);
        return id;
    }

    function _claim() internal returns (uint256 paid) {
        vm.prank(alice);
        (paid, , ) = RewardClaimFacet(address(diamond)).claimInteractionRewards();
    }

    // ── The D1 ceiling binds THROUGH the claim ───────────────────────────────

    /// @dev The point of the slice: a claim over ShareOfPool days is bounded by
    ///      the per-`(user, side, day)` ceiling, not by the raw pool share.
    ///      Each day would contribute 1e18 uncapped; the ceiling is 0.4e18.
    function test_ClaimIsBoundedByTheDailyCeilingAcrossDays() public {
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        _entry(1, 3);

        assertEq(_claim(), 0.8e18, "each day trimmed to its own D1 ceiling");
    }

    // ── The owner-chosen hybrid: pre-D* days keep the O(1) product ───────────

    /// @dev A window spanning the cutover is paid by BOTH mechanisms exactly
    ///      once — the pre-`D*` day by the O(1) window product (uncapped by
    ///      D1), the armed day by the walk under its ceiling. The failure this
    ///      guards is either half being dropped or counted twice.
    ///
    ///      The legacy half is DERIVED from a control claim rather than
    ///      hardcoded: a pre-cutover day is priced from the real emission
    ///      schedule (`halfPoolForDay`), which the test cannot and should not
    ///      pin. `bob` claims the legacy day alone; `alice` claims the spanning
    ///      window. Alice must equal Bob plus exactly the armed ceiling.
    function test_SpanningWindowPaysEachRegimeExactlyOnce() public {
        _legacyDay(1); // pre-cutover, priced by the schedule
        _armedDay(2, 0.25e18); // armed, trimmed to its ceiling
        _mut().setGovernorCommitArmedFromDayRaw(2); // D* = 2
        _loanSideOpen(2);

        // Control: same shape, legacy day only.
        address bob = makeAddr("2c-bob");
        uint256 bobEntry = _mut().pushRewardEntry(
            bob, LOAN + 1, LibVaipakam.RewardSide.Lender, 1e18, 1
        );
        _mut().closeRewardEntryRaw(bobEntry, 2); // [1,2): the legacy day only

        _entry(1, 3); // alice: [1,3) spans the cutover

        vm.prank(bob);
        (uint256 legacyOnly, , ) =
            RewardClaimFacet(address(diamond)).claimInteractionRewards();
        uint256 spanning = _claim();

        assertGt(legacyOnly, 0, "the control really did pay (non-vacuous)");
        assertEq(
            spanning,
            legacyOnly + 0.25e18,
            "spanning = legacy half (unchanged) + armed half (ceiling-capped)"
        );
    }

    // ── Chunking: cursors persist, no day is paid twice ─────────────────────

    /// @dev A window longer than one chunk needs repeated claims. Each pays
    ///      only the days it walked and persists its cursor, so the totals sum
    ///      to the full entitlement with nothing double-paid or skipped. The
    ///      second claim is the double-pay guard: re-walking settled days would
    ///      surface as an over-payment.
    function test_ChunkedClaimNeverPaysADayTwice() public {
        uint256 chunk = LibVaipakam.MAX_INTERACTION_CLAIM_DAYS;
        uint256 span = chunk + 5;
        _mut().setGovernorCommitArmedFromDayRaw(1);
        for (uint256 d = 1; d <= span; ) {
            _armedDay(d, 0.5e18);
            unchecked { ++d; }
        }
        _loanSideOpen(uint32(span));
        _entry(1, uint32(span + 1));

        uint256 first = _claim();
        uint256 second = _claim();

        assertEq(first, chunk * 0.5e18, "first claim walks exactly one chunk");
        assertEq(second, 5 * 0.5e18, "second finishes the remaining days");
        assertEq(first + second, span * 0.5e18, "none paid twice, none skipped");
    }

    /// @dev A day whose ceiling is already fully drawn must ADVANCE with a zero
    ///      slice rather than stalling — otherwise the walk could never get
    ///      past it and every later day would be unreachable.
    function test_ExhaustedDayAdvancesInsteadOfStalling() public {
        _armedDay(1, 0.4e18);
        _armedDay(2, 0.4e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _loanSideOpen(2);
        // Day 1's ceiling is already spent by an earlier settlement.
        _mut().setUserSideDayPaidRaw(alice, 0, 1, 0.4e18);
        _entry(1, 3);

        assertEq(_claim(), 0.4e18, "day 1 pays 0; the walk still reaches day 2");
    }
}
