// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibLaunchReadiness} from "./LibLaunchReadiness.sol";
import {LibLaunchCrossChainReadiness} from "./LibLaunchCrossChainReadiness.sol";

/**
 * @title LaunchCrossChainChecks
 * @notice Reads the two cross-chain launch requirements (the VPFI pool and
 *         its CCIP lanes) for {LaunchGate} (#2975).
 *
 * @dev {LaunchGate} re-reads every launch requirement on-chain, and all ten
 *      in one contract exceed EIP-170. This contract hosts the cross-chain
 *      pair. The gate creates it in its own constructor, so its creation
 *      code is part of the gate's: the gate's deterministic address still
 *      commits to the exact code of both, and a reviewer reads this
 *      contract's address from {LaunchGate.crossChainChecks}.
 *
 *      Stateless, ownerless and view-only: it reads the chain and returns
 *      the two {LibLaunchReadiness.Check} entries, nothing else.
 */
contract LaunchCrossChainChecks {
    /// @notice The VPFI pool check, then the CCIP lanes check, read off the
    ///         live chain against `declared`.
    function checks(address diamond, LibLaunchReadiness.Declared calldata declared)
        external
        view
        returns (LibLaunchReadiness.Check[2] memory)
    {
        return LibLaunchCrossChainReadiness.checks(diamond, declared);
    }
}
