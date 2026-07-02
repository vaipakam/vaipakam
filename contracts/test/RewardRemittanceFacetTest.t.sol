// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {RewardAggregatorFacet} from "../src/facets/RewardAggregatorFacet.sol";
import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIToken} from "../src/token/VPFIToken.sol";
import {LibInteractionRewards} from "../src/libraries/LibInteractionRewards.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {MockRewardMessenger} from "./mocks/MockRewardMessenger.sol";
import {MockCrossChainMessenger} from "./mocks/MockCrossChainMessenger.sol";

/**
 * @title RewardRemittanceFacetTest — #776 PR1 (Base sender) unit coverage.
 * @notice Exercises the on-demand reward-budget remittance: the finalized
 *         per-chain slice math, idempotency, cap + auth + finalization gates,
 *         and the CCIP token-path send (delivered-vs-declared amount).
 */
contract RewardRemittanceFacetTest is SetupTest {
    RewardRemittanceFacet internal remit;
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

    // ─── slice math ─────────────────────────────────────────────────────────

    function test_Quote_ComputesRoleAwareSlice() public {
        _finalizeDay1();
        uint256 half = LibInteractionRewards.halfPoolForDay(1);
        // global lender = 60e18, borrower = 30e18; ARB = 20/60 + 10/30.
        uint256 expectedArb = (half * 20e18) / 60e18 + (half * 10e18) / 30e18;
        (uint256 total, uint256[] memory perDay) = remit.quoteRewardBudget(
            CHAIN_ARB,
            _days(1)
        );
        assertEq(total, expectedArb, "arb slice");
        assertEq(perDay[0], expectedArb, "perDay");
        assertGt(expectedArb, 0, "non-zero");
    }

    function test_Slices_SumToFullDayEmission() public {
        _finalizeDay1();
        uint256 half = LibInteractionRewards.halfPoolForDay(1);
        (uint256 base, ) = remit.quoteRewardBudget(CHAIN_BASE, _days(1));
        (uint256 arb, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));
        (uint256 op, ) = remit.quoteRewardBudget(CHAIN_OP, _days(1));
        // Σ across chains == both halves == the full day's emission, minus the
        // integer-division dust (6 floored divisions → ≤6 wei stays on Base).
        // The load-bearing invariant is that remittances NEVER exceed emission.
        uint256 sum = base + arb + op;
        assertLe(sum, 2 * half, "slices never exceed the day's emission");
        assertApproxEqAbs(sum, 2 * half, 6, "slices partition the pool (+/- dust)");
    }

    // ─── happy path ─────────────────────────────────────────────────────────

    function test_Remit_SendsSliceOverCcipAndRecordsAccounting() public {
        _finalizeDay1();
        (uint256 expected, ) = remit.quoteRewardBudget(CHAIN_ARB, _days(1));

        uint256 diamondBefore = vpfiTok.balanceOf(address(diamond));
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);

        // CCIP captured a single token-bearing send with the exact slice.
        assertEq(ccip.sentCount(), 1, "one send");
        ICrossChainMessenger.TokenAmount[] memory toks = ccip.sentTokens(0);
        assertEq(toks.length, 1, "one token");
        assertEq(toks[0].token, address(vpfiTok), "vpfi");
        assertEq(toks[0].amount, expected, "delivered == slice");

        // VPFI pulled from the Diamond; accounting recorded.
        assertEq(
            vpfiTok.balanceOf(address(diamond)),
            diamondBefore - expected,
            "diamond debited"
        );
        assertEq(remit.getRewardBudgetRemitted(CHAIN_ARB, 1), expected, "marked");
        assertEq(remit.getRewardBudgetRemittedTotal(CHAIN_ARB), expected, "total");
        assertEq(remit.getRewardBudgetRemittedGlobal(), expected, "global");
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
        uint256 expected = remit.getRewardBudgetRemitted(CHAIN_ARB, 1);
        assertEq(remit.getRewardBudgetRemittedGlobal(), expected, "no double count");
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
        assertEq(remit.getRewardRemittanceKeeper(), keeper, "keeper set");
        vm.prank(keeper);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
        assertGt(remit.getRewardBudgetRemittedGlobal(), 0, "keeper remitted");
    }

    function test_SetKeeper_RequiresAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        remit.setRewardRemittanceKeeper(keeper);
    }

    function test_Remit_RevertsOnMirror() public {
        _finalizeDay1();
        // Flip to a mirror deploy — remittance is Base-only.
        RewardReporterFacet(address(diamond)).setIsCanonicalRewardChain(false);
        vm.expectRevert(IVaipakamErrors.NotCanonicalRewardChain.selector);
        remit.remitRewardBudget{value: 1 ether}(CHAIN_ARB, _days(1), CAP);
    }

    receive() external payable {}
}
