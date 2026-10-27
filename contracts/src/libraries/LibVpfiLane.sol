// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

import {LibVaipakam} from "./LibVaipakam.sol";

/// @dev The slice of {CcipMessenger}'s registry the lane-capacity reads use —
///      the chainId → CCIP-selector mapping ConfigureCcip wires.
interface ICcipSelectorRegistry {
    function chainSelectorOf(uint256 chainId) external view returns (uint64);
}

/// @dev The slice of the CCIP TokenAdminRegistry the lane-capacity reads use —
///      token → ACTIVE pool. Resolving the pool live is what makes a CCT pool
///      rotation (TokenAdminRegistry.setPool) auto-track: there is no stored
///      pool address to go stale.
interface ITokenAdminRegistryView {
    function getPool(address token) external view returns (address);
}

/// @dev The slice of the CCIP VPFI TokenPool the lane-capacity reads use —
///      lane membership + the LIVE per-lane limiter state. The struct comes
///      from the pinned CCIP library itself, never a hand-typed copy, so the
///      decode shape cannot drift from the audited pool's.
interface IVpfiPoolRateLimitView {
    function isSupportedChain(uint64 remoteChainSelector)
        external
        view
        returns (bool);

    function getCurrentInboundRateLimiterState(uint64 remoteChainSelector)
        external
        view
        returns (RateLimiter.TokenBucket memory);

    function getCurrentOutboundRateLimiterState(uint64 remoteChainSelector)
        external
        view
        returns (RateLimiter.TokenBucket memory);
}

/**
 * @title  LibVpfiLane — the LIVE VPFI CCIP lane bucket toward one chain
 * @author Vaipakam Developer Team
 * @notice The ONE resolver of "how much VPFI may cross the lane toward
 *         `remoteChainId` right now": the configured CCIP TokenAdminRegistry
 *         → this chain's ACTIVE VPFI pool → the lane's CCIP selector (from the
 *         value-carrying messenger) → lane membership → the live bucket.
 *         The repatriation bounds (#1568) enforce against it, and the reward
 *         remittance (#918) sizes its parts by it, so the two read one rule.
 * @dev    Fail-closed at every rung, and REPORTED rather than thrown so each
 *         caller decides what a missing rung means: an unset registry or
 *         messenger, or no pool registered for the token, is `NotConfigured`;
 *         an unknown selector, or a lane the pool does not carry, is
 *         `LaneUnknown`. The support check is load-bearing (#1618 r7): for a
 *         lane the pool does not carry, the limiter getter returns a ZEROED
 *         bucket with `isEnabled == false` — indistinguishable from "governor
 *         chose unlimited". A disabled limiter on a lane the pool DOES carry
 *         imposes no bound — CCIP's own `_consume` short-circuits the same way,
 *         and the pool rate governor refuses to disable a lane's limit
 *         (ET-008), so that branch means "governor policy says unlimited",
 *         never "unconfigured".
 *
 *         The registry is the one the repatriation surfaces arm
 *         (`RepatriationFacet.setRepatriationTokenAdminRegistry`, wired on
 *         every chain by ConfigureCcip): permanent Chainlink infrastructure,
 *         not a repatriation-specific setting.
 */
library LibVpfiLane {
    /// @notice Which rung of the resolution answered.
    enum LaneStatus {
        Read,
        NotConfigured,
        LaneUnknown
    }

    /// @notice The live bucket of the VPFI lane toward `remoteChainId`: the
    ///         inbound one (value this chain RECEIVES) or the outbound one
    ///         (value it SENDS).
    /// @return status What the resolution found; `bucket` is meaningful only
    ///                for `Read`.
    /// @return bucket The pool's current limiter state for the lane, refilled
    ///                to this block.
    function liveBucket(
        LibVaipakam.Storage storage s,
        uint256 remoteChainId,
        bool inbound
    ) internal view returns (LaneStatus status, RateLimiter.TokenBucket memory bucket) {
        address registry = s.repatriationTokenAdminRegistry;
        address messenger = s.crossChainMessenger;
        if (registry == address(0) || messenger == address(0)) {
            return (LaneStatus.NotConfigured, bucket);
        }
        uint64 selector =
            ICcipSelectorRegistry(messenger).chainSelectorOf(remoteChainId);
        if (selector == 0) return (LaneStatus.LaneUnknown, bucket);
        address pool = ITokenAdminRegistryView(registry).getPool(s.vpfiToken);
        if (pool == address(0)) return (LaneStatus.NotConfigured, bucket);
        if (!IVpfiPoolRateLimitView(pool).isSupportedChain(selector)) {
            return (LaneStatus.LaneUnknown, bucket);
        }
        bucket = inbound
            ? IVpfiPoolRateLimitView(pool).getCurrentInboundRateLimiterState(selector)
            : IVpfiPoolRateLimitView(pool).getCurrentOutboundRateLimiterState(selector);
        status = LaneStatus.Read;
    }
}
