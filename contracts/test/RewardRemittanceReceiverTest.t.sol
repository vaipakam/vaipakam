// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {
    RewardRemittanceReceiver,
    IRewardBudgetIngress
} from "../src/crosschain/RewardRemittanceReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Stand-in for the CCIP adapter: the only thing the receiver checks is
///      `msg.sender == messenger`, and `initialize` requires the messenger to
///      have code — so a tiny relay contract is the cleanest fixture.
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

/// @dev Stand-in for the mirror Diamond's `onRewardBudgetReceived` ingress —
///      records the last credit so the test can assert the forward + call.
contract MockRewardBudgetIngress is IRewardBudgetIngress {
    address public immutable vpfi;
    uint256 public lastAmount;
    uint256 public lastSourceChainId;
    uint256 public lastDayCount;
    uint256 public callCount;

    constructor(address vpfi_) {
        vpfi = vpfi_;
    }

    function onRewardBudgetReceived(
        address token,
        uint256 amount,
        uint256[] calldata dayIds,
        uint256 sourceChainId
    ) external override {
        require(token == vpfi, "ingress: token");
        lastAmount = amount;
        lastSourceChainId = sourceChainId;
        lastDayCount = dayIds.length;
        callCount++;
    }
}

/// @title RewardRemittanceReceiverTest — #776 PR2 (mirror receiver) unit coverage.
/// @notice Exercises the inbound CCIP token path: messenger-gated delivery,
///         declared-vs-delivered token/amount validation, fee-on-transfer-safe
///         forward into the Diamond, the ingress call, and the pause lever.
contract RewardRemittanceReceiverTest is Test {
    RewardRemittanceReceiver internal receiver;
    MockCcipRelay internal messenger;
    MockRewardBudgetIngress internal diamond;
    ERC20Mock internal vpfi;

    address internal owner = address(this);
    address internal guardian = address(0x6A1D);
    uint256 internal constant SRC_BASE = 8453;

    function setUp() public {
        vpfi = new ERC20Mock("Vaipakam", "VPFI", 18);
        messenger = new MockCcipRelay();
        diamond = new MockRewardBudgetIngress(address(vpfi));

        RewardRemittanceReceiver impl = new RewardRemittanceReceiver();
        receiver = RewardRemittanceReceiver(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        RewardRemittanceReceiver.initialize,
                        (owner, address(messenger), address(diamond), address(vpfi))
                    )
                )
            )
        );
        receiver.setGuardian(guardian);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    function _days(uint256 a, uint256 b) internal pure returns (uint256[] memory d) {
        d = new uint256[](2);
        d[0] = a;
        d[1] = b;
    }

    function _tokens(address token, uint256 amount)
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory t)
    {
        t = new ICrossChainMessenger.TokenAmount[](1);
        t[0] = ICrossChainMessenger.TokenAmount({token: token, amount: amount});
    }

    /// @dev The real CCIP adapter transfers the tokens to the receiver BEFORE
    ///      the callback, so a test delivery must pre-fund the receiver.
    function _deliver(uint256 amount, uint256 declaredTotal) internal {
        vpfi.mint(address(receiver), amount);
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E), // sourceSender — receiver ignores it (peer check is on the messenger)
            abi.encode(_days(1, 2), declaredTotal),
            _tokens(address(vpfi), declaredTotal)
        );
    }

    // ── happy path ───────────────────────────────────────────────────────────

    function test_Deliver_ForwardsToDiamondAndCallsIngress() public {
        _deliver(1_000e18, 1_000e18);
        assertEq(vpfi.balanceOf(address(diamond)), 1_000e18, "diamond funded");
        assertEq(vpfi.balanceOf(address(receiver)), 0, "receiver drained");
        assertEq(diamond.callCount(), 1, "ingress called once");
        assertEq(diamond.lastAmount(), 1_000e18, "credited amount");
        assertEq(diamond.lastSourceChainId(), SRC_BASE, "source chain");
        assertEq(diamond.lastDayCount(), 2, "day count");
    }

    // ── auth / validation reverts ────────────────────────────────────────────

    function test_Deliver_RevertsWhenCallerNotMessenger() public {
        vpfi.mint(address(receiver), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.NotMessenger.selector,
                address(this)
            )
        );
        receiver.onCrossChainMessage(
            SRC_BASE,
            address(0xBA5E),
            abi.encode(_days(1, 2), 1e18),
            _tokens(address(vpfi), 1e18)
        );
    }

    function test_Deliver_RevertsOnWrongTokenCount() public {
        ICrossChainMessenger.TokenAmount[] memory none =
            new ICrossChainMessenger.TokenAmount[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.WrongTokenCount.selector,
                uint256(0)
            )
        );
        messenger.relay(receiver, SRC_BASE, address(0xBA5E), abi.encode(_days(1, 2), 1e18), none);
    }

    function test_Deliver_RevertsOnTokenMismatch() public {
        ERC20Mock other = new ERC20Mock("Other", "OTH", 18);
        other.mint(address(receiver), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.TokenMismatch.selector,
                address(vpfi),
                address(other)
            )
        );
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            abi.encode(_days(1, 2), 1e18),
            _tokens(address(other), 1e18)
        );
    }

    function test_Deliver_RevertsOnAmountMismatch() public {
        // delivered token amount (900) != payload declared total (1000)
        vpfi.mint(address(receiver), 900e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                RewardRemittanceReceiver.AmountMismatch.selector,
                uint256(1_000e18),
                uint256(900e18)
            )
        );
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            abi.encode(_days(1, 2), 1_000e18),
            _tokens(address(vpfi), 900e18)
        );
    }

    function test_Deliver_RevertsOnZeroAmount() public {
        vm.expectRevert(RewardRemittanceReceiver.ZeroAmount.selector);
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            abi.encode(_days(1, 2), uint256(0)),
            _tokens(address(vpfi), 0)
        );
    }

    // ── pause lever ──────────────────────────────────────────────────────────

    function test_Deliver_RevertsWhenPaused() public {
        vm.prank(guardian);
        receiver.pause();
        vpfi.mint(address(receiver), 1e18);
        vm.expectRevert();
        messenger.relay(
            receiver,
            SRC_BASE,
            address(0xBA5E),
            abi.encode(_days(1, 2), 1e18),
            _tokens(address(vpfi), 1e18)
        );
    }

    function test_Pause_GuardianCanPause_OwnerUnpauses() public {
        vm.prank(guardian);
        receiver.pause();
        // guardian cannot unpause (owner-only) — then owner resumes.
        vm.prank(guardian);
        vm.expectRevert();
        receiver.unpause();
        receiver.unpause(); // owner (this)
        _deliver(5e18, 5e18);
        assertEq(diamond.callCount(), 1, "resumes after unpause");
    }
}
