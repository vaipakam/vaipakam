// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AggregatorAdapterBase} from "./AggregatorAdapterBase.sol";

/**
 * @title ZeroExAggregatorAdapter — keeper-supplied 0x / Settler swap.
 *
 * Deployed per-chain with the canonical 0x ExchangeProxy or Settler
 * address as the pinned target. Keepers fetch a quote from the 0x
 * Swap API off-chain, pack `transaction.data` as `adapterData`, and
 * trigger a liquidation that routes through this adapter.
 *
 * This replaces the legacy `IZeroExProxy.swap(...)` simplified ABI
 * we used pre-Phase-7a; 0x does not guarantee forward-compatibility
 * on that wrapper, whereas the raw `{target, data}` pattern is the
 * canonical 0x integration and persists through the Settler rollout.
 */
contract ZeroExAggregatorAdapter is AggregatorAdapterBase {
    constructor(address zeroExRouter) AggregatorAdapterBase(zeroExRouter) {}

    function adapterName() external pure override returns (string memory) {
        return "ZeroEx";
    }
}
