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
}
