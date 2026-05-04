// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIBuyAdapter} from "../../src/token/VPFIBuyAdapter.sol";

/// @dev Mock LayerZero EndpointV2 with just enough surface for the
///      OApp constructor to store the address. The init path under
///      test runs `_assertPaymentTokenSane` BEFORE any endpoint
///      method is invoked, so a stub bytecode-bearing contract is
///      sufficient.
contract MockLZEndpoint {
    function eid() external pure returns (uint32) {
        return 40245;
    }
    function setDelegate(address) external {}
}

/// @dev WETH9-shape mock — 18 decimals, valid `decimals()` view.
contract MockWETH9 {
    function decimals() external pure returns (uint8) {
        return 18;
    }
    function name() external pure returns (string memory) {
        return "Wrapped Ether";
    }
    function symbol() external pure returns (string memory) {
        return "WETH";
    }
}

/// @dev USDC-shape mock — 6 decimals (the most common operator
///      misconfig: pasting USDC where WETH belongs).
contract MockUSDC {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}

/// @dev Contract that doesn't implement `decimals()` (catches the
///      operator pasting a non-ERC20 contract address).
contract NotAnERC20 {
    function thisIsNotDecimals() external pure returns (uint256) {
        return 42;
    }
}

/**
 * @title VPFIBuyAdapterPaymentTokenTest
 * @notice ToDo item 11 long-term — payment-token validation in
 *         {VPFIBuyAdapter.initialize} and {VPFIBuyAdapter.setPaymentToken}.
 *
 * Background: the receiver's wei-per-VPFI rate is denominated in
 * ETH-equivalent value. On non-ETH-native chains (BNB / Polygon
 * mainnet) the adapter MUST be in WETH-pull mode against a real
 * bridged-WETH ERC20 contract. Operator misconfigs at deploy time
 * (EOA address, USDC address, non-ERC20 contract) would silently
 * mis-price every buy or revert at first user interaction with no
 * useful surface.
 *
 * The two contract-side guards covered here:
 *   - `paymentToken != address(0)` must point at code (not EOA).
 *   - `decimals()` must be callable AND return exactly 18.
 *
 * What's NOT covered (and intentionally so):
 *   - "Is this the canonical WETH9 on this chain?" — there's no
 *     on-chain registry to validate against. That's an operational
 *     check (deploy-script pre-flight prints `name()`/`symbol()`
 *     for human-eyeball confirmation against the chain's
 *     published WETH9 address).
 *   - "Should this chain be in native-gas mode at all?" — caught
 *     by `DeployVPFIBuyAdapter.s.sol` chainId pre-flight, not by
 *     the contract.
 */
contract VPFIBuyAdapterPaymentTokenTest is Test {
    VPFIBuyAdapter internal impl;
    MockLZEndpoint internal lzEndpoint;
    MockWETH9 internal weth;
    MockUSDC internal usdc;
    NotAnERC20 internal nonErc20;

    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0xCAFE);
    uint32 internal constant RECEIVER_EID = 40245;
    uint64 internal constant REFUND_TIMEOUT = 900;

    function setUp() public {
        lzEndpoint = new MockLZEndpoint();
        impl = new VPFIBuyAdapter(address(lzEndpoint));
        weth = new MockWETH9();
        usdc = new MockUSDC();
        nonErc20 = new NotAnERC20();
    }

    /// @dev Internal helper — deploys a proxy with the given payment
    ///      token. Returns the adapter or reverts with whatever the
    ///      validation throws.
    function _deploy(address paymentToken) internal returns (VPFIBuyAdapter) {
        bytes memory initData = abi.encodeCall(
            VPFIBuyAdapter.initialize,
            (
                OWNER,
                RECEIVER_EID,
                TREASURY,
                paymentToken,
                bytes(""),
                REFUND_TIMEOUT
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        return VPFIBuyAdapter(payable(address(proxy)));
    }

    // ─── Init-time validation ───────────────────────────────────────────

    function test_initialize_AcceptsZeroAddressForNativeGasMode() public {
        VPFIBuyAdapter adapter = _deploy(address(0));
        assertEq(adapter.paymentToken(), address(0));
    }

    function test_initialize_AcceptsValidWETH9() public {
        VPFIBuyAdapter adapter = _deploy(address(weth));
        assertEq(adapter.paymentToken(), address(weth));
    }

    function test_initialize_RevertsWhenPaymentTokenIsEOA() public {
        // EOA address — no bytecode — caller's most common
        // typo-misconfig (e.g. pasted treasury address by mistake).
        address eoa = address(0xB0B);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.PaymentTokenNotContract.selector,
                eoa
            )
        );
        _deploy(eoa);
    }

    function test_initialize_RevertsWhenPaymentTokenHasWrongDecimals() public {
        // USDC-shape (6 decimals) — the most common
        // honest-mistake misconfig in mainnet deploys (USDC and
        // WETH addresses both end up in the same operator notes).
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.PaymentTokenDecimalsNot18.selector,
                address(usdc),
                uint8(6)
            )
        );
        _deploy(address(usdc));
    }

    function test_initialize_RevertsWhenPaymentTokenHasNoDecimals() public {
        // Non-ERC20 contract — `decimals()` call reverts (function
        // doesn't exist on the bytecode).
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.PaymentTokenDecimalsCallFailed.selector,
                address(nonErc20)
            )
        );
        _deploy(address(nonErc20));
    }

    // ─── setPaymentToken (rotation) — same validation surface ───────────

    function test_setPaymentToken_AcceptsZeroAddressRotation() public {
        VPFIBuyAdapter adapter = _deploy(address(weth));
        vm.prank(OWNER);
        adapter.setPaymentToken(address(0));
        assertEq(adapter.paymentToken(), address(0));
    }

    function test_setPaymentToken_AcceptsValidWETH9Rotation() public {
        VPFIBuyAdapter adapter = _deploy(address(0));
        vm.prank(OWNER);
        adapter.setPaymentToken(address(weth));
        assertEq(adapter.paymentToken(), address(weth));
    }

    function test_setPaymentToken_RevertsWhenRotatingToEOA() public {
        VPFIBuyAdapter adapter = _deploy(address(weth));
        address eoa = address(0xB0B);
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.PaymentTokenNotContract.selector,
                eoa
            )
        );
        adapter.setPaymentToken(eoa);
    }

    function test_setPaymentToken_RevertsWhenRotatingToWrongDecimals() public {
        VPFIBuyAdapter adapter = _deploy(address(weth));
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.PaymentTokenDecimalsNot18.selector,
                address(usdc),
                uint8(6)
            )
        );
        adapter.setPaymentToken(address(usdc));
    }

    function test_setPaymentToken_RevertsWhenRotatingToNonERC20() public {
        VPFIBuyAdapter adapter = _deploy(address(weth));
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIBuyAdapter.PaymentTokenDecimalsCallFailed.selector,
                address(nonErc20)
            )
        );
        adapter.setPaymentToken(address(nonErc20));
    }
}
