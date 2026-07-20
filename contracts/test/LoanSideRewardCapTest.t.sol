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

/// @title  LoanSideRewardCapTest
/// @notice #1353 (M2 PR-5c) — the loan-side interaction-reward cap replaces the
///         #1008 per-entry ETH-ratio cap on POST-cutover (armed) reward days.
///         The ceiling is a per-(loanId, side) LIFETIME budget derived from the
///         Full tariff's notional `C*` stamped at open:
///
///           loanSideRewardCapOpen = ½ × C* × (BPS − m_reward) / BPS   (at open)
///           loanSideRewardCapEff  = capOpen × min(rewardedDays, openDays)
///                                           / openDays                (at claim)
///
///         Everything is gated on `_isArmedDay` (the ShareOfPool arming = D*):
///         while unarmed the cap is a NO-OP and the pre-cutover #1008 regime is
///         untouched (proven by the other reward suites). These tests arm D*,
///         stamp the ShareOfPool day pools + globals directly (via the test
///         mutator, bypassing the governor finalize flow), disable #1008, and
///         assert the claim is trimmed to the loan-side ceiling.
contract LoanSideRewardCapTest is SetupTest {
    VPFIToken internal vpfi;
    address internal rewardLender = makeAddr("pr5c-rewardLender");

    uint256 internal constant DIAMOND_SEED = 100_000_000 ether;
    uint256 internal constant LOAN_ID = 7;

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
        // Warp so days 1 + 2 are finalized past.
        vm.warp(block.timestamp + 5 days);
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _lens() internal view returns (InteractionRewardsLensFacet) {
        return InteractionRewardsLensFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    /// @dev Seed one armed reward day: stamp its ShareOfPool composition
    ///      (`scheduleFloor = 2·freshHalf`, no recycled), the finalized global
    ///      lender denominator, and DISABLE #1008 for the day so only the
    ///      loan-side cap can trim. Returns Δ_d = freshHalf·1e18/global.
    function _seedArmedDay(
        uint256 dayId,
        uint256 freshHalf,
        uint256 global
    ) internal returns (uint256 deltaRpn) {
        _mut().setDayPoolStampRaw(dayId, uint128(freshHalf * 2), 0);
        _mut().setKnownGlobalDailyInterest(dayId, global, 0, true);
        _mut().setDayCapThreshold18(dayId, type(uint256).max); // #1008 off
        deltaRpn = (freshHalf * 1e18) / global;
    }

    /// @dev Seed an armed day with BOTH a fresh (`scheduleFloor`) and a recycled
    ///      (`recycledBudget`) half, so a reward has a recycled component the cap
    ///      must also bound. Δ_fresh + Δ_recycled per 1e18 numeraire.
    function _seedArmedDayWithRecycled(
        uint256 dayId,
        uint256 freshHalf,
        uint256 recycledHalf,
        uint256 global
    ) internal {
        _mut().setDayPoolStampRaw(
            dayId, uint128(freshHalf * 2), uint128(recycledHalf * 2)
        );
        _mut().setKnownGlobalDailyInterest(dayId, global, 0, true);
        _mut().setDayCapThreshold18(dayId, type(uint256).max); // #1008 off
    }

    /// @dev Stamp a fee-entitlement record carrying a known loan-side ceiling.
    function _stampCap(uint256 openDays, uint256 capOpen) internal {
        _mut().setFeeEntitlementRaw(
            LOAN_ID,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: uint32(openDays),
                rewardHaircutBpsAtOpen: 200,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: capOpen * 2, // any non-zero notional; cap read from cache
                loanSideRewardCapOpen: uint128(capOpen)
            })
        );
    }

    /// @dev Push a CLOSED lender entry on LOAN_ID spanning `[startDay, endDay)`.
    function _pushEntry(uint256 perDay, uint32 startDay, uint32 endDay)
        internal
        returns (uint256 id)
    {
        id = _mut().pushRewardEntry(
            rewardLender, uint64(LOAN_ID), LibVaipakam.RewardSide.Lender, perDay, startDay
        );
        _mut().closeRewardEntryRaw(id, endDay);
    }

    // ── The core enforcement: an armed claim is trimmed to the flat ceiling ──

    function test_ArmedClaim_TrimmedToLoanSideCap() public {
        // Δ1 = Δ2 = 1e18, perDay 1e18 ⇒ raw reward = 2e18 across the 2-day window.
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1); // D* = day 1 ⇒ both armed
        _pushEntry(1e18, 1, 3);

        // Full-term (openDays == window) so the proration factor is 1; the flat
        // ceiling 0.5e18 is the only binding constraint (raw would be 2e18).
        _stampCap({openDays: 2, capOpen: 0.5e18});

        uint256 balBefore = vpfi.balanceOf(rewardLender);
        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();

        assertEq(paid, 0.5e18, "claim trimmed to the loan-side ceiling");
        assertEq(vpfi.balanceOf(rewardLender) - balBefore, 0.5e18, "paid out");
    }

    // ── Early-close / partial-term proration binds before the flat ceiling ──

    function test_ArmedClaim_ProratesByRewardedDays() public {
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _pushEntry(1e18, 1, 3); // 2 rewarded days, raw 2e18

        // openDays 4 but only 2 rewarded ⇒ capEff = 3e18 × 2/4 = 1.5e18 < raw.
        _stampCap({openDays: 4, capOpen: 3e18});

        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertEq(paid, 1.5e18, "cap prorated to min(days,openDays)/openDays");
    }

    // ── Dark: an unarmed claim is uncapped (the #1008 regime is untouched) ──

    function test_UnarmedClaim_Uncapped() public {
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        // NO arming ⇒ pre-cutover ⇒ loan-side cap is a no-op even though a tiny
        // ceiling is stamped. But an unarmed day resolves its pool from
        // halfPoolForDay(), NOT the stamp, so seed the legacy half too.
        _pushEntry(1e18, 1, 3);
        _stampCap({openDays: 2, capOpen: 0.5e18});

        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        // Unarmed days derive the pool from halfPoolForDay(), so the raw reward
        // is whatever that pool yields — the load-bearing assertion is only that
        // the 0.5e18 loan-side ceiling did NOT bite (paid strictly exceeds it).
        assertGt(paid, 0.5e18, "loan-side cap does not bite while unarmed (dark)");
    }

    // ── Lifetime budget is SHARED across entries of the same (loanId, side) ──

    function test_ArmedClaim_LifetimeBudgetSharedAcrossEntries() public {
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        // Two adjacent single-day entries on the SAME loanId+side (a lender-sale
        // split shape): A = day 1, B = day 2, raw 1e18 each ⇒ 2e18 combined.
        _pushEntry(1e18, 1, 2); // [1,2) ⇒ day 1
        _pushEntry(1e18, 2, 3); // [2,3) ⇒ day 2

        // openDays 2, capOpen 1.2e18 ⇒ full-term capEff 1.2e18 shared across both
        // entries (NOT 1.2e18 each). A takes min(1e18, 1.2×1/2)=0.6; B takes
        // min(1e18, 1.2×2/2 − 0.6)=0.6 ⇒ 1.2e18 total.
        _stampCap({openDays: 2, capOpen: 1.2e18});

        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertEq(paid, 1.2e18, "shared lifetime ceiling across the two entries");
    }

    // ── An UNSTAMPED loan (capOpen == 0) is NOT zeroed — the cap simply skips ──

    function test_ArmedClaim_UnstampedLoanUncapped() public {
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _pushEntry(1e18, 1, 3);
        // No fee-entitlement stamp ⇒ loanSideRewardCapOpen == 0. Such loans
        // (mirror-chain / dark-era / pre-cutover) are NOT reward-ineligible here
        // — the cap does not apply and they earn their full reward. True
        // reward-ineligibility (a canonical feed-fail origination) is enforced
        // upstream by not creating reward entries at all (Codex #1371 r1 P1 ×2).
        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertEq(paid, 2e18, "unstamped loan earns full reward (cap skips, not zeroes)");
    }

    // ── A STAMPED dust loan (even cStarOpen == 0) IS capped, not skipped ──

    function test_ArmedClaim_StampedDustCapZeroesArmedFresh() public {
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _pushEntry(1e18, 1, 3);
        // Stamp a genuinely-priced dust loan where BOTH `cStarOpen` and the cap
        // floor to 0. It is distinguished from an UNSTAMPED loan by `openDays !=
        // 0` (the stamp always writes openDays >= 1), NOT by `cStarOpen`, so the
        // cap applies and trims the armed-fresh payout to ~0 (Codex #1371 r5 P2).
        _mut().setFeeEntitlementRaw(
            LOAN_ID,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 2, // stamped (>= 1) — the unstamped marker is openDays == 0
                rewardHaircutBpsAtOpen: 200,
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0, // dust: list LIF floored to 0
                loanSideRewardCapOpen: 0 // ceiling rounds to 0
            })
        );
        // Fully capped ⇒ pays 0, but the claim SUCCEEDS (does not revert): the
        // entry is processed and its armed-fresh commitment retired, so a solo
        // zero-payout entry is not stranded/retried forever (Codex #1371 r6).
        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertEq(paid, 0, "stamped dust loan capped to 0 (claim clears it, no revert)");
    }

    // ── Legacy in-place-upgrade record (cStarOpen set, cap cache 0) is derived ──

    function test_ArmedClaim_LegacyRecordDerivesCapFromCStar() public {
        _seedArmedDay(1, 1e18, 1e18);
        _seedArmedDay(2, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _pushEntry(1e18, 1, 3); // raw reward 2e18

        // Simulate a record stamped by the parent (#1347) impl BEFORE the cap
        // cache slot existed: `cStarOpen` / `openDays` are set but
        // `loanSideRewardCapOpen` reads 0 (appended slot). The cap must be
        // DERIVED from `cStarOpen`, not treated as a real zero ceiling (Codex
        // #1371 r6). A legacy record also predates `rewardHaircutBpsAtOpen`, so
        // its 0 is defaulted to the 200-bps default, NOT read as a literal 0%
        // (Codex #1371 r7): cStarOpen 0.2e18, default 2% haircut ⇒ capOpen =
        // ½ × 0.2e18 × 0.98 = 0.098e18; full-term ⇒ capEff 0.098e18 < raw 2e18.
        _mut().setFeeEntitlementRaw(
            LOAN_ID,
            LibVaipakam.FeeEntitlement({
                borrowerMode: LibVaipakam.FeeEntitlementMode.None,
                lenderMode: LibVaipakam.FeeEntitlementMode.None,
                openDays: 2,
                rewardHaircutBpsAtOpen: 0, // legacy record never stamped a haircut ⇒ defaulted to 200
                borrowerTariffPaid: 0,
                lenderTariffPaid: 0,
                cStarOpen: 0.2e18, // real notional from the parent stamp
                loanSideRewardCapOpen: 0 // cache slot did not exist at parent-stamp time
            })
        );
        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertEq(paid, 0.098e18, "cap derived from cStarOpen + default haircut for a legacy record");
    }

    // ── Cutover-spanning entry: only the ARMED (post-D*) portion is capped ──

    function test_ArmedClaim_SpanningEntryCapsOnlyArmedPortion() public {
        // D* = day 2, so day 1 is PRE-cutover (uncapped, #1008 regime) and day 2
        // is armed. Only day 2's reward is loan-side-capped.
        _seedArmedDay(1, 1e18, 1e18); // pre-cutover; pool from stamp is ignored (unarmed)
        _seedArmedDay(2, 1e18, 1e18); // armed
        _mut().setGovernorCommitArmedFromDayRaw(2);
        _pushEntry(1e18, 1, 3); // [1,3): day 1 pre-D*, day 2 armed

        // openDays 2, capOpen 0.1e18. Armed slice = day 2 only (1 armed day).
        // capEff = 0.1e18 × min(1,2)/2 = 0.05e18. Day-1 pre-cutover reward stays.
        _stampCap({openDays: 2, capOpen: 0.1e18});

        // Day 1 pre-cutover reward: halfPoolForDay(1) (NOT the stamp, unarmed).
        uint256 day1 = _lens().getInteractionHalfPoolForDay(1);

        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        // Total = uncapped day-1 reward + capped day-2 slice (0.05e18).
        assertEq(paid, day1 + 0.05e18, "pre-cutover day uncapped; only armed day capped");
    }

    // ── The cap bounds the WHOLE armed reward, including the RECYCLED portion ──

    function test_ArmedClaim_CapsRecycledReward() public {
        // Day 1 armed with equal fresh + recycled halves: Δ_fresh = Δ_recycled =
        // 1e18, perDay 1e18 ⇒ armedFresh 1e18 + recycled 1e18 = 2e18 armed reward.
        _seedArmedDayWithRecycled(1, 1e18, 1e18, 1e18);
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _pushEntry(1e18, 1, 2); // [1,2): day 1 only

        // Ceiling 0.5e18 < fresh 1e18, so the recycled 1e18 is ENTIRELY capped
        // off (released, not paid). Before the r7 fix the recycled half escaped
        // the cap and the user would have received 0.5e18 fresh + 1e18 recycled
        // = 1.5e18, above the ½×C*×(1−m) ceiling (Codex #1371 r7 P1).
        _stampCap({openDays: 1, capOpen: 0.5e18});

        vm.prank(rewardLender);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertEq(paid, 0.5e18, "whole armed reward (fresh + recycled) capped to the ceiling");
    }

    // ── Legacy per-day window must NOT pay on armed days (entry-path only) ──

    function test_ArmedDay_LegacyWindowNotPaid() public {
        // Codex #1371 r4: a residual/fabricated legacy per-day counter on an
        // ARMED day must never pay via the legacy window — armed days settle
        // through the ShareOfPool entry path only, and #1008 is retired there.
        // With D* = 1 the seeded legacy day-1 counter is armed; the claim skips
        // (and clears) it and, with no reward entry, reverts — instead of paying
        // `halfPoolForDay(1)` as it would on an unarmed day.
        _mut().setGovernorCommitArmedFromDayRaw(1);
        _mut().setDailyLenderInterest(1, rewardLender, 100e18, 100e18);
        vm.prank(rewardLender);
        vm.expectRevert();
        _facet().claimInteractionRewards();
    }
}
