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
