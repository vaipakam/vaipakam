// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IVPFIBuyMessages
 * @author Vaipakam Developer Team
 * @notice Shared payload shapes + message-type constants used by the
 *         bridged VPFI fixed-rate buy flow — {VPFIBuyAdapter}
 *         (non-Base chains) and {VPFIBuyReceiver} (Base).
 *
 * @dev Three message kinds cross the wire:
 *
 *        1. BUY_REQUEST  (adapter → receiver)
 *           The user paid `ethAmount` wei on their origin chain; Base
 *           must validate caps + reserve and ship VPFI back.
 *
 *        2. BUY_SUCCESS  (receiver → adapter)
 *           Base accepted the buy, shipped `vpfiDelivered` VPFI back
 *           via OFT, and tells the adapter to release the locked ETH
 *           to the local treasury.
 *
 *        3. BUY_FAILED   (receiver → adapter)
 *           Base rejected the buy (cap exceeded, rate unset, reserve
 *           empty, etc.). Adapter refunds the locked ETH to the buyer.
 *
 *      BUY_REQUEST payload (abi.encode):
 *        `(uint8 msgType, uint64 requestId, address buyer,
 *          uint32 originEid, uint256 ethAmountPaid, uint256 minVpfiOut)`
 *
 *      BUY_SUCCESS / BUY_FAILED payload (abi.encode):
 *        `(uint8 msgType, uint64 requestId, uint256 vpfiOut, uint8 reason)`
 *
 *      `requestId` is minted by the adapter on `buy()`, echoed by the
 *      receiver in the response, and used by the adapter to key its
 *      pending-buy table for refunds and replay protection.
 *
 *      Implemented as an abstract contract (not an interface) so it
 *      can expose named constants to inheriting contracts. Has no
 *      deployable bytecode by itself.
 */
abstract contract IVPFIBuyMessages {
    /// @notice Payload kind: adapter → receiver on buyer's `buy()`.
    uint8 internal constant MSG_TYPE_BUY_REQUEST = 1;

    /// @notice Payload kind: receiver → adapter on successful Base-side
    ///         processing + OFT dispatch.
    uint8 internal constant MSG_TYPE_BUY_SUCCESS = 2;

    /// @notice Payload kind: receiver → adapter on Base-side revert.
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
