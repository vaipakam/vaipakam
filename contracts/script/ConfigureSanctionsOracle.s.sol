// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC173} from "@diamond-3/interfaces/IERC173.sol";
import {ProfileFacet} from "../src/facets/ProfileFacet.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
import {TestnetChains} from "../src/compliance/TestnetChains.sol";
import {TestnetSanctionsOverlay} from "../src/compliance/TestnetSanctionsOverlay.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";

/**
 * @title  ConfigureSanctionsOracle
 * @notice Points a Diamond's sanctions screen at the right oracle for its
 *         chain, and records what it set in the chain's deployment artifact.
 *
 * @dev    #2439, and the setter half of #946 (which also asks for a deploy
 *         phase and a verify-time assertion; those remain open there).
 *
 *         - **Mainnet**: REFUSED. The on-chain source this script was written
 *           for, Chainalysis's Sanctions Oracle, was retired by Chainalysis:
 *           its documentation says it is no longer supported or maintained,
 *           last updated 2026-03-18, and not recommended for production
 *           screening. Its contracts still answer every read, so nothing
 *           on-chain shows the list is frozen, and installing it would present
 *           a list that no longer grows as live screening. Which supported
 *           source a mainnet uses is an open decision (#2443); this script
 *           will not make it by default.
 *         - **Testnet** (`TestnetChains`): a `TestnetSanctionsOverlay` with no
 *           upstream — the network admin's test list, the whole screen. An
 *           overlay already recorded for the chain is reused while it is still
 *           fit (see {_reusable}).
 *
 *         Keys: `DEPLOYER_PRIVATE_KEY` deploys an overlay; `ADMIN_PRIVATE_KEY`
 *         must be the Diamond's owner to set the oracle. On a Diamond owned
 *         by a timelock the run deploys and records any overlay it needs,
 *         leaves the oracle unchanged, and prints the call to schedule;
 *         re-run after the timelock executes it to record the result.
 *
 *         Artifact writes follow `Deployments.artifactWritesEnabled()`, like
 *         every deploy step: a dry run writes nothing, and
 *         `DEPLOY_SKIP_ARTIFACTS` is honoured locally and refused live.
 *
 *         Run (dry, then with `--broadcast`):
 *           forge script script/ConfigureSanctionsOracle.s.sol \
 *             --rpc-url "$BASE_SEPOLIA_RPC_URL" [--broadcast --slow]
 */
