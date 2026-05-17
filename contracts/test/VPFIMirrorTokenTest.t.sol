// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {VPFIMirrorToken} from "../src/crosschain/VPFIMirrorToken.sol";
import {GuardianPausable} from "../src/crosschain/GuardianPausable.sol";

/**
 * @title VPFIMirrorTokenTest
 * @notice T-068 Phase 2 — unit tests for the CCT mirror VPFI token: the
 *         pool-only mint/burn surface (no admin/EOA mint path), guardian
 *         + owner pause, and the unified token identity.
 */
contract VPFIMirrorTokenTest is Test {
    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal pool = makeAddr("pool");
    address internal stranger = makeAddr("stranger");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    VPFIMirrorToken internal vpfi;

    function setUp() public {
        VPFIMirrorToken impl = new VPFIMirrorToken();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(VPFIMirrorToken.initialize, (owner))
        );
        vpfi = VPFIMirrorToken(address(proxy));
        vm.startPrank(owner);
        vpfi.setTokenPool(pool);
        vpfi.setGuardian(guardian);
        vm.stopPrank();
    }

    // ─── Identity ───────────────────────────────────────────────────────────

    function test_TokenIdentity() public view {
        assertEq(vpfi.name(), "Vaipakam DeFi Token", "name");
        assertEq(vpfi.symbol(), "VPFI", "symbol");
        assertEq(vpfi.decimals(), 18, "decimals");
        assertEq(vpfi.totalSupply(), 0, "no premine on a mirror");
    }

    // ─── Mint — pool only ───────────────────────────────────────────────────

    function test_Mint_ByPool() public {
        vm.prank(pool);
        vpfi.mint(alice, 1_000 ether);
        assertEq(vpfi.balanceOf(alice), 1_000 ether, "minted to alice");
        assertEq(vpfi.totalSupply(), 1_000 ether, "supply tracks bridged-in");
    }

    function test_Mint_RevertWhen_NotPool() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIMirrorToken.NotTokenPool.selector, stranger
            )
        );
        vpfi.mint(alice, 1_000 ether);
    }

    function test_Mint_RevertWhen_OwnerTriesToMint() public {
        // There is NO admin mint path — even the owner cannot mint.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIMirrorToken.NotTokenPool.selector, owner
            )
        );
        vpfi.mint(alice, 1_000 ether);
    }

    // ─── Burn — pool only, burns the caller's balance ───────────────────────

    function test_Burn_ByPool_ReducesSupply() public {
        vm.startPrank(pool);
        vpfi.mint(pool, 5_000 ether);
        vpfi.burn(2_000 ether);
        vm.stopPrank();
        assertEq(vpfi.balanceOf(pool), 3_000 ether, "pool balance burned");
        assertEq(vpfi.totalSupply(), 3_000 ether, "supply reduced");
    }

    function test_Burn_RevertWhen_NotPool() public {
        vm.prank(pool);
        vpfi.mint(stranger, 1_000 ether);
        // A holder cannot burn — burn is pool-only so mirror supply stays
        // exactly equal to the VPFI bridged in.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                VPFIMirrorToken.NotTokenPool.selector, stranger
            )
        );
        vpfi.burn(1_000 ether);
    }

    // ─── Pool management ────────────────────────────────────────────────────

    function test_SetTokenPool_OnlyOwner() public {
        address newPool = makeAddr("newPool");
        vm.prank(owner);
        vpfi.setTokenPool(newPool);
        assertEq(vpfi.tokenPool(), newPool, "pool rotated");
        // The old pool loses mint rights.
        vm.prank(pool);
        vm.expectRevert(
            abi.encodeWithSelector(VPFIMirrorToken.NotTokenPool.selector, pool)
        );
        vpfi.mint(alice, 1 ether);
    }

    function test_SetTokenPool_RevertWhen_NotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                stranger
            )
        );
        vpfi.setTokenPool(makeAddr("x"));
    }

    function test_SetTokenPool_RevertWhen_Zero() public {
        vm.prank(owner);
        vm.expectRevert(VPFIMirrorToken.ZeroAddress.selector);
        vpfi.setTokenPool(address(0));
    }

    // ─── Transfers ──────────────────────────────────────────────────────────

    function test_Transfer_Works() public {
        vm.prank(pool);
        vpfi.mint(alice, 1_000 ether);
        vm.prank(alice);
        vpfi.transfer(bob, 400 ether);
        assertEq(vpfi.balanceOf(alice), 600 ether, "alice debited");
        assertEq(vpfi.balanceOf(bob), 400 ether, "bob credited");
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    function test_Pause_FreezesMintAndTransfer() public {
        vm.prank(pool);
        vpfi.mint(alice, 1_000 ether);

        vm.prank(guardian);
        vpfi.pause();

        vm.prank(pool);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vpfi.mint(alice, 1 ether);

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vpfi.transfer(bob, 1 ether);
    }

    function test_Pause_GuardianPauses_OwnerUnpauses() public {
        vm.prank(guardian);
        vpfi.pause();
        assertTrue(vpfi.paused(), "paused");

        // Guardian cannot unpause — recovery is owner-only.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                OwnableUpgradeable.OwnableUnauthorizedAccount.selector,
                guardian
            )
        );
        vpfi.unpause();

        vm.prank(owner);
        vpfi.unpause();
        assertFalse(vpfi.paused(), "owner unpaused");
    }

    function test_Pause_RevertWhen_StrangerPauses() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardianPausable.NotGuardianOrOwner.selector, stranger
            )
        );
        vpfi.pause();
    }

    // ─── Init ───────────────────────────────────────────────────────────────

    function test_Initialize_RevertWhen_CalledTwice() public {
        vm.expectRevert();
        vpfi.initialize(owner);
    }
}
