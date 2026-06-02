// script/utils/EncodeMultiSend.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title EncodeMultiSend
 * @author Vaipakam Developer Team
 * @notice T-086 Round-5 Block A (#313) — helper for building the
 *         packed payload Gnosis Safe's `MultiSend` library
 *         consumes when invoked via `Operation.DelegateCall` from
 *         a Safe `execTransaction`. Used by the atomic
 *         diamondCut + UUPS-upgrade deploy script per the
 *         Round-5.1 errata §16 A.10.
 *
 *         The packed format (per Safe's MultiSend.sol):
 *
 *           For each sub-call:
 *             uint8   operation      // 0 = Call, 1 = DelegateCall
 *             address to             // 20 bytes
 *             uint256 value          // 32 bytes
 *             uint256 dataLength     // 32 bytes
 *             bytes   data           // <dataLength> bytes
 *
 *           All concatenated; submitted as the calldata to
 *           `MultiSend.multiSend(bytes)`.
 *
 *         The outer Safe call is:
 *           safe.execTransaction(
 *               to:        multiSendAddress,
 *               value:     0,
 *               data:      abi.encodeCall(MultiSend.multiSend, packed),
 *               operation: Operation.DelegateCall, // (= 1)
 *               …
 *           )
 *
 *         The `Operation.DelegateCall` on the OUTER Safe call is
 *         what makes the sub-calls run in the Safe's storage
 *         context — so `msg.sender` for each sub-call is the
 *         Safe owner (= the diamond / executor owner), and
 *         the `onlyOwner` predicates pass.
 *
 *         The INNER operation byte on each sub-call is
 *         conventionally `0` (Call) because the sub-calls
 *         themselves are diamondCut + UUPSUpgrade — they want
 *         normal `msg.sender == safe` semantics, NOT a nested
 *         delegatecall. See the Safe MultiSend reference for
 *         when an inner DelegateCall is appropriate.
 */
library EncodeMultiSend {
    /// @notice One sub-call in the multicall payload.
    struct SubCall {
        uint8 operation; // 0 = Call, 1 = DelegateCall — inner; usually 0
        address to;
        uint256 value;
        bytes data;
    }

    /// @notice Pack a list of sub-calls into the byte string
    ///         MultiSend's `multiSend(bytes)` consumes.
    function pack(SubCall[] memory calls) internal pure returns (bytes memory packed) {
        for (uint256 i = 0; i < calls.length; ) {
            SubCall memory c = calls[i];
            packed = abi.encodePacked(
                packed,
                c.operation,
                c.to,
                c.value,
                uint256(c.data.length),
                c.data
            );
            unchecked { ++i; }
        }
    }

    /// @notice Convenience: pack + wrap into the
    ///         `MultiSend.multiSend(bytes)` calldata.
    /// @dev    The function selector for `multiSend(bytes)` is
    ///         the keccak256 prefix `0x8d80ff0a`. Hard-coded so
    ///         the deploy script doesn't need to import the
    ///         MultiSend ABI just to encode the call.
    function encodeMultiSendCall(SubCall[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(0x8d80ff0a, pack(calls));
    }
}
