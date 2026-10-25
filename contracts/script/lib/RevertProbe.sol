// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/**
 * @title RevertProbe
 * @notice The ONE way a broadcasting script proves that a call reverts:
 *         run it as `caller` in the simulation only, and leave the
 *         simulation exactly as it found it.
 *
 * @dev    Why not `vm.prank(caller)` + `target.call(data)` on its own, which
 *         is what the Anvil flow scripts used to do (#1646):
 *
 *         A call made under `vm.prank` at the script's top level still
 *         spends a NONCE of the pranked account in the simulation. The call
 *         is not broadcast, so on chain that nonce is never used. When the
 *         same account broadcasts afterwards, forge signs its next
 *         transaction one nonce ahead of the chain, the node never mines
 *         it, and the run stops with "provider nonce (N) is still behind
 *         expected nonce (N+1)". Measured on the positive-flow wave: N25's
 *         sub-floor sale probe left `newLender` with a gap at nonce 0x13,
 *         and the real sale signed at 0x14 never landed.
 *
 *         And not `vm.startBroadcast` + try/catch: forge records a caught
 *         call like any other and replays it on chain, where its revert
 *         aborts the whole broadcast.
 *
 *         A state snapshot around the pranked call discards everything the
 *         probe did, the nonce included, so the probe cannot shift any
 *         later transaction. The probe's own effects are discarded too,
 *         which is the point: it exists to observe a refusal, not to change
 *         state.
 */
library RevertProbe {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Call `target` with `data` as `caller`, in the simulation only.
    /// @return ok  Whether the call succeeded.
    /// @return ret The call's return data, or its revert data.
    function call(
        address caller,
        address target,
        bytes memory data
    ) internal returns (bool ok, bytes memory ret) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(caller);
        (ok, ret) = target.call(data);
        vm.revertToStateAndDelete(snapshot);
    }
}
