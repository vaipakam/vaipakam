// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";

/**
 * @title  BindServiceCapacityEscrow
 * @notice Bind this chain's service-capacity deposit escrow and publish it in the
 *         deployment artifact as `.serviceCapacityEscrow` (#2583).
 *
 *         `bindServiceCapacityEscrow()` constructs a `RewardCustodyHolder`
 *         instance of its own (the contract that custodies operators' refundable
 *         capacity principal) and binds it ONCE. The Diamond constructs it, so
 *         nothing is deployed or supplied here.
 *
 *  - `run()`    — DIRECT: `ADMIN_PRIVATE_KEY` holds `ADMIN_ROLE` (every chain
 *                 before `Handover`; testnets stay admin-owned). Binds and
 *                 writes NOTHING. Refuses before any broadcast when the key
 *                 lacks the role, pointing at `stage()`.
 *  - `stage()`  — STAGED, for a handed-over deployment where `ADMIN_ROLE` sits on
 *                 the Timelock: broadcasts nothing and prints the calldata the
 *                 Timelock executes against the Diamond.
 *  - `record()` — after the bind has CONFIRMED, by either route: writes
 *                 `.serviceCapacityEscrow` from the address the Diamond reports
 *                 in live state. Refuses while nothing is bound, and when the
 *                 artifact already names a different escrow.
 *
 * @dev    Why bind and record are separate runs (Codex #2585 r1). The artifact
 *         must never name a holder the Diamond does not use. A run that binds
 *         would otherwise record the address from Forge's pre-broadcast
 *         simulation, before the transaction is submitted or confirmed. And a
 *         run on an already-bound chain sends nothing, so Forge treats it as a
 *         dry run and the ordinary writers skip it. `record()` writes through
 *         the dedicated reconciliation writer
 *         ({Deployments.writeServiceCapacityEscrowReconciled}), from live state
 *         only, and is idempotent.
 *
 *         Usage, from contracts/ on main:
 *           forge script script/BindServiceCapacityEscrow.s.sol --rpc-url $RPC --broadcast   # bind (direct)
 *           forge script script/BindServiceCapacityEscrow.s.sol --sig "stage()" --rpc-url $RPC
 *           forge script script/BindServiceCapacityEscrow.s.sol --sig "record()" --rpc-url $RPC  # after confirmation
 *           bash script/exportFrontendDeployments.sh
 */
contract BindServiceCapacityEscrow is Script, ArtifactRootBase {
    function run() external {
        bindWith(Deployments.readDiamond(), vm.envUint("ADMIN_PRIVATE_KEY"));
    }

    function stage() external view {
        stageFor(Deployments.readDiamond());
    }

    function record() external {
        recordFor(Deployments.readDiamond());
    }

    // ── parameterised entries (tests drive these, not the environment) ──────

    function bindWith(address diamond, uint256 adminKey) public {
        _requireUnbound(diamond);
        address admin = vm.addr(adminKey);
        require(
            AccessControlFacet(diamond).hasRole(LibAccessControl.ADMIN_ROLE, admin),
            "BindServiceCapacityEscrow: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"
        );
        console.log("=== Service-capacity escrow (bind, direct) ===");
        console.log("Diamond:", diamond);
        vm.startBroadcast(adminKey);
        ServiceCapacityFacet(diamond).bindServiceCapacityEscrow();
        vm.stopBroadcast();
        console.log("bind submitted; once it has confirmed, run record() to publish the escrow");
    }

    function stageFor(address diamond) public view {
        _requireUnbound(diamond);
        console.log("=== Service-capacity escrow (bind, staged) ===");
        console.log("Diamond:", diamond);
        console.log("Execute against the Diamond, via the Timelock:");
        console.log("  bindServiceCapacityEscrow()  -- constructs and binds the escrow in that transaction");
        console.logBytes(abi.encodeCall(ServiceCapacityFacet.bindServiceCapacityEscrow, ()));
        console.log("Then run record() to publish it.");
    }

    function recordFor(address diamond) public returns (address escrow) {
        (escrow,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
        require(escrow != address(0), "BindServiceCapacityEscrow: no escrow is bound yet -- bind (run() or stage()) and let it confirm first");
        require(escrow.code.length != 0, "BindServiceCapacityEscrow: the reported escrow has no code");
        address recorded = Deployments.readServiceCapacityEscrowOptional();
        require(
            recorded == address(0) || recorded == escrow,
            "BindServiceCapacityEscrow: the artifact names a different escrow than the Diamond reports"
        );
        Deployments.writeServiceCapacityEscrowReconciled(escrow);
        console.log("recorded .serviceCapacityEscrow from live state:", escrow);
        console.log("next: bash script/exportFrontendDeployments.sh");
    }

    function _requireUnbound(address diamond) internal view {
        (address escrow,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
        require(
            escrow == address(0),
            "BindServiceCapacityEscrow: the escrow is already bound (binding is one-shot) -- run record() to publish it"
        );
    }
}
