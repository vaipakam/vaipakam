// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {AggregatorAdapterBase} from "./AggregatorAdapterBase.sol";

/**
 * @title ZeroExAggregatorAdapter — keeper-supplied 0x v2 swap.
 *
 * Wraps the 0x v2 / AllowanceHolder Swap API
 * (`/swap/allowance-holder/quote`). Per
 * https://0x.org/docs/developer-resources/core-concepts/contracts the
 * approval recipient and the swap-call destination are intentionally
 * different addresses on this venue:
 *
 *   - allowanceTarget = AllowanceHolder. Same address on every
 *     post-Cancun chain (`0x0000000000001fF3684f28c67538d4D072C22734`),
 *     `0x0000000000005E88410CcDFaDe4a5EfaE4b49562` on Mantle. Pinned
 *     immutable at construction.
 *
 *   - swap target = the Settler that actually executes the swap. 0x
 *     rotates Settler addresses with each release and varies them by
 *     route type (taker-submitted, metatransaction, intents, bridge),
 *     so the operator pushes new Settlers via {addSwapTarget} as 0x
 *     ships them. The keeper passes the current Settler in the
 *     `transaction.to` field of the API response, repackaged as the
 *     first field of `adapterData`.
 *
 * Setting allowance on the Settler instead of the AllowanceHolder is
 * an explicit footgun — 0x's docs spell out "potential loss of tokens
 * or exposure to security risks." This split shape makes it
 * structurally impossible to commit that mistake even if a keeper is
 * compromised.
 */
contract ZeroExAggregatorAdapter is AggregatorAdapterBase {
    /// @param allowanceHolder_  The 0x AllowanceHolder for this chain.
    /// @param initialSettlers   Seed allowlist of legal Settler
    ///                          targets. Operator updates as 0x ships
    ///                          new Settler deploys.
    constructor(
        address allowanceHolder_,
        address[] memory initialSettlers
    ) AggregatorAdapterBase(allowanceHolder_, initialSettlers) {}

    function adapterName() external pure override returns (string memory) {
        return "ZeroEx";
    }
}
