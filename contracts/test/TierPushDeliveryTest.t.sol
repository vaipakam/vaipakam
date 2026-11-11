// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
import {ConfigFacet} from "../src/facets/ConfigFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";

/// @dev A messenger stand-in whose quote burns every unit of gas it is
///      given: a lane that fails on its own, however much gas it gets.
contract GasBurningTierMessenger {
    function getBroadcastDestinations() external pure returns (uint256[] memory d) {
        d = new uint256[](1);
        d[0] = 11_155_111;
    }

    function quoteSendTierUpdateTo(uint256, address, uint8, uint16, uint40, uint256, uint40, uint16)
        external
        view
        returns (uint256)
    {
        uint256 x;
        while (gasleft() > 0) {
            unchecked {
                ++x;
            }
        }
        return x;
    }
}

/// @dev A two-lane messenger stand-in: lane A's quote burns every unit of
///      gas it is given, lane B quotes and sends normally. Lets a test show
///      that a lane failing by gas exhaustion leaves the next lane served.
contract FirstLaneBurnsTierMessenger {
    uint256 internal constant LANE_A = 11_155_111;
    uint256 internal constant LANE_B = 421_614;
    uint256 public sentToB;

    function getBroadcastDestinations() external pure returns (uint256[] memory d) {
        d = new uint256[](2);
        d[0] = LANE_A;
        d[1] = LANE_B;
    }

    function quoteSendTierUpdateTo(uint256 dst, address, uint8, uint16, uint40, uint256, uint40, uint16)
        external
        view
        returns (uint256)
    {
        if (dst == LANE_A) {
            uint256 x;
            while (gasleft() > 0) {
                unchecked {
                    ++x;
                }
            }
            return x;
        }
        return 1 gwei;
    }

    function sendTierUpdateTo(uint256 dst, address, uint8, uint16, uint40, uint256, uint40, uint16, address payable)
        external
        payable
        returns (bytes32)
    {
        require(dst == LANE_B && msg.value == 1 gwei, "unexpected send");
        ++sentToB;
        return bytes32(sentToB);
    }
}

