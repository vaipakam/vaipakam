// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/**
 * @title  RemitWire — reward-budget remittance payload versioning
 * @author Vaipakam Developer Team
 * @notice The single shared constant that binds the remit SENDER
 *         (`RewardRemittanceFacet` on the canonical chain) to the remit
 *         DECODER (`RewardRemittanceReceiver` on each mirror). Both import it
 *         so the tag can never drift between the two sides.
 *
 * @dev    Every remit payload LEADS WITH A TAG naming its shape, and the
 *         receiver accepts exactly two: {REMIT_WIRE_TAG_D7} for a budget
 *         remittance and {REMIT_WIRE_TAG_P2} for a manual compensation. Any
 *         other leading word is refused by name
 *         (`RewardRemittanceReceiver.UnknownRemitWireShape`).
 *
 *         The earlier shapes are RETIRED, not merely superseded, and the
 *         receiver refuses them: the two untagged payloads discriminated by
 *         their ABI head word (`abi.encode(uint256[] dayIds, uint256 total)`,
 *         and the d2 shape that added `remitId` and `remitter`), the tagged d5
 *         payload that added `recycledShare`, and the tagged d6 payload
 *         (`keccak256("vaipakam.remit.wire.d6")`, #918) that d7 extends with
 *         the funded day's whole slice. The flat-list shapes carried their day
 *         list flat, so each needed its own index, proof and admission route
 *         on the mirror, and the untagged two carried no split at all; d6
 *         carried no whole, so a mirror could not tell one part of a day from
 *         all of it. The platform is pre-live and every chain running d7 is a
 *         fresh deploy (decision O1 = A), so no such payload is in flight to
 *         any of them.
 *
 *         WHY A TAG and not a head-word ladder (#1222 M3 B2-d5, Codex #1432
 *         r2). The tag is keccak-derived, so it is astronomically larger than
 *         any real payload length. A receiver that does not know a shape
 *         reads its tag as an array offset, the ABI decoder's bounds check
 *         fails, and the delivery REVERTS — deterministically. CCIP records a
 *         failed message, re-executable once that mirror is upgraded, so
 *         nothing is lost. An offset ladder had no such property: a new rung
 *         is a valid in-bounds offset to an old decoder, which would decode
 *         it as the wrong shape and under-credit silently. The wire is
 *         therefore version-gated BY CONSTRUCTION, with no operator flag and
 *         no refresh-order rule.
 *
 *         Future evolutions follow this pattern — a NEW tag per shape.
 */
library RemitWire {
    /// @notice Leading word of the #1434 P2 MANUAL-COMPENSATION remit
    ///         payload (design §1.3) — a NEW tag per the standing rule.
    /// @dev    Shape:
    ///
    ///           p2 : `abi.encode(REMIT_WIRE_TAG_P2, uint256 dayId,
    ///                            uint256 total, uint256 remitId,
    ///                            address remitter,
    ///                            uint256 lenderShare18,
    ///                            uint256 borrowerShare18,
    ///                            uint256 finalizedAt,
    ///                            uint256 lapseScheduleVersion,
    ///                            uint256 lapseWindowSeconds,
    ///                            uint256 dispatchCutoffGap)`
    ///
    ///         The tag + the SINGLE-DAY shape ARE the compensation marker
    ///         (§2.2): a P2 payload always funds exactly one zeroed day
    ///         (constraint 15 binds a compensation to one day), carries the
    ///         authenticated PER-SIDE amounts (R1/R1b — the mirror can never
    ///         be left to solve for a side), and duplicates the day's FROZEN
    ///         expiry inputs (R4b: `finalizedAt` + the schedule version,
    ///         both read from Base's finalization-time freeze) so the mirror
    ///         can classify the arrival even before its V3 broadcast lands
    ///         (§2.2's unstamped case). ALL FOUR frozen clock words ride
    ///         (#1634 r1): w1 chose inline schedule parameters over a
    ///         mirror-side version table, so the version number alone is
    ///         underivable there and the window itself must travel for the
    ///         ingress-time expiry evaluation. Base dispatches only a
    ///         finalized day, and finalization freezes the clock, so the
    ///         words are always present. Fresh-only by construction: the
    ///         manual-compensation path relocates no recycled custody, so
    ///         the payload carries no `recycledShare` field at all.
    uint256 internal constant REMIT_WIRE_TAG_P2 =
        uint256(keccak256("vaipakam.remit.wire.p2"));

    /// @notice Leading word of the #918 d7 remit payload — a NEW tag per the
    ///         standing rule.
    /// @dev    Shape:
    ///
    ///           d7 : `abi.encode(REMIT_WIRE_TAG_D7, bytes32 dayListRoot,
    ///                            uint256 elementCount, uint256 chunkCount,
    ///                            uint256 total, uint256 remitId,
    ///                            address remitter, uint256 recycledShare,
    ///                            uint256 intendedEra,
    ///                            uint256 dayWholeFresh,
    ///                            uint256 dayWholeRecycled)`
    ///
    ///         The d6 shape (#1566 transport epochs 3d-1) with the funded
    ///         day's WHOLE slice appended, per component. Since #918 a day's
    ///         slice may be sent in several parts, each its own packet: `total`
    ///         and `recycledShare` are THIS part, and the two whole words are
    ///         the day's slice in all, locked on Base at the day's first part
    ///         and identical on every part. The mirror sums the parts it has
    ///         landed per component against that whole and opens the day only
    ///         once both sums reach it, so it never needs to know how many
    ///         parts there are, and the parts may land in any order.
    ///
    ///         In place of the day list itself the wire carries an
    ///         AUTHENTICATED COMMITMENT to it: a Merkle root over fixed-size
    ///         INDEXED chunks of the list ({d6Leaf}: chunk index + the chunk's
    ///         days, so a chunk proves its place and not only its membership)
    ///         together with the list's EXTENT — how many days, in how many
    ///         chunks. A root alone would prove a submitted chunk belongs to
    ///         SOME tree, never that every member day has been seen; the extent
    ///         is what lets the receiver know when the membership is whole. The
    ///         chunk and leaf rules are d6's, unchanged (hence the `d6` names
    ///         below): only the header grew. The chunk SIZE is fixed by the
    ///         shape ({D6_CHUNK_DAYS}), not carried, so both sides derive every
    ///         chunk's bounds from the element count alone; changing it is a
    ///         new shape — a new tag.
    ///
    ///         `intendedEra` is the era the packet was dispatched in, stored by
    ///         the receive side and validated by the era registry's receive
    ///         rules (PR C).
    uint256 internal constant REMIT_WIRE_TAG_D7 =
        uint256(keccak256("vaipakam.remit.wire.d7"));

    /// @notice The d7 header fields, in wire order after the tag.
    /// @dev    A memory struct so the one encoder takes one argument: an
    ///         internal library call, never an ABI boundary.
    struct D7 {
        bytes32 dayListRoot;
        uint256 elementCount;
        uint256 chunkCount;
        uint256 total;
        uint256 remitId;
        address remitter;
        uint256 recycledShare;
        uint64 intendedEra;
        uint256 dayWholeFresh;
        uint256 dayWholeRecycled;
    }

    /// @notice Days per d6 (and d7) leaf-chunk. Half the destination's index page so an
    ///         ordinary within-cap remittance already exercises the multi-chunk
    ///         path, and each chunk's writes stay well inside one call.
    uint256 internal constant D6_CHUNK_DAYS = 16;

    /// @notice The most chunks a d6 packet may declare: the receive side marks
    ///         landed chunks in one 256-bit word.
    uint256 internal constant D6_MAX_CHUNKS = 256;

    /// @notice A d6 root over no leaves is not a commitment.
    error D6EmptyLeaves();

    /// @notice The ONE d7 encoder; see {REMIT_WIRE_TAG_D7} for the shape.
    function encodeD7(D7 memory w) internal pure returns (bytes memory) {
        return abi.encode(
            REMIT_WIRE_TAG_D7,
            w.dayListRoot,
            w.elementCount,
            w.chunkCount,
            w.total,
            w.remitId,
            w.remitter,
            w.recycledShare,
            uint256(w.intendedEra),
            w.dayWholeFresh,
            w.dayWholeRecycled
        );
    }

    /// @notice How many chunks a list of `elementCount` days takes.
    function d6ChunkCount(uint256 elementCount) internal pure returns (uint256) {
        return (elementCount + D6_CHUNK_DAYS - 1) / D6_CHUNK_DAYS;
    }

    /// @notice The committed length of chunk `chunkIndex` of a list of
    ///         `elementCount` days: every chunk is full but the last.
    /// @dev    Callers hold `chunkIndex < d6ChunkCount(elementCount)`, so the
    ///         subtraction cannot underflow.
    function d6ChunkLength(uint256 elementCount, uint256 chunkIndex) internal pure returns (uint256) {
        uint256 rest = elementCount - chunkIndex * D6_CHUNK_DAYS;
        return rest < D6_CHUNK_DAYS ? rest : D6_CHUNK_DAYS;
    }

    /// @notice The leaf for chunk `chunkIndex` holding `dayIds` — the INDEXED
    ///         leaf encoding the wire commits to.
    /// @dev    Double-hashed, the OpenZeppelin convention: a leaf preimage is
    ///         then never a 64-byte word pair, so no internal node can be
    ///         passed off as a leaf. The index is in the preimage so the same
    ///         days cannot be proven at another position.
    function d6Leaf(uint256 chunkIndex, uint256[] memory dayIds) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(chunkIndex, dayIds))));
    }

    /// @notice Split a day list into its d6 leaves, in chunk order.
    function d6Chunks(uint256[] memory dayIds) internal pure returns (bytes32[] memory leaves) {
        uint256 count = d6ChunkCount(dayIds.length);
        leaves = new bytes32[](count);
        for (uint256 c; c < count; ++c) {
            uint256 len = d6ChunkLength(dayIds.length, c);
            uint256[] memory chunk = new uint256[](len);
            uint256 base = c * D6_CHUNK_DAYS;
            for (uint256 i; i < len; ++i) chunk[i] = dayIds[base + i];
            leaves[c] = d6Leaf(c, chunk);
        }
    }

    /// @notice The root over `leaves`, as {MerkleProof.verify} expects it:
    ///         commutative pair hashing, an unpaired node promoted unhashed.
    /// @dev    Does not mutate `leaves`. The promotion rule is what a proof
    ///         builder must mirror: a promoted node contributes no sibling.
    function d6Root(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) revert D6EmptyLeaves();
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i; i < n; ++i) level[i] = leaves[i];
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i; i < m; ++i) {
                uint256 a = 2 * i;
                uint256 b = a + 1;
                level[i] = b < n ? Hashes.commutativeKeccak256(level[a], level[b]) : level[a];
            }
            n = m;
        }
        return level[0];
    }
}
