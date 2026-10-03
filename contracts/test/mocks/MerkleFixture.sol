// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/// @title  MerkleFixture — test-side proof builder for the d6 day-list root.
/// @notice Mirrors {RemitWire.d6Root}'s reduction (commutative pair hashing,
///         an unpaired node promoted unhashed, so a promoted node contributes
///         no sibling). A proof it builds must verify under OpenZeppelin's
///         {MerkleProof} against the root the library computes — the codec
///         suite asserts exactly that for every leaf of several tree sizes,
///         which is what makes the other suites' proofs trustworthy.
library MerkleFixture {
    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory out) {
        uint256 n = leaves.length;
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) level[i] = leaves[i];
        bytes32[] memory buf = new bytes32[](64);
        uint256 k;
        uint256 pos = index;
        while (n > 1) {
            uint256 sib = pos ^ 1;
            if (sib < n) buf[k++] = level[sib];
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; ++i) {
                uint256 a = 2 * i;
                uint256 b = a + 1;
                level[i] = b < n ? Hashes.commutativeKeccak256(level[a], level[b]) : level[a];
            }
            n = m;
            pos /= 2;
        }
        out = new bytes32[](k);
        for (uint256 i; i < k; ++i) out[i] = buf[i];
    }

    /// @dev Chunk `c` of `dayIds` at the wire's fixed chunk size.
    function chunk(uint256[] memory dayIds, uint256 c, uint256 size) internal pure returns (uint256[] memory out) {
        uint256 base = c * size;
        uint256 rest = dayIds.length - base;
        uint256 len = rest < size ? rest : size;
        out = new uint256[](len);
        for (uint256 i; i < len; ++i) out[i] = dayIds[base + i];
    }
}
