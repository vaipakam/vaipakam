// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BuybackRemittanceReceiver} from "../src/crosschain/BuybackRemittanceReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @dev Records `absorbRemittance` calls — stands in for a real
///      Vaipakam Diamond's TreasuryFacet ingress.
contract MockDiamondAbsorber {
    address public lastToken;
    uint256 public lastAmount;
    uint256 public lastSourceChain;
    uint256 public absorbCount;

    function absorbRemittance(
        address token,
        uint256 amount,
        uint256 sourceChainId
    ) external {
        lastToken = token;
        lastAmount = amount;
        lastSourceChain = sourceChainId;
        ++absorbCount;
    }
}

/// @title BuybackRemittanceReceiverTest
/// @notice T-087 Sub 3.A — unit-tests the inbound validation surface
///         of `BuybackRemittanceReceiver`. End-to-end CCIP delivery
///         lives in `TreasuryBuybackEndToEndTest`.
/// @dev A minimal contract used as the registered messenger so the
///      receiver's `code.length > 0` guard (Codex Sub 3.A round-2 P2
///      #2) passes. Doesn't need any methods — the receiver only
///      checks `msg.sender == messenger` for inbound trust.
contract MockMessengerStub {}

contract BuybackRemittanceReceiverTest is Test {
    BuybackRemittanceReceiver internal receiver;
    MockDiamondAbsorber internal absorber;
    ERC20Mock internal usdc;
    address internal owner = makeAddr("owner");
    address internal messenger;

    function setUp() public {
        absorber = new MockDiamondAbsorber();
        usdc = new ERC20Mock("USDC", "USDC", 6);
        // Codex Sub 3.A round-2 P2 #2 — messenger must be a contract.
        messenger = address(new MockMessengerStub());

        BuybackRemittanceReceiver impl = new BuybackRemittanceReceiver();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                BuybackRemittanceReceiver.initialize,
                (owner, messenger, address(absorber))
            )
        );
        receiver = BuybackRemittanceReceiver(payable(address(proxy)));
    }

    function _tokenAmount(address token, uint256 amount)
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory tokens)
    {
        tokens = new ICrossChainMessenger.TokenAmount[](1);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: token, amount: amount});
    }

    function _emptyTokens()
        internal
        pure
        returns (ICrossChainMessenger.TokenAmount[] memory tokens)
    {
        tokens = new ICrossChainMessenger.TokenAmount[](0);
    }

    function _twoTokens()
        internal
        view
        returns (ICrossChainMessenger.TokenAmount[] memory tokens)
    {
        tokens = new ICrossChainMessenger.TokenAmount[](2);
        tokens[0] = ICrossChainMessenger.TokenAmount({token: address(usdc), amount: 1});
        tokens[1] = ICrossChainMessenger.TokenAmount({token: address(usdc), amount: 1});
    }

    // ─── Init guard ──────────────────────────────────────────────────

    function test_Initialize_RevertWhen_ZeroOwner() public {
        BuybackRemittanceReceiver impl = new BuybackRemittanceReceiver();
        vm.expectRevert();
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                BuybackRemittanceReceiver.initialize,
                (address(0), messenger, address(absorber))
            )
        );
    }

    function test_Initialize_RevertWhen_ZeroMessenger() public {
        BuybackRemittanceReceiver impl = new BuybackRemittanceReceiver();
        vm.expectRevert();
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                BuybackRemittanceReceiver.initialize,
                (owner, address(0), address(absorber))
            )
        );
    }

    // ─── Inbound happy path ─────────────────────────────────────────

    function test_OnCrossChainMessage_HappyPath() public {
        uint256 amount = 1_000e6;
        // Simulate the CCIP router pre-funding the receiver with the
        // delivered token (the messenger forwards to the handler
        // before calling `onCrossChainMessage`).
        usdc.mint(address(receiver), amount);

        bytes memory payload = abi.encode(address(usdc));

        vm.prank(messenger);
        receiver.onCrossChainMessage(
            11_155_111, // Sepolia source chain id
            makeAddr("mirrorDiamond"),
            payload,
            _tokenAmount(address(usdc), amount)
        );

        // The receiver forwarded the token to the absorber + called
        // its ingress.
        assertEq(usdc.balanceOf(address(absorber)), amount, "token forwarded");
        assertEq(absorber.absorbCount(), 1, "absorb fired");
        assertEq(absorber.lastToken(), address(usdc), "token");
        assertEq(absorber.lastAmount(), amount, "amount");
        assertEq(absorber.lastSourceChain(), 11_155_111, "source chain");
    }

    // ─── Trust gate ─────────────────────────────────────────────────

    function test_OnCrossChainMessage_RevertWhen_NotMessenger() public {
        bytes memory payload = abi.encode(address(usdc));
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.NotMessenger.selector, address(this)
            )
        );
        receiver.onCrossChainMessage(
            1,
            makeAddr("mirrorDiamond"),
            payload,
            _tokenAmount(address(usdc), 1e6)
        );
    }

    // ─── Token-count validation ────────────────────────────────────

    function test_OnCrossChainMessage_RevertWhen_EmptyTokens() public {
        bytes memory payload = abi.encode(address(usdc));
        vm.prank(messenger);
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.WrongTokenCount.selector, uint256(0)
            )
        );
        receiver.onCrossChainMessage(
            1, address(0xdead), payload, _emptyTokens()
        );
    }

    function test_OnCrossChainMessage_RevertWhen_TwoTokens() public {
        bytes memory payload = abi.encode(address(usdc));
        vm.prank(messenger);
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.WrongTokenCount.selector, uint256(2)
            )
        );
        receiver.onCrossChainMessage(
            1, address(0xdead), payload, _twoTokens()
        );
    }

    // ─── Payload validation ────────────────────────────────────────

    function test_OnCrossChainMessage_RevertWhen_WrongSize() public {
        // Two-word payload (64 bytes) — does NOT match the canonical
        // 1-word (32-byte) shape.
        bytes memory longPayload = abi.encode(address(usdc), uint256(1));
        vm.prank(messenger);
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.PayloadSizeMismatch.selector,
                longPayload.length,
                uint256(32)
            )
        );
        receiver.onCrossChainMessage(
            1, address(0xdead), longPayload, _tokenAmount(address(usdc), 1)
        );
    }

    function test_OnCrossChainMessage_RevertWhen_TokenMismatch() public {
        ERC20Mock other = new ERC20Mock("DAI", "DAI", 18);
        bytes memory payload = abi.encode(address(other)); // declared != delivered

        usdc.mint(address(receiver), 1e6);

        vm.prank(messenger);
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.TokenMismatch.selector,
                address(other),
                address(usdc)
            )
        );
        receiver.onCrossChainMessage(
            1, address(0xdead), payload, _tokenAmount(address(usdc), 1e6)
        );
    }

    function test_OnCrossChainMessage_RevertWhen_ZeroAmount() public {
        bytes memory payload = abi.encode(address(usdc));
        vm.prank(messenger);
        vm.expectRevert(BuybackRemittanceReceiver.ZeroAmount.selector);
        receiver.onCrossChainMessage(
            1, address(0xdead), payload, _tokenAmount(address(usdc), 0)
        );
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function test_SetMessenger_HappyPath() public {
        address newMessenger = address(new MockMessengerStub());
        vm.prank(owner);
        receiver.setMessenger(newMessenger);
        assertEq(receiver.messenger(), newMessenger);
    }

    function test_SetMessenger_RevertWhen_NotOwner() public {
        address newMessenger = address(new MockMessengerStub());
        // Not pranking → msg.sender is the test contract, not owner.
        vm.expectRevert();
        receiver.setMessenger(newMessenger);
    }

    // ─── Round-2 P2 #2 — EOA guards ──────────────────────────────────

    function test_Initialize_RevertWhen_DiamondIsEOA() public {
        address eoaDiamond = makeAddr("eoaDiamond");
        BuybackRemittanceReceiver impl = new BuybackRemittanceReceiver();
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.NotAContract.selector, eoaDiamond
            )
        );
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                BuybackRemittanceReceiver.initialize,
                (owner, messenger, eoaDiamond)
            )
        );
    }

    function test_Initialize_RevertWhen_MessengerIsEOA() public {
        address eoaMessenger = makeAddr("eoaMessenger");
        BuybackRemittanceReceiver impl = new BuybackRemittanceReceiver();
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.NotAContract.selector, eoaMessenger
            )
        );
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                BuybackRemittanceReceiver.initialize,
                (owner, eoaMessenger, address(absorber))
            )
        );
    }

    function test_SetDiamond_RevertWhen_EOA() public {
        address eoaDiamond = makeAddr("eoaDiamond");
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                BuybackRemittanceReceiver.NotAContract.selector, eoaDiamond
            )
        );
        receiver.setDiamond(eoaDiamond);
    }
}
