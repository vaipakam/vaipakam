// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title VpfiPoolRateBounds
 * @notice The ET-008 range every VPFI pool lane's CCIP rate limit must sit in.
 * @dev One source for two readers: `VpfiPoolRateGovernor` refuses a limit
 *      outside it, and the launch readiness check (`LibLaunchReadiness`)
 *      refuses to launch while any lane's limit is outside it or disabled
 *      (#945, Codex #2686 r6). Kept apart so the check reads the bounds the
 *      governor enforces, never a copy.
 */
library VpfiPoolRateBounds {
    /// @notice Minimum token-bucket capacity (max burst) — 10,000 VPFI.
    uint128 internal constant MIN_CAPACITY = 10_000 ether;
    /// @notice Maximum token-bucket capacity — 10,000,000 VPFI, far under
    ///         the 230M global VPFI cap.
    uint128 internal constant MAX_CAPACITY = 10_000_000 ether;
    /// @notice Minimum refill rate — 1 VPFI/s.
    uint128 internal constant MIN_RATE = 1 ether;
    /// @notice Maximum refill rate — 5,000 VPFI/s.
    uint128 internal constant MAX_RATE = 5_000 ether;
}
