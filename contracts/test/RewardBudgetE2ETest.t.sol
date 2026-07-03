// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {InteractionRewardsFacet} from "../src/facets/InteractionRewardsFacet.sol";
import {RewardRemittanceFacet} from "../src/facets/RewardRemittanceFacet.sol";
import {TestMutatorFacet} from "./mocks/TestMutatorFacet.sol";
import {MockChainlinkAggregator} from "./mocks/MockChainlinkAggregator.sol";
import {
    RewardRemittanceReceiver
} from "../src/crosschain/RewardRemittanceReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {IVaipakamErrors} from "../src/interfaces/IVaipakamErrors.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @dev Stand-in for the mirror's CCIP adapter — the receiver only checks
///      `msg.sender == messenger` and requires it to have code, so a thin relay
///      contract that forwards the delivery is the cleanest fixture.
contract MockCcipRelay {
    function relay(
        RewardRemittanceReceiver r,
        uint256 srcChainId,
        address sender,
        bytes calldata payload,
        ICrossChainMessenger.TokenAmount[] calldata tokens
    ) external {
        r.onCrossChainMessage(srcChainId, sender, payload, tokens);
    }
}

/// @title RewardBudgetE2ETest — #776 end-to-end funded-mirror-claim.
/// @notice Closes the gap `CrossChainRewardPlumbingTest.testCrossChainEndToEnd
///         ClaimPath` explicitly left open ("the actual VPFI mint path is
///         covered by InteractionRewardsFacet tests; this test proves the mesh
///         delivered consistent state into the gate"). It proves the load-
///         bearing #776 invariant on the RECEIVE side: a mirror whose claim
///         gate is open but whose VPFI balance is empty REVERTS the payout
///         (the pre-#776 broken-feature symptom), and after the
///         RewardRemittanceReceiver credits the remitted budget the SAME claim
///         SUCCEEDS. The Base SEND side (exact payload + token amount) is
///         covered by RewardRemittanceFacetTest; together they span the full
///         Base→mirror path.
contract RewardBudgetE2ETest is SetupTest, IVaipakamErrors {
    VPFIToken internal vpfi;
    MockChainlinkAggregator internal ethFeed;
    RewardRemittanceReceiver internal receiver;
    MockCcipRelay internal messenger;

    // ETH/USD = $4,000, 8-dec feed — engages the §4 per-user cap.
    int256 internal constant ETH_USD_RAW = 4_000 * 1e8;
    uint8 internal constant ETH_USD_DEC = 8;
    uint256 internal constant SRC_BASE = 8453;

    address internal alice;

    function setUp() public {
        setupHelper();

        // Mirror-side VPFI, deliberately NOT seeded into the Diamond — a mirror
        // starts with zero reward VPFI until Base remits.
        VPFIToken impl = new VPFIToken();
        vpfi = VPFIToken(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        VPFIToken.initialize,
                        (address(this), address(this), address(this))
                    )
                )
            )
        );
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));

        ethFeed = new MockChainlinkAggregator(
            ETH_USD_RAW, block.timestamp, ETH_USD_DEC
        );
        _mut().setEthUsdFeedRaw(address(ethFeed));

        alice = makeAddr("alice");
        _facet().setInteractionLaunchTimestamp(block.timestamp);

        // Deploy the mirror receiver pointed at THIS Diamond + register it as the
        // authorized ingress caller (mirrors what ConfigureCcip does on-chain).
        messenger = new MockCcipRelay();
        RewardRemittanceReceiver rImpl = new RewardRemittanceReceiver();
        receiver = RewardRemittanceReceiver(
            address(
                new ERC1967Proxy(
                    address(rImpl),
                    abi.encodeCall(
                        RewardRemittanceReceiver.initialize,
                        (address(this), address(messenger), address(diamond), address(vpfi))
                    )
                )
            )
        );
        RewardRemittanceFacet(address(diamond)).setRewardRemittanceReceiver(
            address(receiver)
        );
    }

    function _facet() internal view returns (InteractionRewardsFacet) {
        return InteractionRewardsFacet(address(diamond));
    }

    function _mut() internal view returns (TestMutatorFacet) {
        return TestMutatorFacet(address(diamond));
    }

    function _remit() internal view returns (RewardRemittanceFacet) {
        return RewardRemittanceFacet(address(diamond));
    }

    function _days1() internal pure returns (uint256[] memory d) {
        d = new uint256[](1);
        d[0] = 1;
    }

    /// @dev Deliver `amount` VPFI as a reward-budget remittance through the real
    ///      receiver: the CCIP adapter transfers the tokens to the receiver
    ///      first, then invokes the callback — so pre-fund the receiver.
    function _fundViaReceiver(uint256 amount) internal {
        vpfi.mint(address(receiver), amount);
        ICrossChainMessenger.TokenAmount[] memory tokens =
            new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: address(vpfi), amount: amount});
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            abi.encode(_days1(), amount),
            tokens
        );
    }

    /// @notice The whole point of #776: an open claim gate on an UNFUNDED
    ///         mirror reverts at the ERC20 transfer; once the budget is
    ///         remitted + received, the identical claim pays out.
    function test_E2E_UnfundedClaimReverts_ThenFundedClaimSucceeds() public {
        // alice earns a day-1 lender reward; the mutator opens the claim gate.
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        vm.warp(block.timestamp + 2 days + 1);

        // 1. UNFUNDED: the Diamond holds zero VPFI → the payout reverts at the
        //    ERC20 transfer SPECIFICALLY (not some other gate) — assert the
        //    exact insufficient-balance selector so a regression that closes the
        //    claim gate for another reason can't make this test pass hollow.
        assertEq(vpfi.balanceOf(address(diamond)), 0, "mirror starts empty");
        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        _facet().claimInteractionRewards();

        // 2. Base remits the day-1 budget; the receiver credits the mirror.
        _fundViaReceiver(1_000e18);
        assertEq(vpfi.balanceOf(address(diamond)), 1_000e18, "mirror funded");
        assertEq(
            _remit().getRewardBudgetReceivedTotal(),
            1_000e18,
            "ingress recorded the funded total"
        );

        // 3. FUNDED: the identical claim now succeeds and pays alice.
        uint256 aliceBefore = vpfi.balanceOf(alice);
        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertGt(paid, 0, "funded claim pays out");
        assertEq(vpfi.balanceOf(alice) - aliceBefore, paid, "alice received the VPFI");
        assertEq(
            vpfi.balanceOf(address(diamond)),
            1_000e18 - paid,
            "payout drawn from the received budget"
        );
    }

    /// @notice A second claimant on the same funded mirror is also paid — the
    ///         received budget is a shared, fungible balance (design §6).
    function test_E2E_FundedBudgetServesMultipleClaimants() public {
        address bobby = makeAddr("bobby");
        _mut().setDailyLenderInterest(1, alice, 1e18, 2e18);
        _mut().setDailyLenderInterest(1, bobby, 1e18, 2e18);
        vm.warp(block.timestamp + 2 days + 1);

        _fundViaReceiver(1_000e18);

        vm.prank(alice);
        (uint256 paidA, , ) = _facet().claimInteractionRewards();
        vm.prank(bobby);
        (uint256 paidB, , ) = _facet().claimInteractionRewards();
        assertGt(paidA, 0, "alice paid");
        assertGt(paidB, 0, "bobby paid");
        assertEq(vpfi.balanceOf(alice), paidA, "alice balance");
        assertEq(vpfi.balanceOf(bobby), paidB, "bobby balance");
    }

    /// @notice A live mirror Diamond can already hold VPFI for other purposes
    ///         (LIF custody, treasury) — and `claimInteractionRewards` pays from
    ///         the RAW balance, not from `rewardBudgetReceivedTotal`. This proves
    ///         the remittance is still load-bearing when such a commingled
    ///         balance exists but is INSUFFICIENT to cover the reward claim: the
    ///         claim reverts until the reward budget tops the balance up. (That
    ///         the claim draws from whatever balance is present — including
    ///         non-reward VPFI — is the commingling tradeoff tracked in #917.)
    function test_E2E_CommingledNonRewardVpfiBelowClaimStillNeedsRemittance() public {
        _mut().setDailyLenderInterest(1, alice, 1e18, 1e18);
        vm.warp(block.timestamp + 2 days + 1);

        // Simulate a tiny pre-existing non-reward balance (e.g. LIF custody),
        // deliberately far below the reward claim.
        vpfi.mint(address(diamond), 1e12);
        assertGt(vpfi.balanceOf(address(diamond)), 0, "mirror holds some VPFI");

        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        _facet().claimInteractionRewards();

        // The reward remittance tops the balance up → claim succeeds.
        _fundViaReceiver(1_000e18);
        vm.prank(alice);
        (uint256 paid, , ) = _facet().claimInteractionRewards();
        assertGt(paid, 0, "funded claim pays out");
        assertEq(vpfi.balanceOf(alice), paid, "alice received the VPFI");
    }
}
