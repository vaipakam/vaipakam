// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/**
 * @title ISwapAdapter — Phase 7a liquidation-path swap abstraction.
 *
 * Every adapter wraps one external DEX venue (0x Settler, 1inch Router,
 * UniswapV3 Router, Balancer V2 Vault, ...) behind a uniform `execute`
 * call. The liquidation facets drive a priority-ordered failover chain
 * via {LibSwap.swapWithFailover}, trying each adapter in sequence and
 * committing on the first one that returns at least `minOutputAmount`.
 *
 * Security invariants every adapter MUST honour:
 *
 *  - Realized output < `minOutputAmount` MUST revert. Adapters are
 *    trusted to not silently return less than promised.
 *
 *  - The DEX target each adapter calls is pinned by governance at
 *    adapter deploy time (constructor arg, immutable / governance-
 *    settable). `adapterData` may contain routing hints (pool fee,
 *    poolId, aggregator calldata) but MUST NOT alter the call
 *    destination.
 *
 *  - Token approvals to the adapter and from the adapter to its
 *    downstream target are granted immediately before the external
 *    call and revoked immediately after. No persistent allowances.
 *
 *  - The adapter MUST hand back to the caller exactly the part of the
 *    `inputAmount` it pulled in THIS call that its venue did not spend,
 *    and MUST NOT move any other balance it holds (#2472). The caller
 *    measures the spend as the fall in its own input balance, so an
 *    adapter that swept a balance it already held (a donation) would make
 *    a full sale read as a partial one. Whether a partial spend is
 *    acceptable is the CALLER's rule, enforced by {LibSwap}; the adapter
 *    only reports it faithfully. A revert unwinds the pull together with
 *    the swap, so a failed attempt leaves the caller's balance as it was
 *    and the failover loop retries the next adapter with the same input.
 */
interface ISwapAdapter {
    /// @notice Short human-readable tag emitted by LibSwap on each
    ///         attempt. Stable across upgrades so off-chain monitors
    ///         can pin alerts to a specific adapter lineage.
    function adapterName() external view returns (string memory);

    /// @notice Execute a swap on the wrapped venue.
    /// @param inputToken      ERC-20 being sold.
    /// @param outputToken     ERC-20 being received.
    /// @param inputAmount     Amount of `inputToken` offered for sale
    ///                        (seized collateral amount at liquidation
    ///                        time). Adapter pulls it via pre-granted
    ///                        allowance from `msg.sender` and returns any
    ///                        of it the venue did not spend.
    /// @param minOutputAmount Oracle-derived floor. Adapter MUST revert
    ///                        if realized output < this number.
    /// @param recipient       Address to receive `outputToken` proceeds.
    /// @param adapterData     Venue-specific routing payload:
    ///                          - 0x / 1inch: abi.encode(address
    ///                            swapTarget, bytes swapCalldata).
    ///                            `swapTarget` is the API response's
    ///                            `transaction.to` (0x v2) or `tx.to`
    ///                            (1inch v6); the adapter validates
    ///                            it against an owner-managed
    ///                            allowlist before forwarding the
    ///                            calldata. Approvals are pinned to a
    ///                            separate `allowanceTarget`.
    ///                          - UniV3: abi.encode(uint24 poolFee).
    ///                          - Balancer V2: abi.encode(bytes32 poolId).
    ///                          - Adapters that read their own config
    ///                            from storage accept empty bytes.
    /// @return outputAmount   Realized amount of `outputToken` delivered
    ///                        to `recipient`. Always >= `minOutputAmount`.
    function execute(
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 minOutputAmount,
        address recipient,
        bytes calldata adapterData
    ) external returns (uint256 outputAmount);
}
