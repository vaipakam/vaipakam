// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  RemitWire — reward-budget remittance payload versioning
 * @author Vaipakam Developer Team
 * @notice The single shared constant that binds the remit SENDER
 *         (`RewardRemittanceFacet` on the canonical chain) to the remit
 *         DECODER (`RewardRemittanceReceiver` on each mirror). Both import it
 *         so the tag can never drift between the two sides.
 *
 * @dev    Every remit payload LEADS WITH A TAG naming its shape, and the
 *         receiver accepts exactly two: {REMIT_WIRE_TAG_D8} for a budget
 *         remittance and {REMIT_WIRE_TAG_P2} for a manual compensation. Any
 *         other leading word is refused by name
 *         (`RewardRemittanceReceiver.UnknownRemitWireShape`).
 *
 *         The earlier shapes are RETIRED, not merely superseded, and the
 *         receiver refuses them: the two untagged payloads discriminated by
 *         their ABI head word (`abi.encode(uint256[] dayIds, uint256 total)`,
 *         and the d2 shape that added `remitId` and `remitter`), the tagged d5
 *         payload that added `recycledShare`, the tagged d6 payload
 *         (`keccak256("vaipakam.remit.wire.d6")`) that replaced the flat list
 *         with a rooted commitment to it, and the tagged d7 payload
 *         (`keccak256("vaipakam.remit.wire.d7")`, #918) that d6 grew the
 *         funded day's whole slice in. The flat-list shapes carried their day
 *         list flat, so each needed its own index, proof and admission route
 *         on the mirror, and the untagged two carried no split at all; d6
 *         carried no whole, so a mirror could not tell one part of a day from
 *         all of it; and d6 and d7 carried a chunked, rooted list sized for
 *         many days per send, which the mirror had to index chunk by chunk
 *         after arrival, although since #2821 every send funds one day. The
 *         platform is pre-live and every chain running d8 is a fresh deploy
 *         (decision O1 = A), so no such payload is in flight to any of them.
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

    /// @notice Leading word of the #2828 d8 remit payload — a NEW tag per the
    ///         standing rule.
    /// @dev    Shape:
    ///
    ///           d8 : `abi.encode(REMIT_WIRE_TAG_D8, uint256 dayId,
    ///                            uint256 total, uint256 remitId,
    ///                            address remitter, uint256 recycledShare,
    ///                            uint256 intendedEra,
    ///                            uint256 dayWholeFresh,
    ///                            uint256 dayWholeRecycled)`
    ///
    ///         A budget remittance funds exactly ONE day (#2821,
    ///         `LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP`), so the day travels
    ///         INLINE: the shape names one day and has no way to name two. d7
    ///         carried a Merkle root over 16-day chunks of the day list and the
    ///         list's extent, sized for many days per send; with one funded day
    ///         that commitment always held one day in one chunk, and the mirror
    ///         still had to index it afterwards, chunk by chunk, before the
    ///         epoch could be drawn. Carrying the day itself lets the mirror
    ///         index it at arrival (#2828).
    ///
    ///         `total` and `recycledShare` are THIS part of the day's slice
    ///         (#918: a day whose slice exceeds the lane's bucket is sent in
    ///         several parts, each its own packet), and the two whole words are
    ///         the day's slice in all, locked on Base at the day's first part
    ///         and identical on every part. The mirror sums the parts it has
    ///         landed per component against that whole and opens the day only
    ///         once both sums reach it, so it never needs to know how many
    ///         parts there are, and the parts may land in any order.
    ///
    ///         `intendedEra` is the era the packet was dispatched in, stored by
    ///         the receive side and validated by the era registry's receive
    ///         rules (PR C).
    uint256 internal constant REMIT_WIRE_TAG_D8 =
        uint256(keccak256("vaipakam.remit.wire.d8"));

    /// @notice The d8 fields, in wire order after the tag.
    /// @dev    A memory struct so the one encoder takes one argument: an
    ///         internal library call, never an ABI boundary.
    struct D8 {
        uint256 dayId;
        uint256 total;
        uint256 remitId;
        address remitter;
        uint256 recycledShare;
        uint64 intendedEra;
        uint256 dayWholeFresh;
        uint256 dayWholeRecycled;
    }

    /// @notice The ONE d8 encoder; see {REMIT_WIRE_TAG_D8} for the shape.
    function encodeD8(D8 memory w) internal pure returns (bytes memory) {
        return abi.encode(
            REMIT_WIRE_TAG_D8,
            w.dayId,
            w.total,
            w.remitId,
            w.remitter,
            w.recycledShare,
            uint256(w.intendedEra),
            w.dayWholeFresh,
            w.dayWholeRecycled
        );
    }
}
