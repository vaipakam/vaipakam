// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibLaunchReadiness} from "../governance/LibLaunchReadiness.sol";

/**
 * @title ILaunchGate
 * @notice The call a Diamond's launch makes on its readiness gate (#945).
 * @dev `AdminFacet.launch` checks that the call it is given is
 *      {assertReady} with this Diamond as `diamond`, makes it, and unpauses
 *      only when it returns; the gate it called is then recorded as the
 *      launch's gate. Defined apart from `LaunchGate` so the facet depends
 *      on the call's shape, not on the gate's code.
 */
interface ILaunchGate {
    /// @notice The governance state the launch decision was taken against,
    ///         re-checked when the Timelock executes it.
    /// @param deployKey The deploy (admin) key, which must hold no Diamond role.
    /// @param owner     The Diamond owner the decision reviewed (the Timelock).
    /// @param roleEpoch The Diamond's role epoch when the handover gate
    ///                  proved every role's holders
    ///                  (`AccessControlFacet.roleEpoch`).
    struct Handover {
        address deployKey;
        address owner;
        uint64 roleEpoch;
    }

    /// @notice Returns only when every launch requirement for `diamond`
    ///         holds against `declared` and its governance state is still
    ///         `handover`; reverts with the first that does not.
    function assertReady(
        address diamond,
        LibLaunchReadiness.Declared calldata declared,
        Handover calldata handover
    ) external view;
}
