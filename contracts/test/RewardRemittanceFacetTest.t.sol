// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardIngressFacet} from "../src/facets/RewardIngressFacet.sol";
import {RewardRemittanceLensFacet} from "../src/facets/RewardRemittanceLensFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardCustodyFacet} from "../src/facets/RewardCustodyFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {LibRewardCustody} from "../src/libraries/LibRewardCustody.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MockCrossChainMessenger} from "./mocks/MockCrossChainMessenger.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";

/**
 * @title RewardRemittanceFacetTest — #776 PR1 (Base sender) unit coverage.
 * @notice Exercises the on-demand reward-budget remittance: the finalized
 *         per-chain slice math, idempotency, cap + auth + finalization gates,
 *         and the CCIP token-path send (delivered-vs-declared amount).
 */
contract RewardRemittanceFacetTest is SetupTest {
    RewardRemittanceFacet internal remit;
    RewardIngressFacet internal ingress;
    RewardRemittanceLensFacet rlens;
    MockRewardMessenger internal rewardMessenger; // data path (report/finalize)
    MockCrossChainMessenger internal ccip; // value path (token remittance)
    VPFIToken internal vpfiTok;

    uint32 internal constant CHAIN_BASE = 8453;
    uint32 internal constant CHAIN_ARB = 42161;
    uint32 internal constant CHAIN_OP = 10;

    uint256 internal constant CAP = 69_000_000 ether;

    address internal keeper = address(0xBEEF);
    address internal stranger = address(0xCAFE);

    function setUp() public {
        setupHelper();

        // VPFI token + fund the Base Diamond's pool.
        VPFIToken impl = new VPFIToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                VPFIToken.initialize,
                (address(this), address(this), address(this))
            )
        );
        vpfiTok = VPFIToken(address(proxy));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiTok));
        vpfiTok.mint(address(this), 100_000_000 ether);
        vpfiTok.transfer(address(diamond), 100_000_000 ether);

        // Reward mesh: canonical Base + data messenger + expected sources.
        rewardMessenger = new MockRewardMessenger(address(diamond));
        ccip = new MockCrossChainMessenger();
        remit = RewardRemittanceFacet(address(diamond));
        ingress = RewardIngressFacet(address(diamond));
        rlens = RewardRemittanceLensFacet(address(diamond));

        vm.chainId(CHAIN_BASE);
        RewardReporterFacet rep = RewardReporterFacet(address(diamond));
        rep.setBaseChainId(CHAIN_BASE);
        rep.setIsCanonicalRewardChain(true);
        rep.setRewardMessenger(address(rewardMessenger));
        // #776 — reward-budget rides the shared value-carrying
        // `crossChainMessenger` on its own dedicated reward-budget channel.
        TreasuryFacet(address(diamond)).setCrossChainMessenger(address(ccip));

        uint32[] memory chainIds = new uint32[](3);
        chainIds[0] = CHAIN_BASE;
        chainIds[1] = CHAIN_ARB;
        chainIds[2] = CHAIN_OP;
        RewardAggregatorFacet(address(diamond)).setExpectedSourceChainIds(chainIds);
        // #1566 slice 4 PR B — a canonical chain remits out of the custody
        // holder, bounded by what was funded: activate and fund the pool.
        activateRewardCustodyForTest(address(vpfiTok), 10_000_000 ether);

        vm.deal(address(this), 10 ether);
        vm.deal(keeper, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    // ─── helpers ──────────────────────────────────────────────────────────

    /// @dev Finalize day `d` with BASE/ARB/OP lender+borrower numerators.
    function _finalizeDay1() internal {
        rewardMessenger.deliverChainReport(CHAIN_BASE, 1, 10e18, 5e18);
        rewardMessenger.deliverChainReport(CHAIN_ARB, 1, 20e18, 10e18);
        rewardMessenger.deliverChainReport(CHAIN_OP, 1, 30e18, 15e18);
        RewardAggregatorFacet(address(diamond)).finalizeDay(1);
    }

    function _days(uint256 d) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = d;
    }

    /// @dev #1566 transport epochs PR 3b (Codex #2232 r2) — finalize a RANGE.
    ///      The fan-out bound now applies to the FILTERED day list, so a test
    ///      of that bound needs every day it names to survive the filters;
    ///      otherwise an unfinalized day is refused first and the test asserts
    ///      the wrong refusal, which is exactly what it did before this round.
    function _finalizeDays(uint256 n) internal {
        for (uint256 d = 1; d <= n; ++d) {
            rewardMessenger.deliverChainReport(CHAIN_BASE, d, 10e18, 5e18);
            rewardMessenger.deliverChainReport(CHAIN_ARB, d, 20e18, 10e18);
            rewardMessenger.deliverChainReport(CHAIN_OP, d, 30e18, 15e18);
            RewardAggregatorFacet(address(diamond)).finalizeDay(d);
        }
    }

    // ─── slice math ─────────────────────────────────────────────────────────

    function test_Quote_ComputesRoleAwareSlice() public {
        _finalizeDay1();
        uint256 half = LibInteractionRewards.halfPoolForDay(1);
        // #1008 (S13) — the cap is disabled here (no ETH feed ⇒ threshold=max),
        // so `min(Δ_d,T)=Δ_d`. The per-chain budget CEILs each side using the
        // SAME floored `Δ_d = half·1e18/global` the claim's cumMin uses (Codex
        // #1147 r5 I1 / r8 L7). global lender = 60e18, borrower = 30e18; ARB =
        // 20/60 + 10/30.
        uint256 dL = (half * 1e18) / 60e18;
        uint256 dB = (half * 1e18) / 30e18;
        uint256 expectedArb = _ceilDiv(dL * 20e18, 1e18) + _ceilDiv(dB * 10e18, 1e18);
        (uint256 total, uint256[] memory perDay) = remit.quoteRewardBudget(
            CHAIN_ARB,
            _days(1)
        );
        assertEq(total, expectedArb, "arb slice");
        assertEq(perDay[0], expectedArb, "perDay");
        assertGt(expectedArb, 0, "non-zero");
    }

    /// #1008 — ceiling division, mirrors `LibInteractionRewards._ceilDiv`.
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function test_Quote_DeduplicatesRepeatedDays() public {
        _finalizeDay1();
        (uint256 single, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        // Same day twice must NOT double-count — the send path marks the first
        // occurrence, so the quote counts day 1 exactly once.
        uint256[] memory dup = new uint256[](2);
        dup[0] = 1;
        dup[1] = 1;
        (uint256 total, uint256[] memory perDay) = remit.quoteRewardBudget(
            CHAIN_ARB,
            dup
        );
        assertEq(total, single, "duplicate day counted once");
        assertEq(perDay[0], single, "first occurrence carries the slice");
        assertEq(perDay[1], 0, "repeat contributes zero");
    }

    function test_QuoteRemittanceFee_ReturnsFeeAndTotal() public {
        _finalizeDay1();
        (uint256 expectedTotal, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        (uint256 fee, uint256 total) = remit.quoteRemittanceFee(CHAIN_ARB, _days(1));
        assertEq(total, expectedTotal, "total matches quoteRewardBudget");
        assertEq(fee, ccip.fee(), "fee routed through the messenger");
        assertGt(total, 0, "non-zero remittable total");
    }

    function test_QuoteRemittanceFee_ZeroWhenNothingRemittable() public {
        _finalizeDay1();
        // Remit day 1, then re-quote it — nothing left to send → (0, 0).
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
        (uint256 fee, uint256 total) = remit.quoteRemittanceFee(CHAIN_ARB, _days(1));
        assertEq(total, 0, "already-remitted day contributes 0");
        assertEq(fee, 0, "no fee when nothing to remit");
    }

    function test_QuoteRemittanceFee_RevertsOnUnfinalizedDay() public {
        _finalizeDay1();
        // Batch mixes finalized day 1 + unfinalized day 2 — must revert exactly
        // like remitRewardBudget, not silently drop day 2 and quote a fee.
        uint256[] memory d = new uint256[](2);
        d[0] = 1;
        d[1] = 2;
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.RewardDayNotFinalized.selector,
                uint256(2)
            )
        );
        remit.quoteRemittanceFee(CHAIN_ARB, d);
    }

    function test_QuoteRemittanceFee_RevertsWhenPoolNearlyExhausted() public {
        _finalizeDay1();
        (uint256 total, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        // Leave only (total - 1) of the pool → the quote's cap guard must fire,
        // matching remitRewardBudget's RewardPoolCapExceeded.
        TestMutatorFacet(address(diamond)).setInteractionPoolPaidOut(CAP - total + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.RewardPoolCapExceeded.selector,
                total,
                total - 1
            )
        );
        remit.quoteRemittanceFee(CHAIN_ARB, _days(1));
    }

    function test_Slices_SumToFullDayEmission() public {
        _finalizeDay1();
        uint256 half = LibInteractionRewards.halfPoolForDay(1);
        (uint256 base, ) = remit.quoteRewardBudget(CHAIN_BASE, _days(1));
        (uint256 arb, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        (uint256 op, ) = remit.quoteRewardBudget(CHAIN_OP, _days(1));
        uint256 sum = base + arb + op;
        // #1008 (S13) — Σ across chains ≈ both halves = the full day's emission,
        // within a bounded, ASYMMETRIC dust:
        //   - DOWN: the per-chain remittance uses the same floored `Δ_d =
        //     half·1e18/global` the claim uses; that floor loses up to
        //     `chainInterest/1e18` wei per side per chain, i.e. at most
        //     `Σ_chain chainInterest / 1e18 = globalInterest/1e18` per side.
        //   - UP: the per-side CEIL (I1 — never underfund a mirror) adds up to
        //     `#chains` wei per side.
        // globals: lender 60e18, borrower 30e18; 3 chains, 2 sides.
        uint256 downDust = (60e18 + 30e18) / 1e18; // 90
        uint256 upDust = 2 * 3; // per-side ceil × chains
        assertLe(sum, 2 * half + upDust, "never exceeds emission beyond ceil dust");
        assertApproxEqAbs(
            sum, 2 * half, downDust + upDust, "slices partition the pool (+/- dust)"
        );
    }

    // ─── happy path ─────────────────────────────────────────────────────────

    function test_Remit_SendsSliceOverCcipAndRecordsAccounting() public {
        _finalizeDay1();
        (uint256 expected, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));

        uint256 diamondBefore = vpfiTok.balanceOf(address(diamond));
        address holder = RewardCustodyFacet(address(diamond)).rewardCustodyHolder();
        uint256 holderBefore = vpfiTok.balanceOf(holder);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);

        // CCIP captured a single token-bearing send with the exact slice.
        assertEq(ccip.sentCount(), 1, "one send");
        ICrossChainMessenger.TokenAmount[] memory toks = ccip.sentTokens(0);
        assertEq(toks.length, 1, "one token");
        assertEq(toks[0].token, address(vpfiTok), "vpfi");
        assertEq(toks[0].amount, expected, "delivered == slice");

        // #1566 slice 4 PR B — VPFI leaves the custody HOLDER (through the
        // Diamond to the messenger in one transaction); the Diamond's own
        // balance is untouched. Accounting recorded.
        assertEq(vpfiTok.balanceOf(holder), holderBefore - expected, "holder debited");
        assertEq(vpfiTok.balanceOf(address(diamond)), diamondBefore, "diamond untouched");
        (, uint256 paidAfter) = RewardCustodyFacet(address(diamond)).armedFreshLedger();
        assertEq(paidAfter, expected, "the fresh share charged the delivered ledger");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), expected, "marked");
        assertEq(rlens.getRewardBudgetRemittedTotal(CHAIN_ARB), expected, "total");
        assertEq(rlens.getRewardBudgetRemittedGlobal(), expected, "global");
    }

    function test_Remit_RefundsFeeOverpayment() public {
        _finalizeDay1();
        uint256 balBefore = address(this).balance;
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
        // Mock fee is 0.001 ether; the rest refunds to the caller.
        assertEq(address(this).balance, balBefore - ccip.fee(), "surplus refunded");
    }

    // ─── idempotency ──────────────────────────────────────────────────────────

    function test_Remit_IsIdempotentPerChainDay() public {
        _finalizeDay1();
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
        // A second remit of the same (chain, day) has nothing un-remitted left.
        vm.expectRevert(RewardRemittanceFacet.NothingToRemit.selector);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
        // The global accounting did not double-count.
        uint256 expected = rlens.getRewardBudgetRemitted(CHAIN_ARB, 1);
        assertEq(rlens.getRewardBudgetRemittedGlobal(), expected, "no double count");
    }

    // ─── gates ────────────────────────────────────────────────────────────────

    function test_Remit_RevertsOnUnfinalizedDay() public {
        _finalizeDay1(); // day 1 finalized, day 2 is not
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.RewardDayNotFinalized.selector,
                uint256(2)
            )
        );
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(2), CAP);
    }

    function test_Remit_RevertsWhenTotalExceedsPerCallCap() public {
        _finalizeDay1();
        (uint256 expected, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.RemittanceExceedsCap.selector,
                expected,
                expected - 1
            )
        );
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), expected - 1);
    }

    function test_Remit_RevertsOnZeroCap() public {
        _finalizeDay1();
        vm.expectRevert(RewardRemittanceFacet.InvalidRemittanceCap.selector);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), 0);
    }

    function test_Remit_RevertsOnEmptyDayList() public {
        _finalizeDay1();
        vm.expectRevert(RewardRemittanceFacet.EmptyDayList.selector);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, new uint256[](0), CAP);
    }

    /// #1566 transport epochs PR 3b — the fan-out cap is a DESTINATION cost
    /// enforced at the SOURCE, because a transport payload is immutable: a
    /// mirror that refused an over-cap packet would refuse the same message on
    /// every re-execution. Straddled at the boundary, so the test pins the cap
    /// rather than merely the existence of a check.
    function test_Remit_RefusesADayListOverTheTransportFanoutCap() public {
        uint256 cap = LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP;
        // Every named day must SURVIVE the filters, because the bound is on
        // what the destination receives, not on what was asked for.
        _finalizeDays(cap + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TransportDayFanoutExceeded.selector,
                cap + 1,
                cap
            )
        );
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _dayList(cap + 1), CAP);

        // Exactly AT the cap the same call gets past this check. Asserted as
        // "not refused by the cap" rather than "succeeds": what the call does
        // next depends on which of those days are finalized, and pinning that
        // here would be pinning the remittance rather than the bound.
        (bool ok, bytes memory err) = address(remit).call{value: 1 ether}(
            abi.encodeCall(RewardRemittanceFacet.remitRewardBudget, (CHAIN_ARB, _dayList(cap), CAP))
        );
        if (!ok && err.length >= 4) {
            assertTrue(
                bytes4(err) != IVaipakamErrors.TransportDayFanoutExceeded.selector,
                "a list exactly at the cap is admitted by the cap"
            );
        }
    }

    /// #1566 transport epochs PR 3b (Codex #2232 r1) — the QUOTE refuses what
    /// the send refuses. It is documented as a faithful dry run, and a bound
    /// living only on the send let it return a real fee for a batch the send
    /// was guaranteed to reject, which a keeper would then act on. Both halves
    /// now call one rule, so this is the second caller of the same function
    /// rather than a second copy of the check.
    function test_Quote_RefusesTheDayListTheSendRefuses() public {
        uint256 cap = LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP;
        _finalizeDays(cap + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaipakamErrors.TransportDayFanoutExceeded.selector,
                cap + 1,
                cap
            )
        );
        remit.quoteRemittanceFee(CHAIN_ARB, _dayList(cap + 1));

        // The discovery view does NOT refuse - it is what a caller chunks
        // FROM - and it exposes exactly the chunking figure: as many non-zero
        // per-day entries as the list would fund (#2232 r16, one plan).
        (, uint256[] memory perDay) = remit.quoteRewardBudget(CHAIN_ARB, _dayList(cap + 1));
        uint256 funded;
        for (uint256 i; i < perDay.length; ++i) {
            if (perDay[i] != 0) ++funded;
        }
        assertEq(funded, cap + 1, "the budget quote shows how many days the list would fund");

        // At the cap the quote gets past the bound, exactly as the send does.
        (bool ok, bytes memory err) = address(remit).staticcall(
            abi.encodeCall(RewardRemittanceFacet.quoteRemittanceFee, (CHAIN_ARB, _dayList(cap)))
        );
        if (!ok && err.length >= 4) {
            assertTrue(
                bytes4(err) != IVaipakamErrors.TransportDayFanoutExceeded.selector,
                "a list exactly at the cap is admitted by the bound"
            );
        }
    }

    // ─── #2232 r16 root arrest: ONE plan for the send and every quote ────────

    /// One list, four readers, one answer. The send, the fee quote and the two
    /// discovery views walk the SAME plan (`_planBatch`), so their figures
    /// agree by construction: a repeated day reads once, the two discovery
    /// views agree per day, the fee quote's total is the budget quote's, and
    /// the send then funds per day exactly what was quoted. Before this, four
    /// hand-copied walks each enforced a different subset of the rules - which
    /// is how a quote priced what the send refused three times running.
    function test_OnePlan_TheSendAndEveryQuoteAgree() public {
        _finalizeDays(3);
        uint256[] memory list = new uint256[](4);
        list[0] = 1;
        list[1] = 2;
        list[2] = 2; // a duplicate in the middle
        list[3] = 3;
        (uint256 total, uint256[] memory perDay) = remit.quoteRewardBudget(CHAIN_ARB, list);
        (uint256[] memory amounts, bool[] memory closeable) = remit.quoteRemitDayPlans(CHAIN_ARB, list);
        (, uint256 feeTotal) = remit.quoteRemittanceFee(CHAIN_ARB, list);
        assertEq(perDay[2], 0, "a repeated day reads once");
        assertFalse(closeable[2], "and is not closeable twice");
        uint256 sum;
        for (uint256 i; i < list.length; ++i) {
            assertEq(amounts[i], perDay[i], "the two discovery views agree per day");
            sum += perDay[i];
        }
        assertGt(total, 0, "the fixture funds something");
        assertEq(total, sum, "the budget quote's total is its per-day sum");
        assertEq(feeTotal, total, "the fee quote's total is the same plan");

        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, list, CAP);
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 1), perDay[0], "day 1 funded exactly what was quoted");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 2), perDay[1], "day 2 likewise");
        assertEq(rlens.getRewardBudgetRemitted(CHAIN_ARB, 3), perDay[3], "day 3 likewise");
        assertEq(rlens.getRewardBudgetRemittedTotal(CHAIN_ARB), total, "and the send moved exactly the quoted total");
    }

    /// An unfinalized day: the send and the fee quote refuse it by name, with
    /// the same day; the discovery views read it as zero - the tolerance the
    /// keeper's window scan relies on, now a stated rule of one walk rather
    /// than an accident of a separate one.
    function test_OnePlan_AnUnfinalizedDayRefusesTheSendAndTheFeeQuote_ReadsZeroInDiscovery() public {
        _finalizeDay1();
        uint256[] memory list = new uint256[](2);
        list[0] = 1;
        list[1] = 2; // not finalized
        vm.expectRevert(abi.encodeWithSelector(RewardRemittanceFacet.RewardDayNotFinalized.selector, 2));
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, list, CAP);
        vm.expectRevert(abi.encodeWithSelector(RewardRemittanceFacet.RewardDayNotFinalized.selector, 2));
        remit.quoteRemittanceFee(CHAIN_ARB, list);
        (uint256 total, uint256[] memory perDay) = remit.quoteRewardBudget(CHAIN_ARB, list);
        assertEq(perDay[1], 0, "discovery reads the unfinalized day as zero");
        assertEq(total, perDay[0], "and its total counts only what is fundable");
        (, bool[] memory closeable) = remit.quoteRemitDayPlans(CHAIN_ARB, list);
        assertFalse(closeable[1], "and does not call it closeable");
    }

    /// @dev A day list of `n` consecutive days from 1. The single-day `_days`
    ///      above names ONE day by id; this names a LENGTH, which is what the
    ///      fan-out bound is about.
    function _dayList(uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = i + 1;
    }

    // ─── auth ─────────────────────────────────────────────────────────────────

    function test_Remit_RevertsForStranger() public {
        _finalizeDay1();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.NotRewardRemitter.selector,
                stranger
            )
        );
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
    }

    function test_Remit_AllowsConfiguredKeeper() public {
        _finalizeDay1();
        remit.setRewardRemittanceKeeper(keeper);
        assertEq(rlens.getRewardRemittanceKeeper(), keeper, "keeper set");
        vm.prank(keeper);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
        assertGt(rlens.getRewardBudgetRemittedGlobal(), 0, "keeper remitted");
    }

    function test_SetKeeper_RequiresAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        remit.setRewardRemittanceKeeper(keeper);
    }

    function test_Remit_RevertsOnMirror() public {
        _finalizeDay1();
        // Flip to a mirror deploy — remittance is Base-only. (#1566 slice 4
        // PR B: the setUp's activation froze the role; lifted raw here, since
        // the flip itself is not what this test pins.)
        TestMutatorFacet(address(diamond)).setRewardRoleChangesFrozenRaw(false);
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        vm.expectRevert(IVaipakamErrors.NotCanonicalRewardChain.selector);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
    }

    // ─── backfillDayInclusion (#776 upgrade-migration path) ────────────────

    function test_Backfill_RequiresAdmin() public {
        _finalizeDay1();
        vm.prank(stranger);
        vm.expectRevert();
        RewardAggregatorFacet(address(diamond)).backfillDayInclusion(1);
    }

    function test_Backfill_RevertsOnUnfinalizedDay() public {
        vm.expectRevert(IVaipakamErrors.DayNotReadyToFinalize.selector);
        RewardAggregatorFacet(address(diamond)).backfillDayInclusion(1);
    }

    function test_Backfill_IdempotentKeepsSlicesRemittable() public {
        _finalizeDay1();
        (uint256 before, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        // finalizeDay already set the flags; backfill must be a safe no-op that
        // leaves the (already-correct) slices intact.
        RewardAggregatorFacet(address(diamond)).backfillDayInclusion(1);
        (uint256 afterQ, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        assertEq(afterQ, before, "backfill idempotent");
        assertGt(afterQ, 0, "slice still remittable");
    }

    function test_Remit_PayloadCarriesOnlyFundedDays() public {
        _finalizeDay1();
        // Day 1 passed twice — the second occurrence is skipped, so the payload
        // (the mirror's reconciliation record) must name day 1 exactly once, not
        // echo the caller's raw [1, 1].
        uint256[] memory dup = new uint256[](2);
        dup[0] = 1;
        dup[1] = 1;
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, dup, CAP);
        // B2-d5 — the payload leads with the wire tag (see {RemitWire}); the
        // pre-tag prefix decode now reverts by design, which is the whole
        // point of the tag.
        (, uint256[] memory sentDays, uint256 sentTotal, , , ) = abi.decode(
            ccip.sentPayload(0),
            (uint256, uint256[], uint256, uint256, address, uint256)
        );
        assertEq(sentDays.length, 1, "payload carries only the funded day");
        assertEq(sentDays[0], 1, "funded day is day 1");
        assertGt(sentTotal, 0, "non-zero total");
    }

    // ─── mirror-side ingress: onRewardBudgetReceived (#776 PR2) ────────────

    // A code-bearing stand-in for the registered receiver — `setRewardRemittance
    // Receiver` rejects EOAs, so the gate test needs a contract address.
    function _rcv() internal view returns (address) {
        return address(ccip);
    }

    function test_SetReceiver_RequiresAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        remit.setRewardRemittanceReceiver(_rcv());
    }

    function test_SetReceiver_RejectsEOA() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceFacet.RewardReceiverNotContract.selector,
                address(0xEEEE)
            )
        );
        remit.setRewardRemittanceReceiver(address(0xEEEE));
    }

    function test_Ingress_RecordsReceivedFromRegisteredReceiver() public {
        address rcv = _rcv();
        remit.setRewardRemittanceReceiver(rcv);
        assertEq(rlens.getRewardRemittanceReceiver(), rcv, "receiver set");
        vm.prank(rcv);
        ingress.onRewardBudgetReceived(address(vpfiTok), 123e18, _days(1), CHAIN_BASE, 0, address(0xBA5E), 0, 0, bytes32(0), false);
        assertEq(rlens.getRewardBudgetReceivedTotal(), 123e18, "recorded total");
    }

    function test_Ingress_RevertsForNonReceiver() public {
        remit.setRewardRemittanceReceiver(_rcv());
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardIngressFacet.NotRewardRemittanceReceiver.selector,
                stranger
            )
        );
        ingress.onRewardBudgetReceived(address(vpfiTok), 1e18, _days(1), CHAIN_BASE, 0, address(0xBA5E), 0, 0, bytes32(0), false);
    }

    function test_Ingress_RevertsOnTokenMismatch() public {
        address rcv = _rcv();
        remit.setRewardRemittanceReceiver(rcv);
        vm.prank(rcv);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardIngressFacet.RewardBudgetTokenMismatch.selector,
                address(vpfiTok),
                address(0xDEAD)
            )
        );
        ingress.onRewardBudgetReceived(address(0xDEAD), 1e18, _days(1), CHAIN_BASE, 0, address(0xBA5E), 0, 0, bytes32(0), false);
    }

    receive() external payable {}
}
