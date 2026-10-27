// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibLaunchReadiness, ILaunchReadableDiamond} from "./LibLaunchReadiness.sol";
import {ILaunchGate} from "../interfaces/ILaunchGate.sol";

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
 *      ONE call, `diamond.launch(epoch, gate, gateCall)` (AdminFacet), where
 *      `gateCall` is `assertReady(diamond, declared, handover)` on this gate:
 *
 *        - `declared` ({LibLaunchReadiness.Declared}) is the CCIP registry
 *          and the WETH, VPFI pool, rate governor and lanes (each with its
 *          remote pool and token), feed registry and reward role (#2920)
 *          the chain must match, and `handover`
 *          ({ILaunchGate.Handover}) is the deploy key, the Diamond owner, the
 *          role epoch the handover gate proved and the Timelock's call count
 *          when the launch was proposed — all in the calldata, so the Safe
 *          reviews exactly what is enforced;
 *        - the Diamond makes the call itself, refuses one that is not
 *          `assertReady` for itself, unpauses only when it returns and only
 *          while the pause epoch is still `epoch`, and records this gate as
 *          the one its launch went through. A Timelock operation that only
 *          unpauses leaves no gate on that record, so it can never be taken
 *          for a launch (Codex #2686 r9 P1).
 *
 *      A readiness or handover failure leaves the operation executable once
 *      the precondition holds again; a moved pause epoch or role epoch needs
 *      a fresh proposal, by design.
 *
 *      The gate is stateless, ownerless and constructor-free, and it is
 *      deployed at a deterministic CREATE2 address (`DeployLaunchGate.s.sol`),
 *      so its address commits to its exact bytecode: a reviewer of the
 *      proposal can check the gate's code from its address alone. It reads
 *      the same {LibLaunchReadiness} list the launch script reports, and it
 *      accepts only "every requirement met": a requirement the chain cannot
 *      answer refuses here exactly as it does for a production launch.
 */
contract LaunchGate is ILaunchGate {
    /// @notice A launch requirement does not hold. `state` is the printed
    ///         verdict ("NOT MET" or "NOT CHECKED").
    error LaunchNotReady(string label, string state, string detail);

    /// @notice The deploy key still holds a Diamond role: the governance
    ///         handover is not complete.
    error DeployKeyHoldsRole(address deployKey, bytes32 role);

    /// @notice No deploy key was named, so the handover cannot be checked.
    error NoDeployKey();

    /// @notice The Diamond's owner is not the one the launch decision
    ///         reviewed: ownership moved during the delay.
    error OwnerMoved(address expected, address live);

    /// @notice The Diamond's role table changed after the handover gate
    ///         proved it (Codex #2686 r9 P1): some role was granted, revoked,
    ///         renounced or re-administered during the delay, so the holder
    ///         sets the Safe approved are no longer known to hold.
    error RoleEpochMoved(uint64 expected, uint64 live);

    /// @notice The Timelock executed another call after the launch was
    ///         proposed (Codex #2686 r11, r12): some governance action landed
    ///         during the delay (a facet cut, a pool ownership transfer, a
    ///         rate-governor upgrade, a mirror token's pool change, anything
    ///         the Timelock may do), so the launch would execute against state
    ///         the decision never saw.
    error TimelockActedDuringDelay(uint64 expected, uint64 live);

    /// @notice The Diamond's owner does not count its executed calls
    ///         (`executedCalls()`), so whether governance acted during the
    ///         delay cannot be known.
    error TimelockCallsUnreadable(address owner);

    /// @notice Every launch requirement and what the chain says about it now.
    function checks(address diamond, LibLaunchReadiness.Declared calldata declared)
        external
        view
        returns (LibLaunchReadiness.Check[] memory)
    {
        return LibLaunchReadiness.check(diamond, declared);
    }

    /// @notice Reverts {LaunchNotReady} with the first requirement that is
    ///         not both answered and met, {NoDeployKey} for a zero deploy
    ///         key, {OwnerMoved} unless the Diamond's owner is still
    ///         `handover.owner`, {DeployKeyHoldsRole} while the deploy key
    ///         holds any Diamond role (`LibAccessControl.knownRoles()`), or
    ///         {RoleEpochMoved} unless the Diamond's role epoch is still
    ///         `handover.roleEpoch`, or {TimelockActedDuringDelay} unless the
    ///         Timelock has executed no call since the proposal (the launch
    ///         call itself is still running, so it is not yet counted);
    ///         returns otherwise.
    /// @dev The role epoch stands for every holder of every Diamond role:
    ///      they are not enumerable on-chain, so the gate cannot re-read
    ///      them, but it can tell that not one has changed since the proof.
    ///      What the epoch does not cover, the Timelock's own role set, can
    ///      change only through the Timelock, and no change to it removes
    ///      the delay: `updateDelay` is the Timelock's own call and refuses
    ///      anything below its immutable floor.
    ///
    ///      The Timelock's call count is the root of the rest. Everything the
    ///      launch depends on is governed by the Timelock: the Diamond (its
    ///      configuration, roles and facets), and, as the readiness checks
    ///      require, the VPFI pool, its rate governor, the registry's VPFI
    ///      administration and the mirror token. Not every effect of a
    ///      governance call is readable on-chain (a CCIP pool's pending
    ///      owner is private, an upgraded governor keeps its old getters'
    ///      answers), so instead of re-reading each one the launch requires
    ///      that the Timelock executed nothing since the proposal. What can
    ///      change WITHOUT the Timelock is bound separately: the pause
    ///      (Guardian, watcher) by the epoch `launch` checks, and the role
    ///      table (a holder renouncing, the emergency revoker) by the role
    ///      epoch.
    function assertReady(
        address diamond,
        LibLaunchReadiness.Declared calldata declared,
        Handover calldata handover
    ) external view {
        if (handover.deployKey == address(0)) revert NoDeployKey();
        LibLaunchReadiness.Check[] memory c = LibLaunchReadiness.check(diamond, declared);
        for (uint256 i; i < c.length; ++i) {
            if (!c[i].checkable || !c[i].met) {
                revert LaunchNotReady(c[i].label, LibLaunchReadiness.verdict(c[i]), c[i].detail);
            }
        }
        address liveOwner = ILaunchReadableDiamond(diamond).owner();
        if (liveOwner != handover.owner) revert OwnerMoved(handover.owner, liveOwner);
        (bool held, bytes32 role) = LibLaunchReadiness.firstRoleHeld(diamond, handover.deployKey);
        if (held) revert DeployKeyHoldsRole(handover.deployKey, role);
        uint64 liveEpoch = ILaunchReadableDiamond(diamond).roleEpoch();
        if (liveEpoch != handover.roleEpoch) revert RoleEpochMoved(handover.roleEpoch, liveEpoch);
        (bool readable, uint64 liveCalls) = LibLaunchReadiness.timelockCalls(liveOwner);
        if (!readable) revert TimelockCallsUnreadable(liveOwner);
        if (liveCalls != handover.timelockCalls) revert TimelockActedDuringDelay(handover.timelockCalls, liveCalls);
    }
}
