// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

import {RateLimiter} from "@chainlink/contracts-ccip/contracts/libraries/RateLimiter.sol";

/**
 * @title ITokenPoolRateLimit — the slice of a CCIP `TokenPool` this
 *        governor drives
 * @dev Minimal interface so the governor needs no CCIP pool concrete
 *      type. `setChainRateLimiterConfig` is callable by the pool's
 *      `rateLimitAdmin` (this governor) or its `owner`.
 */
interface ITokenPoolRateLimit {
    function setChainRateLimiterConfig(
        uint64 remoteChainSelector,
        RateLimiter.Config memory outboundConfig,
        RateLimiter.Config memory inboundConfig
    ) external;

    function getRateLimitAdmin() external view returns (address);
}

/**
 * @title VpfiPoolRateGovernor — the bounds-checked rate-limit admin for
 *        Vaipakam's CCIP token pools (T-068 Phase 2)
 *
 * Chainlink CCIP's stock `TokenPool` carries a per-lane token-bucket rate
 * limiter — a hard value/time cap that bounds the blast radius of a
 * worst-case verification failure. The pool exposes a dedicated
 * `rateLimitAdmin` role (separate from the pool owner) authorised to set
 * those limits.
 *
 * Vaipakam does NOT subclass the audited CCIP pool. Instead this contract
 * is registered as the pool's `rateLimitAdmin`, and it is the Vaipakam-side
 * modular seam for rate-limit control: it wraps the pool's setter behind
 * Vaipakam's standard **ET-008 range-bounded config** discipline —
 * compile-time `MIN_/MAX_` constants — so a governance action can revise a
 * lane's limit only *within* a safe band, never to an arbitrary value.
 *
 * Two deliberate stances:
 *  - **A lane's rate limit can never be disabled through this governor.**
 *    `setLaneRateLimits` rejects `isEnabled == false` — the per-lane cap
 *    is a security backstop and the routine governance path must not be
 *    able to remove it. (If a lane ever genuinely needs no limit, that is
 *    a pool-`owner` break-glass action, outside this governor.)
 *  - The governor is the *routine* path; the pool `owner` (the governance
 *    timelock) retains CCIP's built-in un-bounded authority as break-glass.
 *    This mirrors how a timelock can ultimately do anything — the governor
 *    makes the everyday change bounded and auditable.
 *
 * Starting values the bounds bracket (design §10 #2): capacity 50,000
 * VPFI, refill ≈ 5.8 VPFI/s.
 *
 * @dev `owner` is the admin multi-sig initially, the governance timelock
 *      later — the standard protocol phasing. UUPS-upgradeable per the
 *      project convention for non-Diamond contracts; if the bounds need
 *      to move, that is a deliberate, reviewable implementation upgrade.
 */
