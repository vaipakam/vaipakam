// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibSwap} from "../../src/libraries/LibSwap.sol";

/**
 * @notice Default adapter try-list used by Phase-7a-aware tests that
 *         don't care about ranking — a single entry pointing at adapter
 *         slot 0 (the legacy ZeroEx shim registered by `SetupTest`).
 *         The shim ignores `data`, so empty bytes are safe.
 *
 *         Tests that exercise the multi-adapter failover behaviour
 *         build their own `AdapterCall[]` inline.
 *
 * @dev Free function so any test file can `import` it without changing
 *      its inheritance chain. SetupTest / HelperTest are state contracts
 *      that downstream tests instantiate, not base classes — so a
 *      `function` member there wouldn't be reachable as a static call.
 */
function defaultAdapterCalls()
    pure
    returns (LibSwap.AdapterCall[] memory calls)
{
    calls = new LibSwap.AdapterCall[](1);
    calls[0] = LibSwap.AdapterCall({adapterIdx: 0, data: bytes("")});
}

/**
 * @notice Empty (zero-length) adapter try-list — exercises the #1005 (S9)
 *         guard on the forced-close entry points (`triggerLiquidation` /
 *         `triggerDefault`), which must reject an empty list rather than route
 *         an eligible loan into the full-collateral fallback with no swap
 *         route attempted.
 */
function emptyAdapterCalls()
    pure
    returns (LibSwap.AdapterCall[] memory calls)
{
    calls = new LibSwap.AdapterCall[](0);
}
