// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibLaunchReadiness} from "./LibLaunchReadiness.sol";

/**
 * @title LaunchGate
 * @notice Re-checks every launch precondition at the moment a
 *         Timelock-governed Diamond is first unpaused (#945).
 *
 * @dev The first unpause of a production Diamond is a Timelock operation,
 *      and the Timelock waits out its delay between `scheduleBatch` and
 *      `executeBatch`. Anything read when the proposal was printed can stop
 *      holding during that delay — another governance operation removes the
 *      last swap adapter, clears the sanctions oracle, or grants the deploy
 *      key a role back — and an operation whose only call is an unpause
 *      would still execute. So the launch operation `Launch.s.sol` prints is
 *      a BATCH of two calls, in this order:
 *
 *        1. `LaunchGate.assertReady(diamond, tokenAdminRegistry, deployKey)`;
 *        2. `diamond.unpauseIfPauseEpoch(epoch)`, with the pause epoch read
 *           when the proposal was printed, so an incident pause recorded in
 *           the meantime makes the batch revert instead of being cleared by
 *           a launch decision taken before it.
 *
 *      The Timelock executes a batch atomically: when either call reverts,
 *      the whole execution reverts and the Diamond stays paused. A
 *      readiness or handover failure leaves the operation executable once
 *      the precondition holds again; a moved pause epoch needs a fresh
 *      proposal, by design.
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

    /// @notice The deploy key still holds a Diamond role: the governance
    ///         handover is not complete.
    error DeployKeyHoldsRole(address deployKey, bytes32 role);

    /// @notice No deploy key was named, so the handover cannot be checked.
    error NoDeployKey();

    /// @notice Every launch requirement and what the chain says about it now.
    function checks(address diamond, address tokenAdminRegistry)
        external
        view
        returns (LibLaunchReadiness.Check[] memory)
    {
        return LibLaunchReadiness.check(diamond, tokenAdminRegistry);
    }

    /// @notice Reverts {LaunchNotReady} with the first requirement that is
    ///         not both answered and met, {NoDeployKey} for a zero
    ///         `deployKey`, or {DeployKeyHoldsRole} while `deployKey` holds
    ///         any Diamond role (`LibAccessControl.knownRoles()`); returns
    ///         otherwise.
    function assertReady(address diamond, address tokenAdminRegistry, address deployKey) external view {
        if (deployKey == address(0)) revert NoDeployKey();
        LibLaunchReadiness.Check[] memory c = LibLaunchReadiness.check(diamond, tokenAdminRegistry);
        for (uint256 i; i < c.length; ++i) {
            if (!c[i].checkable || !c[i].met) {
                revert LaunchNotReady(c[i].label, LibLaunchReadiness.verdict(c[i]), c[i].detail);
            }
        }
        (bool held, bytes32 role) = LibLaunchReadiness.firstRoleHeld(diamond, deployKey);
        if (held) revert DeployKeyHoldsRole(deployKey, role);
    }
}
