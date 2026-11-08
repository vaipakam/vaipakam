// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactDeploy} from "../../script/lib/ArtifactDeploy.sol";
import {PositionNFT} from "../../src/PositionNFT.sol";
import {VaipakamNFTFacet} from "../../src/facets/VaipakamNFTFacet.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title  LibTestPositionNFT
/// @notice #3205 — the test-side counterpart of `DeployDiamond` step 5d:
///         deploys the PositionNFT core for `diamond` (the Diamond as its
///         minter, renderer and transfer check) and records it on the
///         Diamond. Replaces the retired `initializeNFT()` in every suite that
///         builds its own Diamond. `owner` (the core's owner and guardian) is
///         usually the test contract itself, which must hold ADMIN_ROLE.
library LibTestPositionNFT {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// @dev `LibPositionNFT`'s namespace and the slot of its `core` field
    ///      (`storage-layout/layout.golden.json`: `L|erc721|25|0|address|core`).
    bytes32 private constant ERC721_STORAGE_POSITION =
        0xffc14e8dfa13b7ea215d815404bdf757f7212df791bac9ce070c8e8dcd574f00;
    uint256 private constant CORE_SLOT_OFFSET = 25;

    function install(address diamond, address owner) internal returns (PositionNFT nft) {
        nft = PositionNFT(
            ArtifactDeploy.deploy(type(PositionNFT).name, abi.encode(owner, diamond, owner, diamond, diamond))
        );
        VaipakamNFTFacet(diamond).initializeNFT(address(nft));
    }

    /// @notice The PositionNFT core `diamond` records: where every position's
    ///         owner, approvals and transfers live.
    /// @notice Hand position `tokenId` to `to` the way a holder does: a
    ///         transfer at the core, from its current holder. Replaces the
    ///         pre-#3205 raw burn-then-mint (the core never burns, so a re-mint
    ///         of a live id fails). The transfer runs the Diamond's transfer
    ///         check and counts, as any holder's transfer does.
    function move(address diamond, uint256 tokenId, address to) internal {
        PositionNFT nft = core(diamond);
        address holder = nft.ownerOf(tokenId);
        VM.prank(holder);
        nft.transferFrom(holder, to, tokenId);
    }

    /// @notice Make the core report `holder` for `tokenId` (a `vm.mockCall` on
    ///         `holderOf`, which every Diamond-side holder read goes through).
    ///         Replaces the pre-#3205 mock of the Diamond's own `ownerOf`,
    ///         which the Diamond no longer serves or reads. A retired token
    ///         still reads as gone, as in production.
    function mockHolder(address diamond, uint256 tokenId, address holder) internal {
        VM.mockCall(
            address(core(diamond)), abi.encodeWithSelector(PositionNFT.holderOf.selector, tokenId), abi.encode(holder)
        );
    }

    /// @dev Read from the Diamond's storage with `vm.load`, never with a call:
    ///      a test writes `vm.prank(x); LibTestPositionNFT.core(d).approve(...)`
    ///      and `vm.expectRevert(); LibTestPositionNFT.core(d).ownerOf(...)`,
    ///      and a call here (`positionNFT()`) would be the "next call" that
    ///      consumes the prank or the expected revert, leaving the real call
    ///      unpranked or unchecked.
    function core(address diamond) internal view returns (PositionNFT nft) {
        nft = PositionNFT(
            address(uint160(uint256(VM.load(diamond, bytes32(uint256(ERC721_STORAGE_POSITION) + CORE_SLOT_OFFSET)))))
        );
        require(address(nft) != address(0), "LibTestPositionNFT: core not installed");
    }
}
