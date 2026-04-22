// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VPFIToken} from "../../src/token/VPFIToken.sol";
import {IVPFIToken} from "../../src/interfaces/IVPFIToken.sol";
import {IVaipakamErrors} from "../../src/interfaces/IVaipakamErrors.sol";

/// @title VPFITokenTest
/// @notice Phase 2 Token core coverage. Verifies the Phase 2 tokenomics
///         invariants called out in docs/TokenomicsTechSpec.md:
///         hard cap (230M), initial mint (23M / 10% of cap), single
///         timelock-gated mint path, pause brake, and UUPS upgrade
///         authorization gating.
contract VPFITokenTest is Test {
    VPFIToken internal token;
    VPFIToken internal impl;

    address internal constant OWNER = address(0xA11CE);
    address internal constant RECIPIENT = address(0xCAFE);
    address internal constant MINTER = address(0xBEEF);
    address internal constant ALICE = address(0xA1);
    address internal constant BOB = address(0xB0B);

    event MinterUpdated(address indexed previousMinter, address indexed newMinter);
    event Minted(address indexed to, uint256 amount);

    function setUp() public {
        impl = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (OWNER, RECIPIENT, MINTER)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        token = VPFIToken(address(proxy));
    }

    // ─── Metadata ────────────────────────────────────────────────────────────

    function testMetadata() public view {
        assertEq(token.name(), "Vaipakam DeFi Token");
        assertEq(token.symbol(), "VPFI");
        assertEq(token.decimals(), 18);
        assertEq(token.TOTAL_SUPPLY_CAP(), 230_000_000 ether);
        assertEq(token.INITIAL_MINT(), 23_000_000 ether);
        assertEq(token.cap(), 230_000_000 ether);
    }

    // ─── Initialization ──────────────────────────────────────────────────────

    function testInitialMint() public view {
        assertEq(token.balanceOf(RECIPIENT), 23_000_000 ether);
        assertEq(token.totalSupply(), 23_000_000 ether);
    }

    function testInitialMinterConfigured() public view {
        assertEq(token.minter(), MINTER);
    }

    function testInitialOwner() public view {
        assertEq(token.owner(), OWNER);
    }

    function testInitializeRevertsOnZeroOwner() public {
        VPFIToken fresh = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (address(0), RECIPIENT, MINTER)
        );
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        new ERC1967Proxy(address(fresh), initData);
    }

    function testInitializeRevertsOnZeroRecipient() public {
        VPFIToken fresh = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (OWNER, address(0), MINTER)
        );
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        new ERC1967Proxy(address(fresh), initData);
    }

    function testInitializeRevertsOnZeroMinter() public {
        VPFIToken fresh = new VPFIToken();
        bytes memory initData = abi.encodeCall(
            VPFIToken.initialize,
            (OWNER, RECIPIENT, address(0))
        );
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        new ERC1967Proxy(address(fresh), initData);
    }

    function testInitializeCannotBeCalledTwice() public {
        vm.expectRevert();
        token.initialize(OWNER, RECIPIENT, MINTER);
    }

    function testImplementationInitializersDisabled() public {
        vm.expectRevert();
        impl.initialize(OWNER, RECIPIENT, MINTER);
    }

    // ─── mint() access control ───────────────────────────────────────────────

    function testMintOnlyByMinter() public {
        vm.prank(ALICE);
        vm.expectRevert(IVPFIToken.NotMinter.selector);
        token.mint(ALICE, 1 ether);
    }

    function testMintRevertsOnZeroTo() public {
        vm.prank(MINTER);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        token.mint(address(0), 1 ether);
    }

    function testMintRevertsOnZeroAmount() public {
        vm.prank(MINTER);
        vm.expectRevert(IVaipakamErrors.InvalidAmount.selector);
        token.mint(ALICE, 0);
    }

    function testMintEmitsMintedAndTransfer() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit Minted(ALICE, 1 ether);
        vm.prank(MINTER);
        token.mint(ALICE, 1 ether);
        assertEq(token.balanceOf(ALICE), 1 ether);
        assertEq(token.totalSupply(), 23_000_000 ether + 1 ether);
    }

    // ─── Supply cap enforcement ──────────────────────────────────────────────

    function testMintToCapSucceeds() public {
        uint256 remaining = token.cap() - token.totalSupply();
        vm.prank(MINTER);
        token.mint(ALICE, remaining);
        assertEq(token.totalSupply(), token.cap());
    }

    function testMintPastCapReverts() public {
        uint256 remaining = token.cap() - token.totalSupply();
        vm.prank(MINTER);
        token.mint(ALICE, remaining);

        vm.prank(MINTER);
        vm.expectRevert();
        token.mint(ALICE, 1);
    }

    function testSingleMintExceedingCapReverts() public {
        uint256 oversized = token.cap() - token.totalSupply() + 1;
        vm.prank(MINTER);
        vm.expectRevert();
        token.mint(ALICE, oversized);
    }

    // ─── setMinter() ─────────────────────────────────────────────────────────

    function testSetMinterOnlyByOwner() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.setMinter(ALICE);
    }

    function testSetMinterRevertsOnZero() public {
        vm.prank(OWNER);
        vm.expectRevert(IVaipakamErrors.InvalidAddress.selector);
        token.setMinter(address(0));
    }

    function testSetMinterRotatesAndEmits() public {
        vm.expectEmit(true, true, false, false, address(token));
        emit MinterUpdated(MINTER, ALICE);
        vm.prank(OWNER);
        token.setMinter(ALICE);
        assertEq(token.minter(), ALICE);

        vm.prank(MINTER);
        vm.expectRevert(IVPFIToken.NotMinter.selector);
        token.mint(BOB, 1 ether);

        vm.prank(ALICE);
        token.mint(BOB, 1 ether);
        assertEq(token.balanceOf(BOB), 1 ether);
    }

    // ─── Pause controls ──────────────────────────────────────────────────────

    function testPauseOnlyByOwner() public {
        vm.prank(ALICE);
        vm.expectRevert();
        token.pause();
    }

    function testPauseBlocksMint() public {
        vm.prank(OWNER);
        token.pause();

        vm.prank(MINTER);
        vm.expectRevert();
        token.mint(ALICE, 1 ether);
    }

    function testPauseBlocksTransfer() public {
        vm.prank(RECIPIENT);
        token.transfer(ALICE, 100 ether);

        vm.prank(OWNER);
        token.pause();

        vm.prank(ALICE);
        vm.expectRevert();
        token.transfer(BOB, 1 ether);
    }

    function testUnpauseRestoresTransfers() public {
        vm.prank(OWNER);
        token.pause();
        vm.prank(OWNER);
        token.unpause();

        vm.prank(MINTER);
        token.mint(ALICE, 1 ether);
        assertEq(token.balanceOf(ALICE), 1 ether);
    }

    // ─── Burnable ────────────────────────────────────────────────────────────

    function testBurnReducesSupplyAndCanRemintWithinCap() public {
        vm.prank(RECIPIENT);
        token.burn(1_000 ether);
        assertEq(token.totalSupply(), 23_000_000 ether - 1_000 ether);

        // Burn should free headroom under the cap.
        uint256 headroom = token.cap() - token.totalSupply();
        assertEq(headroom, 230_000_000 ether - 23_000_000 ether + 1_000 ether);

        vm.prank(MINTER);
        token.mint(ALICE, 1_000 ether);
        assertEq(token.totalSupply(), 23_000_000 ether);
    }

    // ─── UUPS upgrade authorization ──────────────────────────────────────────

    function testUpgradeOnlyByOwner() public {
        VPFIToken nextImpl = new VPFIToken();
        vm.prank(ALICE);
        vm.expectRevert();
        token.upgradeToAndCall(address(nextImpl), "");
    }

    function testOwnerCanUpgradeAndStatePreserved() public {
        VPFIToken nextImpl = new VPFIToken();
        vm.prank(OWNER);
        token.upgradeToAndCall(address(nextImpl), "");

        assertEq(token.totalSupply(), 23_000_000 ether);
        assertEq(token.balanceOf(RECIPIENT), 23_000_000 ether);
        assertEq(token.minter(), MINTER);
        assertEq(token.owner(), OWNER);
        assertEq(token.cap(), 230_000_000 ether);
    }
}
