// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ERC4907Mock} from "./mocks/ERC4907Mock.sol";

/// @notice #2359 — the faucet NFT mock (deployed as vRENT / vART on testnets)
///         lets only a token's owner or an approved operator burn it.
contract ERC4907MockBurnTest is Test {
    ERC4907Mock internal nft;
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal operator = makeAddr("operator");

    function setUp() public {
        nft = new ERC4907Mock("Vaipakam Test Rental NFT", "vRENT");
        nft.mint(owner, 1);
        nft.mint(owner, 2);
        nft.mint(owner, 3);
    }

    function test_StrangerCannotBurn() public {
        vm.prank(stranger);
        vm.expectRevert(bytes("ERC4907Mock: burn caller is not owner nor approved"));
        nft.burn(1);
        assertEq(nft.ownerOf(1), owner);
    }

    function test_OwnerBurns() public {
        vm.prank(owner);
        nft.burn(1);
        assertEq(nft.balanceOf(owner), 2);
    }

    function test_ApprovedAndOperatorBurn() public {
        vm.startPrank(owner);
        nft.approve(stranger, 2);
        nft.setApprovalForAll(operator, true);
        vm.stopPrank();

        vm.prank(stranger);
        nft.burn(2);
        vm.prank(operator);
        nft.burn(3);
        assertEq(nft.balanceOf(owner), 1);
    }
}
