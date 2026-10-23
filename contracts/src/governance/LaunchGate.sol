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
 *          remote pool and token) the chain must match, and `handover`
 *          ({ILaunchGate.Handover}) is the deploy key, the Diamond owner, the
 *          role epoch the handover gate proved and the facet table the
 *          launch was decided against — all in the calldata, so the Safe
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

    /// @notice The Diamond's facet table is not the one the launch was
    ///         decided against (Codex #2686 r11 P1): a `diamondCut` landed
    ///         during the delay, so every check above read code the decision
    ///         never saw.
    error FacetTableMoved(bytes32 expected, bytes32 live);

    /// @notice The Diamond's loupe did not answer `facets()`.
    error FacetTableUnreadable();

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
    ///         `handover.roleEpoch`, or {FacetTableMoved} unless its facet
    ///         table is still `handover.facetTable`; returns otherwise.
    /// @dev The role epoch stands for every holder of every Diamond role:
    ///      they are not enumerable on-chain, so the gate cannot re-read
    ///      them, but it can tell that not one has changed since the proof.
    ///      What the epoch does not cover, the Timelock's own role set, can
    ///      change only through the Timelock, and no change to it removes
    ///      the delay: `updateDelay` is the Timelock's own call and refuses
    ///      anything below its immutable floor.
    ///
    ///      Together these bind the launch to every piece of Diamond state
    ///      governance can change: the configuration (the readiness checks
    ///      themselves), the owner, the role table (the role epoch), the
    ///      code (the facet table) and the pause (the epoch `launch` checks).
    ///      The facet table is checked because every check reads through the
    ///      Diamond's facets: a facet replaced during the delay could answer
    ///      a getter from state the protocol's own code never reads.
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
        (bool readable, bytes32 liveTable) = LibLaunchReadiness.facetTable(diamond);
        if (!readable) revert FacetTableUnreadable();
        if (liveTable != handover.facetTable) revert FacetTableMoved(handover.facetTable, liveTable);
    }
}