contract ConfigureSanctionsOracle is Script, ArtifactRootBase {
    string internal constant KIND_TESTNET_OVERLAY = "testnet-overlay";

    function run() external {
        // A mainnet is refused before anything else is read or collected.
        require(
            TestnetChains.isTestnet(block.chainid),
            "ConfigureSanctionsOracle: no supported on-chain sanctions source for a mainnet (Chainalysis retired its oracle on 2026-03-18; see #2443)"
        );
        // Resolved next: on a live broadcast carrying `DEPLOY_SKIP_ARTIFACTS`
        // it reverts here, before any transaction is collected.
        bool writes = Deployments.artifactWritesEnabled();
        address diamond = Deployments.readDiamond();
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address owner = IERC173(diamond).owner();

        address current = ProfileFacet(diamond).getSanctionsOracle();
        address target = _overlayFor(current, admin, writes);

        if (current != target) {
            if (owner != admin) {
                // NOT a revert. `target` may be an overlay this run just
                // deployed, and Forge executes the whole script to collect its
                // transactions before broadcasting: reverting here would
                // discard that deployment, leaving the printed call pointing at
                // an address with no code. So the run completes, the overlay
                // is deployed and recorded, and the oracle is reported as NOT
                // configured: the configured-oracle record is written only
                // once the Diamond reports `target`.
                console.log("NOT CONFIGURED: the Diamond owner is not the ADMIN key (timelock?).");
                console.log("  owner  :", owner);
                console.log("  Schedule through it, then re-run this script to record:");
                console.log("  target :", diamond);
                console.log("  call   : setSanctionsOracle(address)", target);
                return;
            }
            vm.startBroadcast(adminKey);
            ProfileFacet(diamond).setSanctionsOracle(target);
            vm.stopBroadcast();
        }

        _verify(diamond, target, admin);

        // One object, replaced whole: no field from an earlier configuration
        // can outlive it (Codex #2442 r3).
        if (writes) Deployments.writeSanctionsRecord(target, KIND_TESTNET_OVERLAY);

        console.log("Sanctions oracle configured:", target);
        console.log("  kind    :", KIND_TESTNET_OVERLAY);
        console.log("  previous:", current);
    }

    /// @dev The overlay to configure, in order of preference:
    ///      1. the one the Diamond ALREADY screens against, when it is fit to
    ///         reuse (see {_reusable}) — its flags are the live screen, so
    ///         replacing it would silently delist every wallet it flags. The
    ///         record is backfilled to it if missing or stale (a manual setup,
    ///         a restored artifact);
    ///      2. the recorded overlay, when it is fit to reuse;
    ///      3. a fresh one, owned by the chain's admin and recorded under
    ///         `.sanctionsTestnetOverlay` as soon as it is deployed — a separate
    ///         fact from which oracle the Diamond is configured with, so a run
    ///         that cannot configure (a timelock owner) still lets the next run
    ///         reuse the overlay instead of deploying another.
    function _overlayFor(address current, address admin, bool writes) internal returns (address) {
        address recorded = Deployments.readSanctionsTestnetOverlayOptional();
        if (current != address(0) && current.code.length != 0) {
            if (_reusable(TestnetSanctionsOverlay(current), admin)) {
                console.log("Keeping the overlay the Diamond already screens against:", current);
                if (writes && recorded != current) Deployments.writeSanctionsTestnetOverlay(current);
                return current;
            }
        }
        if (recorded != address(0) && recorded.code.length != 0) {
            if (_reusable(TestnetSanctionsOverlay(recorded), admin)) {
                console.log("Reusing the recorded overlay:", recorded);
                return recorded;
            }
            console.log("Recorded overlay not reusable (upstream, owner or pending owner differs):", recorded);
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        TestnetSanctionsOverlay overlay = new TestnetSanctionsOverlay(admin, address(0));
        vm.stopBroadcast();
        console.log("Deployed TestnetSanctionsOverlay:", address(overlay));
        if (writes) Deployments.writeSanctionsTestnetOverlay(address(overlay));
        return address(overlay);
    }

    /// @dev True iff `overlay` has no upstream (so it is the whole screen, not
    ///      a layer over a list this script no longer configures), is owned by
    ///      `admin`, and has no pending ownership transfer — the owner decides
    ///      who is flagged, so an overlay anyone else controls or is about to
    ///      control is never configured. Any read that fails — not an overlay
    ///      at all — is a no.
    function _reusable(TestnetSanctionsOverlay overlay, address admin) internal view returns (bool) {
        try overlay.upstream() returns (ISanctionsList up) {
            if (address(up) != address(0)) return false;
        } catch {
            return false;
        }
        try overlay.owner() returns (address o) {
            if (o != admin) return false;
        } catch {
            return false;
        }
        try overlay.pendingOwner() returns (address pending) {
            return pending == address(0);
        } catch {
            return false;
        }
    }

    /// @dev The Diamond now routes to `target`, and both the oracle and the
    ///      Diamond's own screen answer a read.
    function _verify(address diamond, address target, address admin) internal view {
        require(
            ProfileFacet(diamond).getSanctionsOracle() == target,
            "ConfigureSanctionsOracle: the Diamond does not report the configured oracle"
        );
        ISanctionsList(target).isSanctioned(admin);
        ProfileFacet(diamond).isSanctionedAddress(admin);
    }
}
