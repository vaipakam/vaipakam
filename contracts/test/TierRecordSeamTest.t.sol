// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VPFIDiscountAccumulatorFacet} from "../src/facets/VPFIDiscountAccumulatorFacet.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {ProtocolBroadcastFacet} from "../src/facets/ProtocolBroadcastFacet.sol";
import {RewardReporterFacet} from "../src/facets/RewardReporterFacet.sol";
import {OfferCreateFacet} from "../src/facets/OfferCreateFacet.sol";
import {OfferCancelFacet} from "../src/facets/OfferCancelFacet.sol";
import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {VaipakamRewardMessenger} from "../src/crosschain/VaipakamRewardMessenger.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibTierRecord} from "../src/libraries/LibTierRecord.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";

/// @dev Drives {LibTierRecord}'s transient queue outside a Diamond.
contract TierQueueHarness {
    function enqueueTwiceThenDrain(address a, address b) external returns (uint256 queued, address[] memory users) {
        LibTierRecord.enqueue(a);
        LibTierRecord.enqueue(b);
        LibTierRecord.enqueue(a);
        queued = LibTierRecord.pending();
        users = LibTierRecord.drain();
        LibTierRecord.enqueue(a); // a drained user may be queued again
        require(LibTierRecord.pending() == 1, "re-queue after drain");
        LibTierRecord.drain();
    }

    function pendingNow() external view returns (uint256) {
        return LibTierRecord.pending();
    }
}

