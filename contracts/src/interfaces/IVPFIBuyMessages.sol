// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IVPFIBuyMessages
 * @author Vaipakam Developer Team
 * @notice Shared payload shapes + message-type constants used by the
 *         bridged VPFI fixed-rate buy flow — {VPFIBuyAdapter}
 *         (non-Base chains) and {VPFIBuyReceiver} (Base).
 *
 * @dev T-031 Layer 2 (cross-chain hardening): the success path now
 *      uses the LZ-V2 OFT-compose feature instead of a separate
 *      reply message. Two message kinds cross the wire:
 *
 *        1. BUY_REQUEST  (adapter → receiver, OApp send)
 *           The user paid `ethAmount` wei on their origin chain; Base
 *           must validate caps + reserve and ship VPFI back.
 *
 *        2. BUY_FAILED   (receiver → adapter, OApp send)
 *           Base rejected the buy (cap exceeded, rate unset, reserve
 *           empty, etc.). Adapter refunds the locked ETH to the buyer.
 *
 *      Success is delivered as a single OFT-compose message (Base
 *      receiver → source-chain adapter). The OFT mint lands the VPFI
 *      on the source-chain adapter (NOT directly on the buyer's
 *      wallet); the compose payload carries `(uint64 requestId)`. The
 *      adapter's `lzCompose` handler then cross-checks
 *      `pendingBuys[requestId].buyer` (its own authoritative local
 *      truth — set by the source-chain `buy()` call) and only
 *      forwards VPFI to that wallet, releasing the user's ETH to
 *      treasury at the same time. A forged BUY_REQUEST that arrives
 *      via a compromised LZ DVN therefore mints VPFI on Base but
 *      cannot deliver it anywhere useful: the source-chain adapter
 *      finds no matching `pendingBuys` entry and the VPFI is recorded
 *      as stuck (owner-recoverable). See `T-031` in `docs/ToDo.md`
 *      for the full layered-defense rationale.
 *
 *      BUY_REQUEST payload (abi.encode):
 *        `(uint8 msgType, uint64 requestId, address buyer,
 *          uint32 originEid, uint256 ethAmountPaid, uint256 minVpfiOut)`
 *
 *      BUY_FAILED payload (abi.encode):
 *        `(uint8 msgType, uint64 requestId, uint256 vpfiOut, uint8 reason)`
 *        (`vpfiOut` is always 0 on this kind; kept for layout stability.)
 *
 *      OFT-compose payload (abi.encode):
 *        `(uint64 requestId)`
 *        Wrapped by `OFTComposeMsgCodec` into the standard
 *        `[nonce(8)][srcEid(4)][amountLD(32)][composeFrom(32)][appMsg…]`
 *        framing on receipt.
 *
 *      `requestId` is minted by the adapter on `buy()`, echoed back by
 *      the receiver inside the OFT-compose payload, and used by the
 *      adapter to key its pending-buy table for cross-check + refund
 *      + replay protection.
 *
 *      Implemented as an abstract contract (not an interface) so it
 *      can expose named constants to inheriting contracts. Has no
 *      deployable bytecode by itself.
 */
abstract contract IVPFIBuyMessages {
    /// @notice Payload kind: adapter → receiver on buyer's `buy()`.
    uint8 internal constant MSG_TYPE_BUY_REQUEST = 1;

    /// @notice Payload kind: receiver → adapter on Base-side revert.
    /// @dev Numeric value `3` preserved (was `2 = BUY_SUCCESS, 3 = BUY_FAILED`
    ///      in the original three-message protocol). BUY_SUCCESS is gone:
    ///      the OFT-compose mint to the source-chain adapter is the
    ///      success signal in the new flow. Keeping `3` here means the
    ///      adapter's `_lzReceive` decoder doesn't need to remap old
    ///      payloads if any are in flight at cutover.
    uint8 internal constant MSG_TYPE_BUY_FAILED = 3;

    /// @notice Reason codes included in BUY_FAILED so frontends can
    ///         surface useful errors to the buyer.
    /// @dev Kept as named constants (not enum) so external consumers
    ///      (e.g. the subgraph) can pin on a stable selector.
    uint8 internal constant FAIL_REASON_UNKNOWN = 0;
    uint8 internal constant FAIL_REASON_CAP_EXCEEDED = 1;
    uint8 internal constant FAIL_REASON_RATE_UNSET_OR_DISABLED = 2;
    uint8 internal constant FAIL_REASON_RESERVE_INSUFFICIENT = 3;
    uint8 internal constant FAIL_REASON_AMOUNT_TOO_SMALL = 4;
    uint8 internal constant FAIL_REASON_PROCESS_REVERT = 5;
}
