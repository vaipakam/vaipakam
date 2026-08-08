// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

/// @title MockVpfiTokenPool
/// @notice Test double for the CCIP VPFI TokenPool's LIVE per-lane limiter
///         views — the surface `RepatriationFacet`'s lane-capacity bounds
///         read (#1568 C2). Buckets are settable per selector; an UNSET
///         selector reads `isEnabled == false`, which the facet — like
///         CCIP's own `_consume` — treats as "no bound", so suites that
///         only need the wiring present (the accounting and invariant
///         suites, which deliberately drive near-max magnitudes) wire the
///         mock and touch nothing else.
/// @dev    The struct comes from the pinned CCIP library, never a
///         hand-typed copy, so the decode shape cannot drift.
contract MockVpfiTokenPool {
    mapping(uint64 => RateLimiter.TokenBucket) internal inboundBuckets;
    mapping(uint64 => RateLimiter.TokenBucket) internal outboundBuckets;

    function setInbound(uint64 selector, bool enabled, uint128 capacity)
        external
    {
        inboundBuckets[selector] = RateLimiter.TokenBucket({
            tokens: capacity,
            lastUpdated: uint32(block.timestamp),
            isEnabled: enabled,
            capacity: capacity,
            rate: 1
        });
    }

    function setOutbound(uint64 selector, bool enabled, uint128 capacity)
        external
    {
        outboundBuckets[selector] = RateLimiter.TokenBucket({
            tokens: capacity,
            lastUpdated: uint32(block.timestamp),
            isEnabled: enabled,
            capacity: capacity,
            rate: 1
        });
    }

    function getCurrentInboundRateLimiterState(uint64 remoteChainSelector)
        external
        view
        returns (RateLimiter.TokenBucket memory)
    {
        return inboundBuckets[remoteChainSelector];
    }

    function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector)
        external
        view
        returns (RateLimiter.TokenBucket memory)
    {
        return outboundBuckets[remoteChainSelector];
    }
}

/// @notice Minimal stand-in for the `CcipMessenger` chainId→selector
///         registry the lane-capacity bounds consult. Used by suites that
///         have no full messenger mock; the transport suite's channel
///         messenger carries its own registry.
contract MockCcipSelectorRegistry {
    mapping(uint256 => uint64) public chainSelectorOf;

    function setChainSelector(uint256 chainId, uint64 selector) external {
        chainSelectorOf[chainId] = selector;
    }
}
