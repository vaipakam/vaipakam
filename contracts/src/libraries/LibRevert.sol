// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/// @title LibRevert
/// @notice Shared helper for forwarding revert reasons across cross-facet
///         `address(this).call(...)` boundaries. Solidity's default behaviour
///         of dropping the inner revert data makes diagnosis painful and can
///         mask state-inconsistency bugs; this helper re-bubbles the inner
///         revert payload when present and falls back to a tagged generic
///         error otherwise.
library LibRevert {
    /// @dev Generic wrapper used when the inner call returned no revert data
    ///      (out-of-gas, empty revert). Mirrors the old
    ///      IVaipakamErrors.CrossFacetCallFailed signature so error ABIs
    ///      stay stable for off-chain indexers.
    error CrossFacetCallFailed(string reason);

    /// @notice Re-raises the inner revert data verbatim so the original
    ///         error selector / reason string surfaces to the caller. If the
    ///         inner call failed without revert data, emits a tagged
    ///         {CrossFacetCallFailed} with the caller-supplied context.
    /// @param success The success flag returned by `call` / `staticcall`.
    /// @param returnData The return-data buffer from the same call.
    /// @param context Human-readable tag for the fallback case.
    function bubbleOnFailure(
        bool success,
        bytes memory returnData,
        string memory context
    ) internal pure {
        if (success) return;
        if (returnData.length == 0) {
            revert CrossFacetCallFailed(context);
        }
        assembly {
            revert(add(returnData, 0x20), mload(returnData))
        }
    }

    /// @notice Typed-fallback variant of {bubbleOnFailure}. Behaves identically
    ///         when the inner call produced revert data (that data is
    ///         re-raised). When the inner call failed without revert data, the
    ///         caller-supplied typed error selector is raised instead of the
    ///         legacy string-based CrossFacetCallFailed wrapper.
    /// @param success The success flag returned by `call` / `staticcall`.
    /// @param returnData The return-data buffer from the same call.
    /// @param fallbackSelector 4-byte selector of the typed error to raise
    ///        (encode with `ErrorName.selector`).
    function bubbleOnFailureTyped(
        bool success,
        bytes memory returnData,
        bytes4 fallbackSelector
    ) internal pure {
        if (success) return;
        if (returnData.length == 0) {
            assembly {
                let ptr := mload(0x40)
                mstore(ptr, fallbackSelector)
                revert(ptr, 0x04)
            }
        }
        assembly {
            revert(add(returnData, 0x20), mload(returnData))
        }
    }
}
