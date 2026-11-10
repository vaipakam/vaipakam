// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SetupTest} from "./SetupTest.t.sol";
import {VaultProtection} from "../src/vault/VaultProtection.sol";
import {LibTestProtection} from "./helpers/LibTestProtection.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {VPFIToken} from "../src/token/VPFIToken.sol";
import {VPFITokenFacet} from "../src/facets/VPFITokenFacet.sol";
import {VPFIDiscountFacet} from "../src/facets/VPFIDiscountFacet.sol";
import {VaultDepositoryFacet} from "../src/facets/VaultDepositoryFacet.sol";
import {ProtectedAccountFacet} from "../src/facets/ProtectedAccountFacet.sol";
import {VaultPayoutFacet} from "../src/facets/VaultPayoutFacet.sol";
import {LibVaipakam} from "../src/libraries/LibVaipakam.sol";
import {LibProtectedAccount} from "../src/libraries/LibProtectedAccount.sol";

/// @title ProtectedVaultVpfiTest
/// @notice Staked VPFI is the owner's own deposit, so it is part of the
///         depository holding: the owner's unstake draws it down, and after a
///         primary replacement the controller can withdraw it through the
///         ordinary vault withdrawal (the unstake route is keyed to the old
///         wallet, which the replacement took the account away from).
contract ProtectedVaultVpfiTest is SetupTest {
    VPFIToken internal vpfi;
    address internal alice;
    address internal s1;
    address internal s2;
    address internal s3;
    address internal nominee;

    uint32 internal constant DELAY = 2 days;
    uint8 internal constant K20 = uint8(LibVaipakam.AssetType.ERC20);

    function setUp() public {
        setupHelper();
        VPFIToken impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(VPFIToken.initialize, (address(this), address(this), address(this)));
        vpfi = VPFIToken(address(new ERC1967Proxy(address(impl), initData)));
        VPFITokenFacet(address(diamond)).setCanonicalVPFIChain(true);
        VPFITokenFacet(address(diamond)).setVPFIToken(address(vpfi));
        vpfi.mint(address(this), 10_000_000 ether);
        alice = makeAddr("alice");
        s1 = makeAddr("s1");
        s2 = makeAddr("s2");
        s3 = makeAddr("s3");
        nominee = makeAddr("nominee");
        vpfi.mint(alice, 100_000 ether);
        vm.prank(alice);
        vpfi.approve(address(diamond), type(uint256).max);
    }

    function _f() internal view returns (VPFIDiscountFacet) {
        return VPFIDiscountFacet(address(diamond));
    }

    function _depo() internal view returns (VaultDepositoryFacet) {
        return VaultDepositoryFacet(address(diamond));
    }

    function _prot() internal view returns (ProtectedAccountFacet) {
        return ProtectedAccountFacet(address(diamond));
    }

    function _addSigner(address signer) internal {
        LibTestProtection.addSigner(address(diamond), alice, alice, signer, DELAY);
    }

    function testStakedVpfiJoinsTheDepositoryHoldingAndUnstakeDrawsItDown() public {
        vm.prank(alice);
        _f().depositVPFIToVault(100 ether);
        assertEq(_depo().getDepositoryHolding(alice, address(vpfi), 0), 100 ether);
        assertEq(_depo().withdrawableNow(alice, K20, address(vpfi), 0), 100 ether);

        vm.prank(alice);
        _f().withdrawVPFIFromVault(40 ether);
        assertEq(_depo().getDepositoryHolding(alice, address(vpfi), 0), 60 ether);

        // The ordinary withdrawal takes staked VPFI too.
        vm.prank(alice);
        _depo().withdrawFromVault(alice, K20, address(vpfi), 0, 60 ether, alice);
        assertEq(vpfi.balanceOf(alice), 100_000 ether);
        assertEq(_depo().getDepositoryHolding(alice, address(vpfi), 0), 0);
    }

    function testReplacementControllerRecoversStakedVpfi() public {
        vm.prank(alice);
        _f().depositVPFIToVault(100 ether);
        LibTestProtection.enableWithNfts(address(diamond), alice, DELAY);
        _addSigner(s1);
        _addSigner(s2);
        _addSigner(s3);
        vm.expectRevert(abi.encodeWithSelector(VaultProtection.BadNominee.selector, s2));
        LibTestProtection.propose(address(diamond), alice, s1, s2);
        LibTestProtection.propose(address(diamond), alice, s1, nominee);
        LibTestProtection.approve(address(diamond), alice, s2, nominee);
        vm.warp(block.timestamp + DELAY);
        LibTestProtection.finalizeReplacement(address(diamond), alice);

        // The retired wallet cannot unstake (it lost every right over the
        // account), and a signer cannot be the nominee (no wallet both
        // manages and co-signs).
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LibProtectedAccount.NotAccountManager.selector, alice, alice));
        _f().withdrawVPFIFromVault(1 ether);

        vm.prank(nominee);
        uint256 id = _depo().withdrawFromVault(alice, K20, address(vpfi), 0, 100 ether, nominee);
        assertTrue(id != 0);
        vm.warp(block.timestamp + DELAY);
        VaultPayoutFacet(address(diamond)).releasePayout(id);
        assertEq(vpfi.balanceOf(nominee), 100 ether);
    }

    /// A withdrawal the owner asks for ends paid, queued or refused, never
    /// held in the vault as a success that moved nothing: with the queue
    /// full the VPFI withdrawal is refused, and it queues again once a row
    /// clears.
    function testOwnVpfiWithdrawalIsRefusedWhenTheQueueIsFull() public {
        vm.prank(alice);
        _f().depositVPFIToVault(100 ether);
        LibTestProtection.enable(address(diamond), alice, DELAY);
        uint256 first;
        for (uint256 i; i < 16; ++i) {
            vm.prank(alice);
            uint256 id = _depo().withdrawFromVault(alice, K20, address(vpfi), 0, 1 ether, alice);
            if (i == 0) first = id;
        }
        vm.prank(alice);
        vm.expectRevert(LibProtectedAccount.TooManyPendingRows.selector);
        _f().withdrawVPFIFromVault(1 ether);

        vm.warp(block.timestamp + DELAY);
        VaultPayoutFacet(address(diamond)).releasePayout(first);
        uint256 walletBefore = vpfi.balanceOf(alice);
        vm.prank(alice);
        _f().withdrawVPFIFromVault(1 ether);
        // Queued, not paid now and not held.
        assertEq(vpfi.balanceOf(alice), walletBefore, "queued behind the delay");
        assertEq(_depo().getDepositoryHolding(alice, address(vpfi), 0), 100 ether - 17 ether, "debited when asked");
    }
}
