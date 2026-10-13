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
 * @dev    #1222 M3 B2-d5 (Codex #1432 r2). Before d5 the payload shapes were
 *         discriminated by the leading ABI head word — the `dayIds` array
 *         offset, which equals `32 × head-slots`:
 *
 *           legacy : `abi.encode(uint256[] dayIds, uint256 total)`      → 0x40
 *           d2 r4  : `... + (uint256 remitId, address remitter)`        → 0x80
 *
 *         Extending that ladder to `0xA0` for d5's added `recycledShare`
 *         would have been silently unsafe across the cross-chain ROLLOUT
 *         window. The canonical chain is refreshed before the mirrors, so
 *         between those two steps a not-yet-upgraded receiver would read
 *         `0xA0`, fail its `== 0x80` test, fall into the legacy branch — and
 *         because `0xA0` is a perfectly valid in-bounds array offset, the
 *         decode SUCCEEDS. It would drop `remitId` / `remitter` /
 *         `recycledShare`, forward through the retired ingress selector,
 *         strand the canonical reservation Pending, and apply no custody
 *         credit: precisely the accounting hole d5 exists to close, reopened
 *         silently and only during rollout.
 *
 *         So the d5 shape LEADS with this tag instead:
 *
 *           d5 : `abi.encode(REMIT_WIRE_TAG_D5, uint256[] dayIds,
 *                            uint256 total, uint256 remitId,
 *                            address remitter, uint256 recycledShare)`
 *
 *         Being keccak-derived, the tag is astronomically larger than any
 *         real payload length. An old receiver reads it as the array offset,
 *         the ABI decoder's bounds check fails, and the delivery REVERTS —
 *         deterministically, not probabilistically (a small sentinel could
 *         land on a valid offset; this cannot). CCIP records a failed
 *         message, re-executable once that mirror is upgraded, so nothing is
 *         lost.
 *
 *         The wire is therefore version-gated BY CONSTRUCTION: there is no
 *         operator flag to set, no "refresh mirrors first" rule to remember,
 *         and no way for a partial rollout to under-credit silently. That is
 *         the same fail-closed posture the cross-chain pause lever relies on.
 *
 *         Future evolutions should follow this pattern — a NEW tag per shape,
 *         never another rung on the offset ladder.
 */
library RemitWire {
    /// @notice Leading word of the B2-d5 remit payload.
    /// @dev Value is `uint256(keccak256("vaipakam.remit.wire.d5"))`, fixed
    ///      here as a literal so it is a compile-time constant on both sides
    ///      (and so a reader can diff it against the preimage).
    uint256 internal constant REMIT_WIRE_TAG_D5 =
        uint256(keccak256("vaipakam.remit.wire.d5"));

    /// @notice Leading word of the #1434 P2 MANUAL-COMPENSATION remit
    ///         payload (design §1.3) — a NEW tag per the standing d5 rule,
    ///         never another rung on the offset ladder.
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
    ///         ingress-time expiry evaluation. A clockless day never
    ///         dispatches at all (#1634 r2 — `CompensationDayHasNoClock`). Fresh-only by construction: the manual-compensation
    ///         path relocates no recycled custody, so the payload carries no
    ///         `recycledShare` field at all.
    uint256 internal constant REMIT_WIRE_TAG_P2 =
        uint256(keccak256("vaipakam.remit.wire.p2"));

    /// @notice Leading word of the #1566 transport-epochs d6 remit payload — a
    ///         NEW tag per the standing rule, never another rung on the ladder.
    /// @dev    Shape:
    ///
    ///           d6 : `abi.encode(REMIT_WIRE_TAG_D6, bytes32 dayListRoot,
    ///                            uint256 elementCount, uint256 chunkCount,
    ///                            uint256 total, uint256 remitId,
    ///                            address remitter, uint256 recycledShare,
    ///                            uint256 intendedEra)`
    ///
    ///         In place of the day list itself the wire carries an
    ///         AUTHENTICATED COMMITMENT to it: a Merkle root over fixed-size
    ///         INDEXED chunks of the list ({d6Leaf}: chunk index + the chunk's
    ///         days, so a chunk proves its place and not only its membership)
    ///         together with the list's EXTENT — how many days, in how many
    ///         chunks. A root alone would prove a submitted chunk belongs to
    ///         SOME tree, never that every member day has been seen; the
    ///         extent is what lets the receiver know when the membership is
    ///         whole, which is what gates the delivery's spendability. The
    ///         chunks are the unit of destination-side verification and
    ///         writing: one bounded chunk plus its proof per call, O(page)
    ///         rather than a re-hash of the whole list, which is what lets the
    ///         per-remittance day cap move once every lane speaks d6.
    ///
    ///         `intendedEra` is the era the packet was dispatched in. It is
    ///         CARRIED and stored by the receive side from this wire on and
    ///         validated by the era registry's receive rules (PR C); no wire
    ///         before d6 carries one, which is why d6 precedes that PR.
    ///
    ///         The chunk SIZE is fixed by this shape ({D6_CHUNK_DAYS}), not
    ///         carried: both sides derive every chunk's bounds from the
    ///         element count alone, so there is no per-packet degree of
    ///         freedom to validate and the leaf encoding is one rule. Changing
    ///         the size is a new shape — a new tag.
    uint256 internal constant REMIT_WIRE_TAG_D6 =
        uint256(keccak256("vaipakam.remit.wire.d6"));

    /// @notice Days per d6 leaf-chunk. Half the destination's index page so an
    ///         ordinary within-cap remittance already exercises the multi-chunk
    ///         path, and each chunk's writes stay well inside one call.
    uint256 internal constant D6_CHUNK_DAYS = 16;

    /// @notice The most chunks a d6 packet may declare: the receive side marks
    ///         landed chunks in one 256-bit word.
    uint256 internal constant D6_MAX_CHUNKS = 256;

    /// @notice A d6 root over no leaves is not a commitment.
    error D6EmptyLeaves();

    /// @notice The ONE d5 encoder — the send and its fee quote both build the
    ///         payload here, so the quote prices exactly the bytes the send
    ///         emits and the two can never drift (one walk for a send and all
    ///         its quotes).
    function encodeD5(
        uint256[] memory dayIds,
        uint256 total,
        uint256 remitId,
        address remitter,
        uint256 recycledShare
    ) internal pure returns (bytes memory) {
        return abi.encode(REMIT_WIRE_TAG_D5, dayIds, total, remitId, remitter, recycledShare);
    }

    /// @notice The ONE d6 encoder; see {REMIT_WIRE_TAG_D6} for the shape.
    function encodeD6(
        bytes32 dayListRoot,
        uint256 elementCount,
        uint256 chunkCount,
        uint256 total,
        uint256 remitId,
        address remitter,
        uint256 recycledShare,
        uint64 intendedEra
    ) internal pure returns (bytes memory) {
        return abi.encode(
            REMIT_WIRE_TAG_D6,
            dayListRoot,
            elementCount,
            chunkCount,
            total,
            remitId,
            remitter,
            recycledShare,
            uint256(intendedEra)
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
