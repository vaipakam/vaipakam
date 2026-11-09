// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ArtifactDeploy} from "../script/lib/ArtifactDeploy.sol";
import {PositionNFT, IPositionRenderer, IPositionTransferCheck} from "../src/PositionNFT.sol";

/// @dev Stands in for the Diamond: the minter, the renderer and the
///      transfer check, with a switch that makes the check refuse.
contract MockPositionDiamond is IPositionRenderer, IPositionTransferCheck {
    bool public refuse;
    uint256 public checks;
    address public lastFrom;
    address public lastTo;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function tokenURI(uint256 tokenId) external pure returns (string memory) {
        return string(abi.encodePacked("uri-", bytes1(uint8(48 + (tokenId % 10)))));
    }

    function contractURI() external pure returns (string memory) {
        return "collection";
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (address(this), salePrice / 100);
    }

    function checkPositionTransfer(address, address from, address to, uint256) external {
        if (refuse) revert("refused");
        ++checks;
        lastFrom = from;
        lastTo = to;
    }
}

/// @title PositionNFTTest
/// @notice #3205 — the standalone position NFT core: the Diamond may only
///         mint (and use the narrow lock powers), every transfer counts and
///         passes the check, the holder lock holds by itself, and components
///         change only through the delayed two-step.
contract PositionNFTTest is Test {
    PositionNFT internal nft;
    MockPositionDiamond internal diamond;
    address internal timelock = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal operator = makeAddr("operator");

    function setUp() public {
        diamond = new MockPositionDiamond();
        nft = PositionNFT(
            ArtifactDeploy.deploy(
                type(PositionNFT).name,
                abi.encode(timelock, address(diamond), guardian, address(diamond), address(diamond))
            )
        );
    }

    function _mint(address to, uint256 id) internal {
        vm.prank(address(diamond));
        nft.mint(to, id);
    }

    // ─── The Diamond's rights ────────────────────────────────────────────

    function test_onlyTheDiamondMints() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NotDiamond.selector, alice));
        nft.mint(alice, 1);
        _mint(alice, 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.holderOf(1), alice);
        assertEq(nft.holderOf(2), address(0), "never minted reads 0");
        assertEq(nft.transferCount(1), 0, "a mint is not a transfer");
        assertEq(diamond.checks(), 0, "a mint is not shown to the check");
    }

    function test_theDiamondCannotMoveAToken() public {
        _mint(alice, 1);
        vm.prank(address(diamond));
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(diamond), 1)
        );
        nft.transferFrom(alice, bob, 1);
        // There is no burn entry at all.
        (bool ok, ) = address(nft).call(abi.encodeWithSignature("burn(uint256)", 1));
        assertFalse(ok, "no burn");
        assertEq(nft.ownerOf(1), alice);
    }

    // ─── Transfers count and are checked ─────────────────────────────────

    function test_everyTransferCountsAndIsChecked_awayAndBackIsTwo() public {
        _mint(alice, 1);
        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);
        vm.prank(bob);
        nft.safeTransferFrom(bob, alice, 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.transferCount(1), 2, "moved away and back counts two");
        assertEq(diamond.checks(), 2);
        assertEq(diamond.lastFrom(), bob);
        assertEq(diamond.lastTo(), alice);
    }

    function test_theCheckCanRefuseATransfer() public {
        _mint(alice, 1);
        diamond.setRefuse(true);
        vm.prank(alice);
        vm.expectRevert(bytes("refused"));
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.transferCount(1), 0);
    }

    function test_rendererDrawsTokenAndCollection() public {
        _mint(alice, 3);
        assertEq(nft.tokenURI(3), "uri-3");
        assertEq(nft.contractURI(), "collection");
        (address r, uint256 amt) = nft.royaltyInfo(3, 1000);
        assertEq(r, address(diamond));
        assertEq(amt, 10);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 4));
        nft.tokenURI(4);
        assertTrue(nft.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(nft.supportsInterface(0x780e9d63), "ERC-721 Enumerable");
        assertTrue(nft.supportsInterface(0x2a55205a), "EIP-2981");
    }

    // ─── The holder lock ─────────────────────────────────────────────────

    function test_aLockedHolderNeitherMovesNorApproves_andAMintIsLockedFromTheStart() public {
        vm.prank(alice);
        nft.lock();
        _mint(alice, 1);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, alice));
        nft.transferFrom(alice, bob, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, alice));
        nft.approve(operator, 1);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.HolderIsLocked.selector, alice));
        nft.setApprovalForAll(operator, true);
        // Revoking is always allowed.
        nft.setApprovalForAll(operator, false);
        vm.stopPrank();
    }

    function test_approvalsGrantedBeforeALockAreNotHonouredAfterIt() public {
        _mint(alice, 1);
        _mint(alice, 2);
        vm.startPrank(alice);
        nft.setApprovalForAll(operator, true);
        nft.approve(bob, 2);
        nft.lock();
        vm.stopPrank();
        assertFalse(nft.isApprovedForAll(alice, operator), "operator ignored while locked");
        assertEq(nft.getApproved(2), address(0), "token approval ignored while locked");
        // Unlock (delay 0: immediate) — the pre-lock approvals stay retired.
        vm.prank(alice);
        nft.requestUnlock();
        assertFalse(nft.isLocked(alice));
        assertFalse(nft.isApprovedForAll(alice, operator), "pre-lock operator stays stale");
        assertEq(nft.getApproved(2), address(0), "pre-lock token approval stays stale");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, operator, 1));
        nft.transferFrom(alice, operator, 1);
        // A fresh approval after the unlock works.
        vm.prank(alice);
        nft.setApprovalForAll(operator, true);
        vm.prank(operator);
        nft.transferFrom(alice, operator, 1);
        assertEq(nft.ownerOf(1), operator);
    }

    function test_unlockWaitsTheDelay_lockAgainDropsIt() public {
        vm.startPrank(alice);
        nft.setLockDelay(2 days);
        nft.lock();
        nft.requestUnlock();
        vm.stopPrank();
        (, , uint256 at, , ) = nft.lockOf(alice);
        assertEq(at, block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.TooEarly.selector, at));
        nft.executeUnlock(alice);
        // Locking again drops the pending unlock.
        vm.prank(alice);
        nft.lock();
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NoUnlockPending.selector, alice));
        nft.executeUnlock(alice);
        vm.prank(alice);
        nft.requestUnlock();
        // `at + 2 days`, not `block.timestamp + 2 days`: under viaIR the
        // timestamp read can be the pre-warp value.
        vm.warp(at + 2 days);
        nft.executeUnlock(alice);
        assertFalse(nft.isLocked(alice));
    }

    function test_aLoweringWaitsTheOldDelay_andAnyRaiseDropsIt() public {
        vm.startPrank(alice);
        nft.setLockDelay(5 days);
        nft.setLockDelay(1 days); // a lowering: waits 5 days
        vm.stopPrank();
        (, uint256 delay, , uint256 lowerDelay, uint256 lowerAt) = nft.lockOf(alice);
        assertEq(delay, 5 days);
        assertEq(lowerDelay, 1 days);
        assertEq(lowerAt, block.timestamp + 5 days);
        // A Diamond raise drops the pending lowering.
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.DelayNotHigher.selector, 5 days, 5 days));
        nft.raiseLockDelay(alice, 5 days);
        vm.prank(alice);
        nft.setLockDelay(6 days);
        (, delay, , , lowerAt) = nft.lockOf(alice);
        assertEq(delay, 6 days);
        assertEq(lowerAt, 0, "a raise drops the lowering");
        // A new lowering matures after the delay that held it.
        vm.prank(alice);
        nft.setLockDelay(0);
        vm.warp(block.timestamp + 6 days);
        nft.executeLockDelay(alice);
        (, delay, , , ) = nft.lockOf(alice);
        assertEq(delay, 0);
    }

    function test_everyDelayIsBounded() public {
        uint256 max = nft.MAX_LOCK_DELAY();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.DelayTooLong.selector, max + 1, max));
        nft.setLockDelay(max + 1);
        uint256 cap = nft.MAX_DIAMOND_LOCK_DELAY();
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.DelayAboveDiamondCap.selector, cap + 1, cap));
        nft.raiseLockDelay(alice, cap + 1);
        vm.prank(alice);
        nft.setLockDelay(max);
        (, uint256 delay, , , ) = nft.lockOf(alice);
        assertEq(delay, max, "the holder may go to the max");
    }

    function test_theDiamondLocksAndVoidsButNeverUnlocks() public {
        _mint(alice, 1);
        vm.prank(address(diamond));
        nft.lockFor(alice);
        assertTrue(nft.isLocked(alice));
        vm.prank(address(diamond));
        nft.raiseLockDelay(alice, 1 days);
        vm.prank(alice);
        nft.requestUnlock();
        vm.prank(address(diamond));
        nft.voidPending(alice);
        (, , uint256 at, , ) = nft.lockOf(alice);
        assertEq(at, 0, "voided");
        vm.prank(address(diamond));
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NoUnlockPending.selector, alice));
        nft.executeUnlock(alice);
        assertTrue(nft.isLocked(alice));
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? bob : (i == 1 ? timelock : guardian);
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(PositionNFT.NotDiamond.selector, who));
            nft.lockFor(alice);
        }
    }

    // ─── Pending sets (keeper reads) ─────────────────────────────────────

    function _pendingUnlockHolders() internal view returns (address[] memory h) {
        (h, ) = nft.pendingUnlocks(0, 100);
    }

    /// @notice Every path that opens or closes a pending unlock keeps the set
    ///         in step: request adds; cancel, execute, re-lock and the
    ///         Diamond's void remove.
    function test_pendingUnlockSetFollowsEveryWriter() public {
        address[3] memory who = [alice, bob, operator];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(who[i]);
            nft.setLockDelay(1 days);
            nft.lock();
            nft.requestUnlock();
            vm.stopPrank();
        }
        assertEq(nft.pendingUnlockCount(), 3);
        (address[] memory h, uint256[] memory at) = nft.pendingUnlocks(1, 1);
        assertEq(h.length, 1);
        assertEq(at[0], block.timestamp + 1 days);
        (h, ) = nft.pendingUnlocks(5, 10);
        assertEq(h.length, 0, "past the end reads empty");
        (h, ) = nft.pendingUnlocks(1, type(uint256).max);
        assertEq(h.length, 2, "an overflowing limit stops at the end");

        vm.prank(alice);
        nft.cancelUnlock();
        vm.prank(bob);
        nft.lock(); // re-locking drops the pending unlock
        vm.prank(address(diamond));
        nft.voidPending(operator);
        assertEq(nft.pendingUnlockCount(), 0);

        vm.prank(alice);
        nft.requestUnlock();
        vm.warp(block.timestamp + 1 days);
        nft.executeUnlock(alice);
        assertEq(_pendingUnlockHolders().length, 0, "execute removes");
    }

    /// @notice An unlock with no delay applies at once and never enters the set.
    function test_anImmediateUnlockIsNeverPending() public {
        vm.startPrank(alice);
        nft.lock();
        nft.requestUnlock();
        vm.stopPrank();
        assertFalse(nft.isLocked(alice));
        assertEq(nft.pendingUnlockCount(), 0);
    }

    /// @notice The pending lowering set: a lowering adds; its execution, a
    ///         raise (the holder's or the Diamond's) and the Diamond's void
    ///         remove.
    function test_pendingDelayChangeSetFollowsEveryWriter() public {
        vm.startPrank(alice);
        nft.setLockDelay(3 days);
        nft.setLockDelay(1 days);
        vm.stopPrank();
        vm.startPrank(bob);
        nft.setLockDelay(2 days);
        nft.setLockDelay(0);
        vm.stopPrank();
        assertEq(nft.pendingDelayChangeCount(), 2);
        (address[] memory h, uint256[] memory d, uint256[] memory at) = nft.pendingDelayChanges(0, 10);
        assertEq(h.length, 2);
        for (uint256 i; i < 2; ++i) {
            if (h[i] == alice) {
                assertEq(d[i], 1 days);
                assertEq(at[i], block.timestamp + 3 days);
            } else {
                assertEq(h[i], bob);
                assertEq(d[i], 0);
            }
        }
        vm.prank(address(diamond));
        nft.raiseLockDelay(bob, 3 days); // a raise drops bob's lowering
        assertEq(nft.pendingDelayChangeCount(), 1);
        vm.prank(address(diamond));
        nft.voidPending(alice);
        assertEq(nft.pendingDelayChangeCount(), 0);

        vm.startPrank(alice);
        nft.setLockDelay(0);
        vm.stopPrank();
        vm.warp(block.timestamp + 3 days);
        nft.executeLockDelay(alice);
        assertEq(nft.pendingDelayChangeCount(), 0, "execute removes");
    }

    // ─── Components ──────────────────────────────────────────────────────

    function test_componentChangeWaitsTheDelay_guardianCancels() public {
        MockPositionDiamond next = new MockPositionDiamond();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        nft.proposeComponent(PositionNFT.Component.Renderer, address(next));
        vm.prank(timelock);
        nft.proposeComponent(PositionNFT.Component.Renderer, address(next));
        (, uint256 at) = nft.pendingComponentOf(PositionNFT.Component.Renderer);
        assertEq(at, block.timestamp + nft.MIN_COMPONENT_DELAY());
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.TooEarly.selector, at));
        nft.executeComponent(PositionNFT.Component.Renderer);
        vm.prank(guardian);
        nft.cancelComponent(PositionNFT.Component.Renderer);
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(PositionNFT.NoProposal.selector, PositionNFT.Component.Renderer));
        nft.executeComponent(PositionNFT.Component.Renderer);
        // Proposed again and executed after the delay.
        vm.prank(timelock);
        nft.proposeComponent(PositionNFT.Component.TransferCheck, address(0));
        vm.warp(block.timestamp + nft.MIN_COMPONENT_DELAY());
        nft.executeComponent(PositionNFT.Component.TransferCheck);
        assertEq(nft.transferCheck(), address(0));
        _mint(alice, 1);
        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);
        assertEq(diamond.checks(), 0, "no check once removed");
        // A renderer can never be zero.
        vm.prank(timelock);
        vm.expectRevert(PositionNFT.ZeroAddress.selector);
        nft.proposeComponent(PositionNFT.Component.Renderer, address(0));
    }

    function test_renounceReverts() public {
        vm.prank(timelock);
        vm.expectRevert(PositionNFT.RenounceDisabled.selector);
        nft.renounceOwnership();
        assertEq(nft.owner(), timelock);
    }
}
