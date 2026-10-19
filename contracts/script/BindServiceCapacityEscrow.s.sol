// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";
import {ServiceCapacityFacet} from "../src/facets/ServiceCapacityFacet.sol";
import {AccessControlFacet} from "../src/facets/AccessControlFacet.sol";
import {LibAccessControl} from "../src/libraries/LibAccessControl.sol";
import {RewardCustodyHolder} from "../src/RewardCustodyHolder.sol";

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
 *         only, and is idempotent. It follows the reward-custody ceremony's
 *         non-broadcast write policy ({_nonBroadcastWritesEnabled}): no write
 *         under `forge test` or with `DEPLOY_SKIP_ARTIFACTS` unless the
 *         artifact is redirected to a scratch root (Codex #2585 r2). Binding
 *         and staging refuse when the artifact names an escrow that the
 *         Diamond does not have bound, so a stale artifact is found BEFORE the
 *         one-shot bind changes live state, never after (r2).
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
        _requireArtifactDiamond(diamond);
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
        _requireArtifactDiamond(diamond);
        _requireUnbound(diamond);
        console.log("=== Service-capacity escrow (bind, staged) ===");
        console.log("Diamond:", diamond);
        console.log("Execute against the Diamond, via the Timelock:");
        console.log("  bindServiceCapacityEscrow()  -- constructs and binds the escrow in that transaction");
        console.logBytes(abi.encodeCall(ServiceCapacityFacet.bindServiceCapacityEscrow, ()));
        console.log("Then run record() to publish it.");
    }

    function recordFor(address diamond) public returns (address escrow) {
        _requireArtifactDiamond(diamond);
        (escrow,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
        require(escrow != address(0), "BindServiceCapacityEscrow: no escrow is bound yet -- bind (run() or stage()) and let it confirm first");
        require(escrow.code.length != 0, "BindServiceCapacityEscrow: the reported escrow has no code");
        require(
            RewardCustodyHolder(escrow).DIAMOND() == diamond,
            "BindServiceCapacityEscrow: the reported escrow does not answer to this Diamond"
        );
        address recorded = Deployments.readServiceCapacityEscrowOptional();
        require(
            recorded == address(0) || recorded == escrow,
            "BindServiceCapacityEscrow: the artifact names a different escrow than the Diamond reports"
        );
        if (!_nonBroadcastWritesEnabled()) {
            console.log("writes are off for this run (forge test / DEPLOY_SKIP_ARTIFACTS) -- .serviceCapacityEscrow NOT written");
            return escrow;
        }
        Deployments.writeServiceCapacityEscrowReconciled(escrow);
        console.log("recorded .serviceCapacityEscrow from live state:", escrow);
        console.log("next: bash script/exportFrontendDeployments.sh");
    }

    /// @dev Every entry acts on the ARTIFACT's Diamond only (Codex #2585 r4): the
    ///      parameterised entries are public, so without this a wrong address
    ///      could have its holder published into this chain's canonical artifact.
    function _requireArtifactDiamond(address diamond) internal view {
        require(
            diamond == Deployments.readDiamond(),
            "BindServiceCapacityEscrow: the Diamond is not this chain's deployment artifact Diamond"
        );
    }

    /// @dev Before a bind or a stage: the Diamond has no escrow bound AND the
    ///      artifact names none. An artifact that names one while the Diamond
    ///      has none is stale, and binding past it would leave a fresh holder
    ///      that record() then refuses to publish.
    function _requireUnbound(address diamond) internal view {
        (address escrow,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
        require(
            escrow == address(0),
            "BindServiceCapacityEscrow: the escrow is already bound (binding is one-shot) -- run record() to publish it"
        );
        require(
            Deployments.readServiceCapacityEscrowOptional() == address(0),
            "BindServiceCapacityEscrow: the artifact names an escrow but the Diamond has none bound -- reconcile the artifact before binding"
        );
    }

    /// @dev The reward-custody ceremony's non-broadcast write policy
    ///      (`RewardCustodyCeremonyBase._nonBroadcastWritesEnabled`), plus the
    ///      one case that is always safe: a REDIRECTED artifact, which lives under
    ///      the scratch prefix and can never be a committed file.
    function _nonBroadcastWritesEnabled() internal view returns (bool) {
        if (Deployments.artifactIsRedirected()) return true;
        if (vm.isContext(VmSafe.ForgeContext.TestGroup)) return false;
        return !vm.envOr("DEPLOY_SKIP_ARTIFACTS", false);
    }
}
