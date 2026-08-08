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
    /// @dev INVERTED storage so the default is SUPPORTED: the accounting
    ///      and invariant suites wire this mock purely so the live bound
    ///      resolves, and a default-unsupported mapping would fail-close
    ///      every fixture. Tests pinning the r7 removed-lane behaviour
    ///      mark a selector unsupported explicitly.
    mapping(uint64 => bool) internal unsupportedChains;

    function setSupported(uint64 selector, bool supported) external {
        unsupportedChains[selector] = !supported;
    }

    function isSupportedChain(uint64 remoteChainSelector)
        external
        view
        returns (bool)
    {
        return !unsupportedChains[remoteChainSelector];
    }

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

/// @notice Minimal stand-in for the CCIP `TokenAdminRegistry` — token →
///         ACTIVE pool, the root of the live reference chain the
///         lane-capacity bounds walk (#1618 r7: resolving the pool here
///         is what makes a CCT pool rotation auto-track).
contract MockTokenAdminRegistry {
    mapping(address => address) internal pools;

    function setPool(address token, address pool) external {
        pools[token] = pool;
    }

    function getPool(address token) external view returns (address) {
        return pools[token];
    }
}
