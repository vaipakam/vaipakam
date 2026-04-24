// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AggregatorAdapterBase} from "./AggregatorAdapterBase.sol";

/**
 * @title OneInchAggregatorAdapter — keeper-supplied 1inch swap.
 *
 * Deployed per-chain with the 1inch AggregationRouter address as the
 * pinned target. Keepers fetch a quote from the 1inch API
 * (`/v6.0/{chain}/swap`), pack the `tx.data` as `adapterData`, and
 * trigger a liquidation that routes through this adapter.
 *
 * Identical trust model to {ZeroExAggregatorAdapter}: router target
 * is immutable, keeper controls route bytes but not destination, and
 * min-output is enforced on this side via a balance delta around the
 * call — a hostile keeper can pick a suboptimal route but cannot
 * push realized proceeds below the oracle-derived floor.
 */
contract OneInchAggregatorAdapter is AggregatorAdapterBase {
    constructor(address oneInchRouter) AggregatorAdapterBase(oneInchRouter) {}

    function adapterName() external pure override returns (string memory) {
        return "OneInch";
    }
}