/// @title TierPushDeliveryTest
/// @notice #898 / #911 / #1277 — the cross-chain tier push never makes the
///         user's action fail. Each broadcast lane is delivered on its own
///         and stays owed when it cannot go out; the protocol budget pays a
///         lowered tier at once and anything else once per spacing window;
///         anyone may pay to deliver an owed lane; too little gas for a
///         call reverts the action.
contract TierPushDeliveryTest is SetupTest {
    VPFIToken internal vpfiToken;
    MockCcipRouter internal router;
    CcipMessenger internal messenger;
    VaipakamRewardMessenger internal rewardMsgr;
    ProtocolBroadcastFacet internal pb;
    address internal user;
    address internal stranger;

    uint256 internal constant MIRROR_A = 11_155_111; // Sepolia
    uint256 internal constant MIRROR_B = 421_614; // Arbitrum Sepolia
    uint64 internal constant SEL_A = 5009297550715157269;
    uint64 internal constant SEL_B = 3478487238524512106;
    bytes32 internal constant CHANNEL = keccak256("vaipakam.ccip.channel.vpfi-reward");
    uint256 internal constant FEE = 0.01 ether;
    uint256 internal constant STAKE = 500 ether; // tier 1

    function setUp() public {
        setupHelper();
        user = makeAddr("user");
        stranger = makeAddr("stranger");
        pb = ProtocolBroadcastFacet(payable(address(diamond)));

        VPFIToken impl = new VPFIToken();
        vpfiToken = VPFIToken(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)))
                )
            )
        );
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfiToken));
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountRate(1e15);

        router = new MockCcipRouter();
        router.setFixedFee(FEE);
        router.setSupported(SEL_A, true);
        router.setSupported(SEL_B, true);
        CcipMessenger msgrImpl = new CcipMessenger(address(router));
        messenger = CcipMessenger(
            address(new ERC1967Proxy(address(msgrImpl), abi.encodeCall(CcipMessenger.initialize, (address(this)))))
        );
        VaipakamRewardMessenger rmImpl = new VaipakamRewardMessenger();
        rewardMsgr = VaipakamRewardMessenger(
            payable(
                address(
                    new ERC1967Proxy(
                        address(rmImpl),
                        abi.encodeCall(
                            VaipakamRewardMessenger.initialize,
                            (address(this), address(messenger), address(diamond), true, 0, 400_000)
                        )
                    )
                )
            )
        );
        messenger.registerChannel(CHANNEL, address(rewardMsgr));
        _wireLane(MIRROR_A, SEL_A);
        _wireLane(MIRROR_B, SEL_B);
        uint256[] memory dests = new uint256[](2);
        dests[0] = MIRROR_A;
        dests[1] = MIRROR_B;
        rewardMsgr.setBroadcastDestinations(dests);

        RewardReporterFacet(address(diamond)).setRewardMessenger(address(rewardMsgr));
        vm.deal(address(this), 10 ether);
        pb.topUpBroadcastBudget{value: 1 ether}();

        vpfiToken.transfer(user, STAKE + 1);
        vm.startPrank(user);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        IERC20(address(vpfiToken)).approve(address(diamond), type(uint256).max);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(STAKE);
        vm.stopPrank();
    }

    function _wireLane(uint256 chainId, uint64 sel) internal {
        address remote = makeAddr(string(abi.encode(chainId)));
        messenger.setChainSelector(chainId, sel);
        messenger.setRemoteMessenger(chainId, remote);
        messenger.setChannelPeer(CHANNEL, chainId, remote);
    }

    /// @dev Age the stake past the min-history gate and roll up: tier 1 is
    ///      committed, and (#1277) left owed on both lanes, since a first
    ///      discount is a raise the protocol budget never pays. The user then
    ///      pays to deliver it on both lanes.
    function _reachTierOne() internal {
        vm.warp(block.timestamp + 3 days + 1);
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(1);
        assertEq(router.pendingCount(), 0, "a first discount is not budget-paid");
        assertTrue(_lane(MIRROR_A).owed, "raise owed");
        assertFalse(_lane(MIRROR_A).budgetPays, "and only a paying caller delivers it");
        _payRaise();
        assertEq(router.pendingCount(), 2, "tier 1 went out on both lanes");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore, "caller-paid: the budget was not touched");
    }

    /// @dev The user pays for both lanes of an owed raise.
    function _payRaise() internal {
        vm.deal(user, 2 * FEE);
        vm.prank(user);
        pb.deliverTierPush{value: 2 * FEE}(user);
        assertEq(user.balance, 0, "exactly the two fees spent");
        assertFalse(_lane(MIRROR_A).owed);
        assertFalse(_lane(MIRROR_B).owed);
    }

    function _lane(uint256 chainId) internal view returns (ProtocolBroadcastFacet.TierLaneStatus memory l) {
        (,,,,, ProtocolBroadcastFacet.TierLaneStatus[] memory lanes) = pb.getTierPushStatus(user);
        for (uint256 i; i < lanes.length; ++i) {
            if (lanes[i].destChainId == chainId) return lanes[i];
        }
        revert("lane not listed");
    }

    function _unstakeAll() internal {
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault(STAKE + 1);
    }

    // ─── One lane down ──────────────────────────────────────────────────

    function test_LaneDown_UnstakeLands_OtherLaneDelivered_DownLaneOwed() public {
        _reachTierOne();
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();
        router.setSupported(SEL_B, false);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit ProtocolBroadcastFacet.TierPushDeferred(user, MIRROR_B, 2, ProtocolBroadcastFacet.TierPushDeferral.Quote);
        _unstakeAll();

        assertEq(router.pendingCount(), 3, "only the live lane carried the downgrade");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore - FEE, "one lane's fee, from the budget");
        assertFalse(_lane(MIRROR_A).owed, "live lane delivered");
        assertTrue(_lane(MIRROR_B).owed, "down lane owed");
        assertEq(_lane(MIRROR_B).delivered.tier, 1, "down lane still holds tier 1");

        // The lane comes back; anyone delivers the owed downgrade, budget-paid.
        router.setSupported(SEL_B, true);
        vm.prank(stranger);
        pb.deliverTierPush(user);
        assertFalse(_lane(MIRROR_B).owed, "down lane delivered after recovery");
        assertEq(_lane(MIRROR_B).delivered.tier, 0);
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore - 2 * FEE);
    }

    function test_MessengerPaused_UnstakeLands_BothLanesOwed() public {
        _reachTierOne();
        rewardMsgr.pause();
        _unstakeAll();
        assertEq(router.pendingCount(), 2, "nothing sent while paused");
        assertTrue(_lane(MIRROR_A).owed);
        assertTrue(_lane(MIRROR_B).owed);
        assertEq(IERC20(address(vpfiToken)).balanceOf(user), STAKE + 1, "principal back in the wallet");
    }

    function test_NoDestinations_UnstakeLands_AndAnnounces() public {
        _reachTierOne();
        rewardMsgr.setBroadcastDestinations(new uint256[](0));
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ProtocolBroadcastFacet.TierPushDeferred(user, 0, 2, ProtocolBroadcastFacet.TierPushDeferral.NoDestinations);
        _unstakeAll();
    }

    // ─── Budget ─────────────────────────────────────────────────────────

    function test_BudgetEmpty_UnstakeLands_CallerPaysAndIsRefunded() public {
        _reachTierOne();
        pb.withdrawBudget(payable(address(this)), pb.getProtocolBroadcastBudget());

        _unstakeAll();
        assertTrue(_lane(MIRROR_A).owed, "budget empty: owed");
        assertTrue(_lane(MIRROR_B).owed, "budget empty: owed");

        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        pb.deliverTierPush{value: 1 ether}(user);
        assertFalse(_lane(MIRROR_A).owed);
        assertFalse(_lane(MIRROR_B).owed);
        assertEq(stranger.balance, 1 ether - 2 * FEE, "caller paid exactly the two fees");
        assertEq(pb.getProtocolBroadcastBudget(), 0, "the budget was not touched");
    }

    // ─── Lowers only (#1277) ────────────────────────────────────────────

    /// @dev The consent toggle of #1277: dropping the tier is budget-paid at
    ///      once; raising it back is never budget-paid, however long it
    ///      waits, and goes out only when a caller pays.
    function test_ConsentToggle_DropIsBudgetPaid_RaiseIsNot() public {
        _reachTierOne();
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();

        // Consent off then poke: a lowered tier, budget-paid at once.
        vm.startPrank(user);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        assertEq(router.pendingCount(), 4, "downgrade sent at once");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore - 2 * FEE, "from the budget");

        // Consent on then poke: the raise stays owed.
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit ProtocolBroadcastFacet.TierPushDeferred(user, MIRROR_A, 3, ProtocolBroadcastFacet.TierPushDeferral.RaiseUnpaid);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        vm.stopPrank();
        assertEq(router.pendingCount(), 4, "raise not sent");
        ProtocolBroadcastFacet.TierLaneStatus memory a = _lane(MIRROR_A);
        assertTrue(a.owed);
        assertFalse(a.budgetPays, "a raise is never budget-paid");

        // No window opens it: a month later an unpaid delivery still sends nothing.
        vm.warp(block.timestamp + 30 days);
        vm.prank(stranger);
        pb.deliverTierPush(user);
        assertEq(router.pendingCount(), 4, "still not sent");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore - 2 * FEE, "the budget paid only the drop");

        // Toggling off again: the lanes already hold tier 0, so they settle
        // without a message.
        vm.startPrank(user);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        vm.stopPrank();
        assertEq(router.pendingCount(), 4, "no message for a lane that already holds tier 0");
        assertFalse(_lane(MIRROR_A).owed);
    }

    /// @dev The drain bound: however often the tier is toggled, the budget
    ///      pays one drop per lane for each raise a caller paid for, so the
    ///      churner spends at least what the budget spends.
    function test_ConsentChurn_BudgetNeverOutspendsTheChurner() public {
        _reachTierOne();
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();
        uint256 callerSpent = 2 * FEE; // the first raise, in _reachTierOne
        for (uint256 i; i < 5; ++i) {
            vm.startPrank(user);
            VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);
            VPFIDiscountFacet(address(diamond)).pokeMyTier();
            VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
            VPFIDiscountFacet(address(diamond)).pokeMyTier();
            // Unpaid toggles in between cost the budget nothing more.
            VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);
            VPFIDiscountFacet(address(diamond)).pokeMyTier();
            VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
            VPFIDiscountFacet(address(diamond)).pokeMyTier();
            vm.stopPrank();
            _payRaise();
            callerSpent += 2 * FEE;
        }
        uint256 budgetSpent = budgetBefore - pb.getProtocolBroadcastBudget();
        assertEq(budgetSpent, 5 * 2 * FEE, "one drop per lane per paid raise");
        assertLe(budgetSpent, callerSpent, "the budget never outspends the churner");
    }

    /// @dev A raise goes out the moment a caller pays for it.
    function test_CallerFundedRaise_Delivers() public {
        _reachTierOne();
        vm.startPrank(user);
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(false);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        VPFIDiscountFacet(address(diamond)).setVPFIDiscountConsent(true);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        vm.stopPrank();
        assertTrue(_lane(MIRROR_A).owed);
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();
        _payRaise();
        assertEq(router.pendingCount(), 6, "raise delivered on both lanes");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore, "caller-paid");
    }

    /// @dev A push under a new tier-table version reinstates a discount on a
    ///      mirror (which reads a cached tier from another version as none),
    ///      so it is not budget-paid even when its bps is lower.
    function test_NewTableVersion_LowerBps_IsNotBudgetPaid() public {
        _reachTierOne();
        uint16 bpsBefore = _lane(MIRROR_A).delivered.bps;
        ConfigFacet(address(diamond)).setVpfiTierDiscountBps(bpsBefore - 1, 0, 0, 0);
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        ProtocolBroadcastFacet.TierLaneStatus memory a = _lane(MIRROR_A);
        assertTrue(a.owed, "the new version is owed");
        assertFalse(a.budgetPays, "a new version is never budget-paid");
        assertEq(router.pendingCount(), 2, "nothing sent");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore);
    }

    // ─── Gas ────────────────────────────────────────────────────────────

    /// @dev A lane whose own call runs out of the gas it was given is the
    ///      lane's failure, not the caller's: with ample gas the action lands
    ///      and the lane is deferred.
    function test_GasBurningLane_IsDeferred_ActionLands() public {
        _reachTierOne();
        GasBurningTierMessenger burner = new GasBurningTierMessenger();
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(burner));
        vm.expectEmit(true, true, false, true, address(diamond));
        emit ProtocolBroadcastFacet.TierPushDeferred(
            user, MIRROR_A, 2, ProtocolBroadcastFacet.TierPushDeferral.Quote
        );
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault{gas: 30_000_000}(STAKE + 1);
        assertEq(IERC20(address(vpfiToken)).balanceOf(user), STAKE + 1, "unstake landed");
    }

    /// @dev Codex #2853 r3 P1. Each call is capped at its own budget, so a
    ///      first lane that burns all the gas its quote is given cannot take
    ///      the gas the second lane needs: the action lands, lane A is
    ///      deferred and lane B is delivered. Uncapped, lane A's quote would
    ///      have consumed 63/64 of the transaction's gas and lane B's guard
    ///      would have reverted the whole unstake.
    function test_FirstLaneBurnsGas_SecondLaneDelivered_ActionLands() public {
        _reachTierOne();
        FirstLaneBurnsTierMessenger stand = new FirstLaneBurnsTierMessenger();
        RewardReporterFacet(address(diamond)).setRewardMessenger(address(stand));
        uint256 budgetBefore = pb.getProtocolBroadcastBudget();
        vm.expectEmit(true, true, false, true, address(diamond));
        emit ProtocolBroadcastFacet.TierPushDeferred(
            user, MIRROR_A, 2, ProtocolBroadcastFacet.TierPushDeferral.Quote
        );
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).withdrawVPFIFromVault{gas: 3_000_000}(STAKE + 1);
        assertEq(IERC20(address(vpfiToken)).balanceOf(user), STAKE + 1, "unstake landed");
        assertEq(stand.sentToB(), 1, "lane B sent");
        assertEq(_lane(MIRROR_B).delivered.nonce, 2, "lane B delivered");
        assertEq(_lane(MIRROR_A).delivered.nonce, 1, "lane A still owed");
        assertEq(pb.getProtocolBroadcastBudget(), budgetBefore - 1 gwei, "budget paid lane B only");
    }

    /// @dev Codex #2853 r1 P1. Through the real reward messenger, CCIP adapter
    ///      and router, sweep the gas a downgrading unstake carries: at every
    ///      limit it either reverts or delivers the downgrade on both lanes.
    ///      No limit lands the action with a lane left owed, so no nested
    ///      call can be starved into a deferral. The guard is what refuses
    ///      the low limits, not a raw out-of-gas somewhere else.
    function test_GasSweep_DowngradeIsNeverSkipped() public {
        _reachTierOne();
        bytes memory data = abi.encodeCall(VPFIDiscountFacet.withdrawVPFIFromVault, (STAKE + 1));
        uint256 landed;
        uint256 guarded;
        for (uint256 g = 150_000; g <= 3_000_000; g += 15_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(user);
            (bool ok, bytes memory ret) = address(diamond).call{gas: g}(data);
            if (ok) {
                ++landed;
                (uint64 nonce,,,,,) = pb.getTierPushStatus(user);
                assertEq(_lane(MIRROR_A).delivered.nonce, nonce, "lane A delivered");
                assertEq(_lane(MIRROR_B).delivered.nonce, nonce, "lane B delivered");
            } else if (ret.length >= 4 && bytes4(ret) == ProtocolBroadcastFacet.TierPushOutOfGas.selector) {
                ++guarded;
            }
            vm.revertToState(snap);
        }
        assertGt(landed, 0, "ample gas lands the unstake");
        assertGt(guarded, 0, "the gas guard refuses the tight limits");
    }

    // ─── Surface ────────────────────────────────────────────────────────

    function test_DeliverOnMirror_Refused() public {
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(false);
        vm.expectRevert(ProtocolBroadcastFacet.TierPushNotConfigured.selector);
        pb.deliverTierPush(user);
    }

    function test_NonSelfProducerCall_Refused() public {
        vm.expectRevert(abi.encodeWithSelector(ProtocolBroadcastFacet.OnlyInternal.selector, address(this)));
        pb.protocolBroadcastTierUpdate(user);
    }

    // Accept withdrawBudget's payout.
    receive() external payable {}
}
