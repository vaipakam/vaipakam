// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";
import {MerkleFixture} from "./mocks/MerkleFixture.sol";

/// @title RemitWireTest — #1566 transport epochs 3d-1: the d6 wire's codec and
///        commitment rules, and the one d5 encoder the send and its quote share.
contract RemitWireTest is Test {
    function _days(uint256 n) internal pure returns (uint256[] memory d) {
        d = new uint256[](n);
        for (uint256 i; i < n; ++i) d[i] = 100 + i;
    }

    function test_D5_TheOneEncoder_IsTheWireShape() public pure {
        uint256[] memory days_ = _days(3);
        bytes memory viaLib = RemitWire.encodeD5(days_, 7e18, 42, address(0xD1A), 2e18);
        bytes memory byHand = abi.encode(RemitWire.REMIT_WIRE_TAG_D5, days_, uint256(7e18), uint256(42), address(0xD1A), uint256(2e18));
        assertEq(keccak256(viaLib), keccak256(byHand), "the shared encoder emits the d5 bytes the receiver decodes");
    }

    function test_D6_RoundTrip_CarriesRootExtentSplitAndEra() public pure {
        bytes memory p = RemitWire.encodeD6(bytes32(uint256(0xABC)), 33, 3, 9e18, 77, address(0xD1A), 4e18, 5);
        (uint256 tag, bytes32 root, uint256 e, uint256 c, uint256 total, uint256 remitId, address remitter, uint256 rec, uint256 era) =
            abi.decode(p, (uint256, bytes32, uint256, uint256, uint256, uint256, address, uint256, uint256));
        assertEq(tag, RemitWire.REMIT_WIRE_TAG_D6, "leads with the d6 tag");
        assertEq(root, bytes32(uint256(0xABC)));
        assertEq(e, 33);
        assertEq(c, 3);
        assertEq(total, 9e18);
        assertEq(remitId, 77);
        assertEq(remitter, address(0xD1A));
        assertEq(rec, 4e18);
        assertEq(era, 5, "the era rides as a full word");
        assertTrue(RemitWire.REMIT_WIRE_TAG_D6 != RemitWire.REMIT_WIRE_TAG_D5 && RemitWire.REMIT_WIRE_TAG_D6 != RemitWire.REMIT_WIRE_TAG_P2, "a new tag per shape");
    }

    function test_D6_Chunking_IsFixedSize_LastChunkShort() public pure {
        uint256 s = RemitWire.D6_CHUNK_DAYS;
        assertEq(RemitWire.d6ChunkCount(1), 1);
        assertEq(RemitWire.d6ChunkCount(s), 1);
        assertEq(RemitWire.d6ChunkCount(s + 1), 2);
        assertEq(RemitWire.d6ChunkCount(2 * s + 1), 3);
        assertEq(RemitWire.d6ChunkLength(2 * s + 1, 0), s, "a full chunk");
        assertEq(RemitWire.d6ChunkLength(2 * s + 1, 1), s);
        assertEq(RemitWire.d6ChunkLength(2 * s + 1, 2), 1, "the last chunk holds the rest");
        bytes32[] memory leaves = RemitWire.d6Chunks(_days(2 * s + 1));
        assertEq(leaves.length, 3, "one leaf per chunk");
        assertEq(leaves[2], RemitWire.d6Leaf(2, MerkleFixture.chunk(_days(2 * s + 1), 2, s)), "the leaf is the indexed chunk");
    }

    function test_D6_Leaf_IsBoundToItsIndex() public pure {
        uint256[] memory c = _days(4);
        assertTrue(RemitWire.d6Leaf(0, c) != RemitWire.d6Leaf(1, c), "the same days at another position are another leaf");
    }

    /// @dev Every leaf of every small tree verifies under OpenZeppelin's rule
    ///      against the library's root with the fixture's proof — the fact the
    ///      Diamond suites rely on when they prove chunks.
    function test_D6_Root_VerifiesEveryLeaf_ForEveryTreeSize() public pure {
        for (uint256 n = 1; n <= 9; ++n) {
            bytes32[] memory leaves = new bytes32[](n);
            for (uint256 i; i < n; ++i) leaves[i] = keccak256(abi.encode("leaf", n, i));
            bytes32 root = RemitWire.d6Root(leaves);
            for (uint256 i; i < n; ++i) {
                assertTrue(MerkleProof.verify(MerkleFixture.proof(leaves, i), root, leaves[i]), "verifies");
                bytes32 other = keccak256(abi.encode("not a leaf", n, i));
                assertFalse(MerkleProof.verify(MerkleFixture.proof(leaves, i), root, other), "a foreign leaf does not");
            }
            assertEq(leaves[0], keccak256(abi.encode("leaf", n, uint256(0))), "the root builder does not mutate its input");
        }
    }

    function test_D6_Root_RefusesNoLeaves() public {
        bytes32[] memory none;
        vm.expectRevert(RemitWire.D6EmptyLeaves.selector);
        this.rootOf(none);
    }

    function rootOf(bytes32[] memory leaves) external pure returns (bytes32) {
        return RemitWire.d6Root(leaves);
    }
}
