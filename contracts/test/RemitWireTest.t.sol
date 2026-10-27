// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {RemitWire} from "../src/crosschain/RemitWire.sol";
import {MerkleFixture} from "./mocks/MerkleFixture.sol";

/// @title RemitWireTest — #1566 transport epochs 3d-1 / #918: the d7 wire's codec and
///        commitment rules.
contract RemitWireTest is Test {
    function _days(uint256 n) internal pure returns (uint256[] memory d) {
        d = new uint256[](n);
        for (uint256 i; i < n; ++i) d[i] = 100 + i;
    }

    function test_D7_RoundTrip_CarriesRootExtentSplitEraAndTheDaysWhole() public pure {
        bytes memory p = RemitWire.encodeD7(
            RemitWire.D7({
                dayListRoot: bytes32(uint256(0xABC)),
                elementCount: 33,
                chunkCount: 3,
                total: 9e18,
                remitId: 77,
                remitter: address(0xD1A),
                recycledShare: 4e18,
                intendedEra: 5,
                dayWholeFresh: 11e18,
                dayWholeRecycled: 6e18
            })
        );
        assertEq(p.length, 11 * 32, "eleven static words");
        (uint256 tag, RemitWire.D7 memory w) = abi.decode(p, (uint256, RemitWire.D7));
        assertEq(tag, RemitWire.REMIT_WIRE_TAG_D7, "leads with the d7 tag");
        assertEq(w.dayListRoot, bytes32(uint256(0xABC)));
        assertEq(w.elementCount, 33);
        assertEq(w.chunkCount, 3);
        assertEq(w.total, 9e18);
        assertEq(w.remitId, 77);
        assertEq(w.remitter, address(0xD1A));
        assertEq(w.recycledShare, 4e18);
        assertEq(w.intendedEra, 5);
        assertEq(w.dayWholeFresh, 11e18, "#918: the day's whole rides per component");
        assertEq(w.dayWholeRecycled, 6e18);
        // The era rides as a full word, at the same place d6 put it.
        (, , , , , , , , uint256 era) =
            abi.decode(p, (uint256, bytes32, uint256, uint256, uint256, uint256, address, uint256, uint256));
        assertEq(era, 5, "the era rides as a full word");
        assertTrue(RemitWire.REMIT_WIRE_TAG_D7 != RemitWire.REMIT_WIRE_TAG_P2, "a tag per shape");
        assertTrue(
            RemitWire.REMIT_WIRE_TAG_D7 != uint256(keccak256("vaipakam.remit.wire.d6")), "d7 is not the retired d6 tag"
        );
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
