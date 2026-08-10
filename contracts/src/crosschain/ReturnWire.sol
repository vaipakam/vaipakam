// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  ReturnWire — mirror→Base VPFI return-channel payload kinds
 * @author Vaipakam Developer Team
 * @notice The shared constants that bind the return-channel SENDER
 *         (`VpfiReturnSender` on each mirror) to its DECODER
 *         (`VpfiReturnReceiver` on the canonical chain). Both import this
 *         library so a kind can never drift between the two sides.
 *
 * @dev    #1568 C2 — the mirror→Base return CHANNEL is cut ONCE and shared
 *         (owner ratification 2026-08-07, recorded in
 *         `VpfiCrossChainRecyclingDesign.md` §3.6a): Mode A's planned-surplus
 *         repatriation rides it now, and Mode B's stranded-fresh recovery
 *         (#1434 R4) will ride the same channel later. What is NOT shared is
 *         the wire protocol: each mode is its own payload kind with its own
 *         decoder branch, Base-side Diamond ingress and rollout ladder,
 *         versioned independently — never a mode field inside one shared
 *         schema, which would give two protocols with different
 *         authenticated identities a single decoder and a single rollout
 *         ladder (§2h constraint 12a's failure shape).
 *
 *         Every kind is a keccak-derived leading tag, following the
 *         `RemitWire` d5 pattern for the same load-bearing reason: a
 *         receiver that predates a kind reads the tag where a decode offset
 *         or small discriminator could sit, the ABI decoder's bounds check
 *         fails (the tag is astronomically larger than any real payload
 *         length), and the delivery REVERTS deterministically. CCIP records
 *         a failed, re-executable message, so a partial rollout can never
 *         mis-book a return silently — the wire is version-gated by
 *         construction. Future kinds (Mode B's included) MUST follow the
 *         same shape: a NEW tag per protocol, never a variant field inside
 *         an existing one.
 */
library ReturnWire {
    /// @notice Leading word of a Mode-A repatriation RETURN payload:
    ///         `abi.encode(RETURN_WIRE_TAG_REPAT_A1, address issuingBase,
    ///         uint256 authId, uint256 amount)`, carried with exactly one
    ///         `TokenAmount` (the mirror VPFI being repatriated).
    /// @dev Value is `uint256(keccak256("vaipakam.return.wire.repat.a1"))`.
    uint256 internal constant RETURN_WIRE_TAG_REPAT_A1 =
        uint256(keccak256("vaipakam.return.wire.repat.a1"));

    /// @notice Leading word of a Mode-A CANCELLATION-ACK payload:
    ///         `abi.encode(RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1,
    ///         address issuingBase, uint256 authId)`, data-only (zero
    ///         tokens) — the ACK is the authenticated evidence of a mirror
    ///         tombstone, not a value transfer.
    /// @dev Value is
    ///      `uint256(keccak256("vaipakam.return.wire.repat-cancel-ack.a1"))`.
    uint256 internal constant RETURN_WIRE_TAG_REPAT_CANCEL_ACK_A1 =
        uint256(keccak256("vaipakam.return.wire.repat-cancel-ack.a1"));

    /// @notice Leading word of a Mode-B STRANDED-RETURN payload (#1434 R4,
    ///         P2-w5): `abi.encode(RETURN_WIRE_TAG_STRANDED_B1,
    ///         address remitter, uint256 remitId, uint256 dayId,
    ///         uint256 amount, uint256 remainingAfter)`, carried with
    ///         exactly one `TokenAmount` (the quarantined mirror VPFI
    ///         coming home). `remitter` is the Base deployment that
    ///         dispatched the original compensation — the receipt identity
    ///         IS the era binding, checked Base-side. `remainingAfter` is
    ///         the mirror record's post-chunk remainder (#1660 r2 —
    ///         returns are CHUNKABLE against the destination lane ceiling;
    ///         zero marks the receipt's TERMINAL chunk, on which Base
    ///         terminalizes the residual entitlement as transport loss).
    /// @dev Value is `uint256(keccak256("vaipakam.return.wire.stranded.b1"))`.
    uint256 internal constant RETURN_WIRE_TAG_STRANDED_B1 =
        uint256(keccak256("vaipakam.return.wire.stranded.b1"));
}
