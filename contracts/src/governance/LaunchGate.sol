// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibLaunchReadiness} from "./LibLaunchReadiness.sol";

/**
 * @title LaunchGate
 * @notice Re-checks the launch requirements at the moment a
 *         Timelock-governed Diamond is first unpaused (#945).
 *
 * @dev The first unpause of a production Diamond is a Timelock operation,
 *      and the Timelock waits out its delay between `scheduleBatch` and
 *      `executeBatch`. A requirement read when the proposal was printed can
 *      stop holding during that delay — another governance operation
 *      removes the last swap adapter, a sanctions oracle is cleared — and an
 *      operation whose only call is `unpause()` would still execute. So the
 *      launch operation `Launch.s.sol` prints is a BATCH of two calls, in
 *      this order:
 *
 *        1. `LaunchGate.assertReady(diamond, vpfiTokenPool)`;
 *        2. `diamond.unpause()`.
 *
 *      The Timelock executes a batch atomically: when step 1 reverts, the
 *      whole execution reverts, the Diamond stays paused, and the operation
 *      stays ready to execute once the requirement holds again (or is
 *      cancelled by the Pauser Safe and proposed afresh).
 *
 *      The gate is stateless, ownerless and constructor-free, and it is
 *      deployed at a deterministic CREATE2 address (`DeployLaunchGate.s.sol`),
 *      so its address commits to its exact bytecode: a reviewer of the
 *      proposal can check the gate's code from its address alone. It reads
 *      the same {LibLaunchReadiness} list the launch script reports, and it
 *      accepts only "every requirement met": a requirement the chain cannot
 *      answer refuses here exactly as it does for a production launch.
 */
contract LaunchGate {
    /// @notice A launch requirement does not hold. `state` is the printed
    ///         verdict ("NOT MET" or "NOT CHECKED").
    error LaunchNotReady(string label, string state, string detail);

    /// @notice Every launch requirement and what the chain says about it now.
    function checks(address diamond, address vpfiTokenPool)
        external
        view
        returns (LibLaunchReadiness.Check[] memory)
    {
        return LibLaunchReadiness.check(diamond, vpfiTokenPool);
    }

    /// @notice Reverts {LaunchNotReady} with the first requirement that is
    ///         not both answered and met; returns otherwise.
    function assertReady(address diamond, address vpfiTokenPool) external view {
        LibLaunchReadiness.Check[] memory c = LibLaunchReadiness.check(diamond, vpfiTokenPool);
        for (uint256 i; i < c.length; ++i) {
            if (!c[i].checkable || !c[i].met) {
                revert LaunchNotReady(c[i].label, LibLaunchReadiness.verdict(c[i]), c[i].detail);
            }
        }
    }
}
