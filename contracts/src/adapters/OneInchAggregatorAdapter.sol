// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AggregatorAdapterBase} from "./AggregatorAdapterBase.sol";

/**
 * @title OneInchAggregatorAdapter — keeper-supplied 1inch v6 swap.
 *
 * Wraps the 1inch v6 Swap API (`/swap/v6.0/{chain}/swap`). 1inch
 * coalesces the approval recipient and the swap-call destination into
 * a single AggregationRouterV6 address (`0x111111125421cA6dc452d289314280a0f8842A65`,
 * identical on every chain we support today). The {AggregatorAdapterBase}
 * still uses the split shape because:
 *
 *   1. Treating the two addresses as distinct slots even when they
 *      currently coincide is forward-compatible if 1inch ever ships a
 *      v7 that splits them (as 0x did with Settler / AllowanceHolder).
 *
 *   2. The strict-equality check on `swapTargetAllowed[swapTarget]`
 *      doubles as defence against a compromised keeper trying to
 *      pivot funds — even if 1inch never splits, the allowlist still
 *      catches a malicious `tx.to` injected into `adapterData`.
 *
 * Initial allowlist therefore contains exactly the AggregationRouter
 * address; that same address is also pinned as `allowanceTarget`.
 */
contract OneInchAggregatorAdapter is AggregatorAdapterBase {
    /// @param aggregationRouter_  The 1inch AggregationRouterV6 for
    ///                            this chain. Used as both the
    ///                            allowance target AND the seed entry
    ///                            in the swap-target allowlist.
    constructor(address aggregationRouter_)
        AggregatorAdapterBase(aggregationRouter_, _toSingleton(aggregationRouter_))
    {}

    function adapterName() external pure override returns (string memory) {
        return "OneInch";
    }

    function _toSingleton(address a) private pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }
}
