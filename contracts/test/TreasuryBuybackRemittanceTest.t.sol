// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TreasuryFacet} from "../src/facets/TreasuryFacet.sol";
import {CcipMessenger} from "../src/crosschain/CcipMessenger.sol";
import {BuybackRemittanceReceiver} from "../src/crosschain/BuybackRemittanceReceiver.sol";
import {ICrossChainMessenger} from "../src/crosschain/ICrossChainMessenger.sol";
import {MockCcipRouter} from "./mocks/MockCcipRouter.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title TreasuryBuybackRemittanceTest
/// @notice T-087 Sub 3.A — admin surface + invariants + the BuybackRemittanceReceiver
///         inbound validation.
///         The CCIP-router-driven end-to-end send → receive test runs in
///         a sibling test file so this file stays focused on the
///         per-facet invariants (allow-list / no-convert / budget /
///         sender-only / payload validation).
contract TreasuryBuybackRemittanceTest is SetupTest {
    ERC20Mock internal usdcMirror;
    address internal receiver;
    address internal messenger;
    uint256 internal constant BASE_CHAIN = 8453;

    function setUp() public {
        setupHelper();
        usdcMirror = new ERC20Mock("USDC", "USDC", 6);
        receiver = makeAddr("buybackReceiver");
        messenger = makeAddr("ccipMessenger");
    }

    function _t() internal view returns (TreasuryFacet) {
        return TreasuryFacet(address(diamond));
    }

    // ─── Admin setters ────────────────────────────────────────────────

    function test_SetBuybackAllowedToken_HappyPath() public {
        _t().setBuybackAllowedToken(BASE_CHAIN, address(usdcMirror), true);
        assertTrue(_t().isBuybackAllowedToken(BASE_CHAIN, address(usdcMirror)));

        _t().setBuybackAllowedToken(BASE_CHAIN, address(usdcMirror), false);
        assertFalse(_t().isBuybackAllowedToken(BASE_CHAIN, address(usdcMirror)));
    }

    function test_SetBuybackAllowedToken_RevertWhen_ZeroToken() public {
        vm.expectRevert();
        _t().setBuybackAllowedToken(BASE_CHAIN, address(0), true);
    }

    function test_SetBuybackAllowedToken_RevertWhen_NotAdmin() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert();
        _t().setBuybackAllowedToken(BASE_CHAIN, address(usdcMirror), true);
    }

    function test_SetBuybackNoConvert_HappyPath() public {
        _t().setBuybackNoConvert(address(usdcMirror), true);
        assertTrue(_t().isBuybackNoConvert(address(usdcMirror)));
    }

    function test_SetBuybackRemittanceReceiver_HappyPath() public {
        _t().setBuybackRemittanceReceiver(receiver);
        assertEq(_t().getBuybackRemittanceReceiver(), receiver);
    }

    function test_SetBuybackRemittanceReceiver_RevertWhen_Zero() public {
        vm.expectRevert(TreasuryFacet.TreasuryZeroAddress.selector);
        _t().setBuybackRemittanceReceiver(address(0));
    }

    function test_SetCrossChainMessenger_HappyPath() public {
        _t().setCrossChainMessenger(messenger);
        assertEq(_t().getCrossChainMessenger(), messenger);
    }

    function test_SetCrossChainMessenger_RevertWhen_Zero() public {
        vm.expectRevert(TreasuryFacet.TreasuryZeroAddress.selector);
        _t().setCrossChainMessenger(address(0));
    }

    // ─── remitBuyback invariants ──────────────────────────────────────

    function test_RemitBuyback_RevertWhen_NoConvertList() public {
        _t().setBuybackNoConvert(address(usdcMirror), true);
        _t().setBuybackAllowedToken(BASE_CHAIN, address(usdcMirror), true);
        _t().setCrossChainMessenger(messenger);

        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryFacet.BuybackTokenNoConvert.selector, address(usdcMirror)
            )
        );
        _t().remitBuyback(address(usdcMirror), 1e6, payable(address(this)));
    }

    function test_RemitBuyback_RevertWhen_NotAllowed() public {
        _t().setCrossChainMessenger(messenger);
        // Token NOT added to allow-list.
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryFacet.BuybackTokenNotAllowed.selector,
                block.chainid,
                address(usdcMirror)
            )
        );
        _t().remitBuyback(address(usdcMirror), 1e6, payable(address(this)));
    }

    function test_RemitBuyback_RevertWhen_MessengerNotSet() public {
        _t().setBuybackAllowedToken(block.chainid, address(usdcMirror), true);
        // Seed budget so the prior `InsufficientBuybackBudget` check
        // doesn't shadow the messenger guard.
        _t().setBuybackRemittanceReceiver(receiver);
        vm.prank(receiver);
        _t().absorbRemittance(address(usdcMirror), 1e6, 1);
        // Don't set messenger.
        vm.expectRevert(TreasuryFacet.CrossChainMessengerNotSet.selector);
        _t().remitBuyback(address(usdcMirror), 1e6, payable(address(this)));
    }

    function test_RemitBuyback_RevertWhen_ZeroAmount() public {
        vm.expectRevert(TreasuryFacet.ZeroAmount.selector);
        _t().remitBuyback(address(usdcMirror), 0, payable(address(this)));
    }

    // ─── absorbRemittance invariants ──────────────────────────────────

    function test_AbsorbRemittance_RevertWhen_NotReceiver() public {
        _t().setBuybackRemittanceReceiver(receiver);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryFacet.OnlyBuybackRemittanceReceiver.selector,
                address(this)
            )
        );
        _t().absorbRemittance(address(usdcMirror), 100e6, 11_155_111);
    }

    function test_AbsorbRemittance_CreditsBudget() public {
        _t().setBuybackRemittanceReceiver(receiver);
        uint256 amount = 250e6;

        vm.expectEmit(true, false, true, true, address(diamond));
        emit TreasuryFacet.BuybackRemittanceAbsorbed(
            address(usdcMirror), amount, 11_155_111
        );

        vm.prank(receiver);
        _t().absorbRemittance(address(usdcMirror), amount, 11_155_111);

        assertEq(_t().getBuybackBudget(address(usdcMirror)), amount);
    }

    function test_AbsorbRemittance_Additive() public {
        _t().setBuybackRemittanceReceiver(receiver);
        vm.startPrank(receiver);
        _t().absorbRemittance(address(usdcMirror), 100e6, 1);
        _t().absorbRemittance(address(usdcMirror), 50e6, 1);
        vm.stopPrank();
        assertEq(_t().getBuybackBudget(address(usdcMirror)), 150e6);
    }
}