/// @title TierRecordSeamTest
/// @notice #1820 — a user's VPFI tier record is refreshed wherever their
///         tracked VPFI changes, through one seam, and their tier is pushed
///         once per action, when the action releases the reentrancy guard.
contract TierRecordSeamTest is SetupTest {
    VPFIToken internal vpfiToken;
    MockCcipRouter internal router;
    CcipMessenger internal messenger;
    VaipakamRewardMessenger internal rewardMsgr;
    ProtocolBroadcastFacet internal pb;
    address internal user;

    uint256 internal constant MIRROR_A = 11_155_111;
    uint256 internal constant MIRROR_B = 421_614;
    uint64 internal constant SEL_A = 5009297550715157269;
    uint64 internal constant SEL_B = 3478487238524512106;
    bytes32 internal constant CHANNEL = keccak256("vaipakam.ccip.channel.vpfi-reward");
    uint256 internal constant STAKE = 500 ether;

    function setUp() public {
        setupHelper();
        user = makeAddr("user");
        pb = ProtocolBroadcastFacet(payable(address(diamond)));
    }

    /// @dev The canonical VPFI token and a two-lane push route, as on Base.
    function _wirePush() internal {
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
        router.setFixedFee(0.01 ether);
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
        vm.stopPrank();
    }

    function _wireLane(uint256 chainId, uint64 sel) internal {
        address remote = makeAddr(string(abi.encode(chainId)));
        messenger.setChainSelector(chainId, sel);
        messenger.setRemoteMessenger(chainId, remote);
        messenger.setChannelPeer(CHANNEL, chainId, remote);
    }

    function _removeRoute(bytes4 selector) internal {
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = selector;
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(0),
            action: IDiamondCut.FacetCutAction.Remove,
            functionSelectors: sel
        });
        IDiamondCut(address(diamond)).diamondCut(cuts, address(0), "");
    }

    // ─── The seam's fixed selectors ────────────────────────────────────

    function test_SelectorsPinnedToTheFacets() public pure {
        assertEq(LibTierRecord.SYNC_SELECTOR, VPFIDiscountAccumulatorFacet.syncTierRecord.selector, "sync");
        assertEq(LibTierRecord.FLUSH_SELECTOR, ProtocolBroadcastFacet.flushTierPushes.selector, "flush");
    }

    // ─── Push once, at the end of the action ───────────────────────────

    function test_GuardedAction_QueuesThenFlushesOnce() public {
        _wirePush();
        vm.expectCall(address(diamond), abi.encodeCall(VPFIDiscountAccumulatorFacet.syncTierRecord, (user)), 1);
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.flushTierPushes, ()), 1);
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.protocolBroadcastTierUpdate, (user)), 0);
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(STAKE);
    }

    function test_Poke_RefreshesWithoutMovingVpfi_OnePushPerAction() public {
        _wirePush();
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(STAKE);
        vm.warp(block.timestamp + 3 days + 1);
        uint256 before = router.pendingCount();
        // Time alone lifted the tier; the poke refreshes with no balance write
        // and the guard's release pushes the new tier once, on both lanes.
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.flushTierPushes, ()), 1);
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).pokeMyTier();
        assertEq(router.pendingCount() - before, 2, "one push, both lanes");
    }

    /// @dev Two tier-balance writes in one action: the record sees the
    ///      trough (dayMin), and the tier is pushed once, at the end.
    function test_TwoWritesInOneAction_RecordSeesTrough_OnePush() public {
        _wirePush();
        vm.prank(user);
        VPFIDiscountFacet(address(diamond)).depositVPFIToVault(STAKE);
        vm.warp(block.timestamp + 1 days);

        vm.expectCall(address(diamond), abi.encodeCall(VPFIDiscountAccumulatorFacet.syncTierRecord, (user)), 2);
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.flushTierPushes, ()), 1);
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.protocolBroadcastTierUpdate, (user)), 0);
        TestMutatorFacet(address(diamond)).guardedVpfiOutAndBackRaw(user, 400 ether);

        (,, uint120 dayClose, uint120 dayMin) = TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(user);
        assertEq(uint256(dayClose), STAKE, "close of day is the restored balance");
        assertEq(uint256(dayMin), STAKE - 400 ether, "the trough inside the action is recorded");
    }

    function test_UnguardedRefresh_PushesInline() public {
        _wirePush();
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.protocolBroadcastTierUpdate, (user)), 1);
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.flushTierPushes, ()), 0);
        TestMutatorFacet(address(diamond)).refreshTierRecordRaw(user);
    }

    function test_NoMessenger_RecordsWithoutPushOrQueue() public {
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.protocolBroadcastTierUpdate, (user)), 0);
        vm.expectCall(address(diamond), abi.encodeCall(ProtocolBroadcastFacet.flushTierPushes, ()), 0);
        TestMutatorFacet(address(diamond)).refreshTierRecordRaw(user);
    }

    // ─── Missing routes ────────────────────────────────────────────────

    function test_MissingPushHost_RevertsByName() public {
        _wirePush();
        _removeRoute(ProtocolBroadcastFacet.protocolBroadcastTierUpdate.selector);
        vm.expectRevert(VPFIDiscountAccumulatorFacet.TierPushHostMissing.selector);
        TestMutatorFacet(address(diamond)).refreshTierRecordRaw(user);
    }

    function test_MissingAccumulator_RecordsNothing() public {
        _removeRoute(VPFIDiscountAccumulatorFacet.syncTierRecord.selector);
        TestMutatorFacet(address(diamond)).refreshTierRecordRaw(user); // no revert
    }

    function test_SyncTierRecord_OnlyInternal() public {
        vm.expectRevert();
        VPFIDiscountAccumulatorFacet(address(diamond)).syncTierRecord(user);
        vm.expectRevert();
        pb.flushTierPushes();
    }

    // ─── The queue ─────────────────────────────────────────────────────

    function test_Queue_DedupesAndDrains() public {
        TierQueueHarness h = new TierQueueHarness();
        address a = makeAddr("a");
        address b = makeAddr("b");
        (uint256 queued, address[] memory users) = h.enqueueTwiceThenDrain(a, b);
        assertEq(queued, 2, "a user is queued once");
        assertEq(users.length, 2, "drained both");
        assertEq(users[0], a, "first queued first");
        assertEq(users[1], b, "second");
        assertEq(h.pendingNow(), 0, "empty after the action");
    }

    // ─── Paths that used to leave the record stale ─────────────────────

    /// @dev Lending VPFI moves it into the lender's vault as offer escrow and
    ///      back on cancel; neither path stamped the record before #1820.
    function test_VpfiLendingOffer_CreateAndCancel_RefreshTheRecord() public {
        VPFITokenFacet(address(diamond)).setVPFIToken(mockERC20);
        uint256 amount = 1_000 ether;

        vm.expectCall(address(diamond), abi.encodeCall(VPFIDiscountAccumulatorFacet.syncTierRecord, (lender)));
        uint256 offerId = _postVpfiLenderOffer(amount);
        (,, uint120 dayClose,) = TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(lender);
        assertEq(uint256(dayClose), amount, "record carries the escrowed VPFI");

        vm.expectCall(address(diamond), abi.encodeCall(VPFIDiscountAccumulatorFacet.syncTierRecord, (lender)));
        // #664 — the cancel cooldown applies to every fresh offer.
        vm.warp(block.timestamp + LibVaipakam.MIN_OFFER_CANCEL_DELAY);
        vm.prank(lender);
        OfferCancelFacet(address(diamond)).cancelOffer(offerId);
        (,, dayClose,) = TestMutatorFacet(address(diamond)).getStakeRollupStateRaw(lender);
        assertEq(uint256(dayClose), 0, "record follows the refund");
    }

    function test_NonVpfiMovement_DoesNotRefresh() public {
        VPFITokenFacet(address(diamond)).setVPFIToken(mockCollateralERC20);
        vm.expectCall(address(diamond), abi.encodeCall(VPFIDiscountAccumulatorFacet.syncTierRecord, (lender)), 0);
        _postVpfiLenderOffer(1_000 ether); // lends mockERC20, which is not VPFI here
    }

    function _postVpfiLenderOffer(uint256 amount) internal returns (uint256 offerId) {
        vm.prank(lender);
        offerId = OfferCreateFacet(address(diamond)).createOffer(
            LibVaipakam.CreateOfferParams({
                offerType: LibVaipakam.OfferType.Lender,
                lendingAsset: mockERC20,
                amount: amount,
                interestRateBps: 500,
                collateralAsset: mockCollateralERC20,
                collateralAmount: 1_800 ether,
                durationDays: 30,
                assetType: LibVaipakam.AssetType.ERC20,
                tokenId: 0,
                quantity: 0,
                creatorRiskAndTermsConsent: true,
                prepayAsset: mockERC20,
                collateralAssetType: LibVaipakam.AssetType.ERC20,
                collateralTokenId: 0,
                collateralQuantity: 0,
                allowsPartialRepay: false,
                allowsPrepayListing: false,
                allowsParallelSale: false,
                amountMax: amount,
                interestRateBpsMax: 500,
                collateralAmountMax: 1_800 ether,
                periodicInterestCadence: LibVaipakam.PeriodicInterestCadence.None,
                expiresAt: 0,
                fillMode: LibVaipakam.FillMode.Partial,
                refinanceTargetLoanId: 0,
                useFullTermInterest: false
            })
        );
    }
}