contract VpfiPoolRateGovernor is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable
{
    // ─── ET-008 bounds (compile-time) ───────────────────────────────────────

    /// @notice Minimum token-bucket capacity (max burst) — 10,000 VPFI.
    uint128 public constant MIN_RATE_LIMIT_CAPACITY = 10_000 ether;
    /// @notice Maximum token-bucket capacity — 10,000,000 VPFI, far under
    ///         the 230M global VPFI cap.
    uint128 public constant MAX_RATE_LIMIT_CAPACITY = 10_000_000 ether;
    /// @notice Minimum refill rate — 1 VPFI/s.
    uint128 public constant MIN_RATE_LIMIT_RATE = 1 ether;
    /// @notice Maximum refill rate — 5,000 VPFI/s.
    uint128 public constant MAX_RATE_LIMIT_RATE = 5_000 ether;

    // ─── Storage ────────────────────────────────────────────────────────────

    /// @notice The CCIP `TokenPool` this governor administers. This
    ///         governor must be registered as that pool's `rateLimitAdmin`
    ///         (a pool-`owner` action, performed at deploy/wiring time).
    address public pool;

    /// @dev Reserved storage for upgrade-safe appends (1 slot used above).
    uint256[49] private __gap;

    // ─── Events ─────────────────────────────────────────────────────────────

    /// @custom:event-category informational/config
    event PoolSet(address indexed previousPool, address indexed newPool);

    /// @notice A lane's inbound + outbound rate limits were (re)configured.
    /// @custom:event-category state-change/crosschain-config
    event LaneRateLimitsSet(
        uint64 indexed remoteChainSelector,
        uint128 outboundCapacity,
        uint128 outboundRate,
        uint128 inboundCapacity,
        uint128 inboundRate
    );

    // ─── Errors ─────────────────────────────────────────────────────────────

    /// @notice A zero address was supplied where a contract is required.
    error ZeroAddress();
    /// @notice A config had `isEnabled == false` — the governor will not
    ///         disable a lane's rate limit.
    error RateLimitDisableForbidden();
    /// @notice `capacity` fell outside [MIN, MAX].
    error CapacityOutOfBounds(uint128 capacity);
    /// @notice `rate` fell outside [MIN, MAX].
    error RateOutOfBounds(uint128 rate);

    // ─── Construction ───────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the proxy.
    /// @param owner_ Owner (the admin multi-sig initially, the governance
    ///        timelock later).
    /// @param pool_  The CCIP `TokenPool` this governor will administer.
    function initialize(address owner_, address pool_) external initializer {
        if (owner_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Ownable2Step_init();
        pool = pool_;
        emit PoolSet(address(0), pool_);
    }

    // ─── Rate-limit administration ──────────────────────────────────────────

    /// @notice Set a lane's inbound and outbound token-bucket rate limits,
    ///         bounds-checked against the ET-008 constants.
    /// @dev Owner-only. The governor must be the pool's `rateLimitAdmin`
    ///      for the underlying call to succeed. Both configs must be
    ///      enabled and in-bounds; CCIP's own `_validateTokenBucketConfig`
    ///      additionally enforces `rate <= capacity` at the pool.
    /// @param remoteChainSelector CCIP selector of the lane's remote chain.
    /// @param outboundConfig      Outbound (this-chain → remote) limiter.
    /// @param inboundConfig       Inbound (remote → this-chain) limiter.
    function setLaneRateLimits(
        uint64 remoteChainSelector,
        RateLimiter.Config calldata outboundConfig,
        RateLimiter.Config calldata inboundConfig
    ) external onlyOwner {
        _validateConfig(outboundConfig);
        _validateConfig(inboundConfig);

        ITokenPoolRateLimit(pool).setChainRateLimiterConfig(
            remoteChainSelector, outboundConfig, inboundConfig
        );

        emit LaneRateLimitsSet(
            remoteChainSelector,
            outboundConfig.capacity,
            outboundConfig.rate,
            inboundConfig.capacity,
            inboundConfig.rate
        );
    }

    /// @notice Point the governor at a different CCIP pool — for the CCT
    ///         pool-upgrade path (a new pool deployed + swapped in the
    ///         `TokenAdminRegistry`). Owner-only.
    function setPool(address newPool) external onlyOwner {
        if (newPool == address(0)) revert ZeroAddress();
        emit PoolSet(pool, newPool);
        pool = newPool;
    }

    /// @dev Reject a disabled limiter, then range-check capacity and rate.
    function _validateConfig(RateLimiter.Config calldata cfg) internal pure {
        if (!cfg.isEnabled) revert RateLimitDisableForbidden();
        if (
            cfg.capacity < MIN_RATE_LIMIT_CAPACITY
                || cfg.capacity > MAX_RATE_LIMIT_CAPACITY
        ) {
            revert CapacityOutOfBounds(cfg.capacity);
        }
        if (cfg.rate < MIN_RATE_LIMIT_RATE || cfg.rate > MAX_RATE_LIMIT_RATE) {
            revert RateOutOfBounds(cfg.rate);
        }
    }

    // ─── UUPS ───────────────────────────────────────────────────────────────

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}
}
