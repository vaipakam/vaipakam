// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IVpfiBuyCcipMessages — shared protocol constants for the
 *        CCIP fixed-rate VPFI buy flow (T-068 Phase 3)
 *
 * The CCIP successor to the LayerZero `IVPFIBuyMessages`. The buy flow is
 * two cross-chain legs over the {ICrossChainMessenger} seam, on one
 * channel ({VPFI_BUY_CHANNEL}) that pairs `VpfiBuyAdapter` (mirror chains)
 * with `VpfiBuyReceiver` (the canonical Base chain):
 *
 *  - **Leg 1 — BUY_REQUEST** (`VpfiBuyAdapter` → `VpfiBuyReceiver`,
 *    data-only). The buyer has locked `amountIn` on the source chain.
 *    Payload: `abi.encode(uint64 requestId, address buyer,
 *    uint256 amountIn, uint256 minVpfiOut)`.
 *
 *  - **Leg 2 — the response** (`VpfiBuyReceiver` → `VpfiBuyAdapter`).
 *    Exactly one of two shapes, told apart by whether the CCIP message
 *    carries tokens — no message-kind byte is needed:
 *      * **VPFI delivery** (success) — a CCIP programmable token transfer:
 *        `tokens = [{vpfiToken, vpfiOut}]`, payload
 *        `abi.encode(uint64 requestId)`. The VPFI lands on the adapter,
 *        which cross-checks `requestId` against its own `pendingBuys`
 *        before releasing it to the buyer (the design §5 two-step).
 *      * **BUY_FAILED** — data-only: `tokens = []`, payload
 *        `abi.encode(uint64 requestId, uint8 reason)`.
 *
 * `requestId` is minted by the adapter on `buy()`, echoed by the receiver
 * in both response shapes, and keys the adapter's pending-buy table for
 * the local cross-check, the refund, and replay protection.
 *
 * Abstract contract (not an interface) so it can hand named constants to
 * the two inheriting contracts; it has no deployable bytecode of its own.
 */
abstract contract IVpfiBuyCcipMessages {
    /// @notice The {ICrossChainMessenger} channel id the buy flow runs on.
    ///         Reference value — the live binding is a `CcipMessenger`
    ///         `registerChannel` / `setChannelPeer` config at deploy time;
    ///         this constant documents the canonical id and lets the
    ///         deploy script and tests pin it.
    bytes32 internal constant VPFI_BUY_CHANNEL =
        keccak256("vaipakam.ccip.channel.vpfi-buy");

    // ─── BUY_FAILED reason codes ────────────────────────────────────────────
    // Carried in the BUY_FAILED payload so the source-chain frontend can
    // show the buyer a useful error. Named constants (not an enum) so
    // off-chain consumers can pin a stable value.

    /// @notice Catch-all / undecodable Base-side revert.
    uint8 internal constant FAIL_REASON_UNKNOWN = 0;
    /// @notice Global or per-wallet VPFI cap would be exceeded.
    uint8 internal constant FAIL_REASON_CAP_EXCEEDED = 1;
    /// @notice The fixed buy rate is unset or buys are disabled.
    uint8 internal constant FAIL_REASON_RATE_UNSET_OR_DISABLED = 2;
    /// @notice The VPFI reserve backing fixed-rate buys is insufficient.
    uint8 internal constant FAIL_REASON_RESERVE_INSUFFICIENT = 3;
    /// @notice The buy amount is below the minimum.
    uint8 internal constant FAIL_REASON_AMOUNT_TOO_SMALL = 4;
    /// @notice `processBridgedBuy` reverted for an un-mapped reason.
    uint8 internal constant FAIL_REASON_PROCESS_REVERT = 5;
}
