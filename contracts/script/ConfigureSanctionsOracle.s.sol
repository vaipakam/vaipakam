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
import {AdminControl} from "./lib/AdminControl.sol";
import {TotalRead} from "./lib/TotalRead.sol";

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
 *           a list that no longer grows as live screening. The mainnet source
 *           is now decided (#2443, 2026-10-17): Vaipakam's own `SanctionsList`,
 *           OR-composed with RedStone's Sanctions Oracle where deployed.
 *           The signers are decided (2026-10-18: an automated adder lists,
 *           the multisig alone delists); configuring it still waits on where
 *           the adder runs — a mainnet pointed at a list nobody
 *           keeps current would be the frozen list again under a new address
 *           — so this script still refuses every mainnet, and it never
 *           configures Chainalysis's oracle.
 *         - **Testnet** (`TestnetChains`): a `TestnetSanctionsOverlay` with no
 *           upstream — the network admin's test list, the whole screen. The
 *           oracle the Diamond already screens against is kept while it is
 *           fit (see {_reusable}) and otherwise REFUSED, never replaced: its
 *           flags are the live screen and live only in it. With no live
 *           oracle, an overlay already recorded for the chain is reused while
 *           it is fit, and a fresh one is deployed otherwise (see
 *           {_overlayFor}).
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
            "ConfigureSanctionsOracle: mainnet refused - the SanctionsList adder host is undecided (#2443); Chainalysis's retired oracle is never configured"
        );
        // Resolved next: on a live broadcast carrying `DEPLOY_SKIP_ARTIFACTS`
        // it reverts here, before any transaction is collected.
        bool writes = Deployments.artifactWritesEnabled();
        address diamond = Deployments.readDiamond();
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        address owner = IERC173(diamond).owner();

        address current = ProfileFacet(diamond).getSanctionsOracle();
        (address target, bool recordOverlay) = _overlayFor(current, admin);

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
                if (writes && recordOverlay) Deployments.writeSanctionsTestnetOverlay(target);
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

        // Recorded last, once every step has succeeded: an artifact write
        // survives a later revert in a `--broadcast` run's simulation, which
        // would leave it naming an overlay that was never sent.
        if (writes && recordOverlay) Deployments.writeSanctionsTestnetOverlay(target);
        // One object, replaced whole: no field from an earlier configuration
        // can outlive it (Codex #2442 r3).
        if (writes) Deployments.writeSanctionsRecord(target, KIND_TESTNET_OVERLAY);

        console.log("Sanctions oracle configured:", target);
        console.log("  kind    :", KIND_TESTNET_OVERLAY);
        console.log("  previous:", current);
    }

    /// @dev The overlay to configure:
    ///      1. whenever the Diamond ALREADY screens against an oracle (one
    ///         with code), that one or nothing. Its flags are the live screen
    ///         and live only in it, so replacing it would silently delist
    ///         every wallet it flags. When it is fit to reuse (see
    ///         {_reusable}) it is kept and the record is backfilled to it if
    ///         missing or stale (a manual setup, a restored artifact); when it
    ///         is not — another owner, a transfer pending, an upstream, not an
    ///         overlay at all — the run is REFUSED, never replaced. Dropping
    ///         the live screen is the operator's deliberate act: resolve the
    ///         transfer, or re-point the Diamond with `setSanctionsOracle`,
    ///         then re-run. (The same rule as `DeploySanctionsList`: a
    ///         contract whose state consumers read is never replaced by a
    ///         script.)
    ///      Otherwise (no oracle set, or one with no code, which holds no
    ///      flags and answers no screen):
    ///      2. the recorded overlay, when it is fit to reuse — it is not the
    ///         live screen, so an unfit one keeps no role and a fresh one
    ///         replaces it;
    ///      3. a fresh one, owned by the chain's admin.
    ///      `recordOverlay` says the `.sanctionsTestnetOverlay` record must be
    ///      written (a fresh overlay, or a backfill), which the caller does at
    ///      the END of the run — a separate fact from which oracle the Diamond
    ///      is configured with, so a run that cannot configure (a timelock
    ///      owner) still records it and lets the next run reuse the overlay
    ///      instead of deploying another.
    function _overlayFor(address current, address admin) internal returns (address, bool recordOverlay) {
        address recorded = Deployments.readSanctionsTestnetOverlayOptional();
        if (current.code.length != 0) {
            require(
                _reusable(current, admin),
                string.concat(
                    "ConfigureSanctionsOracle: the Diamond screens against ",
                    vm.toString(current),
                    ", which is not an overlay with no upstream that the admin alone controls (another owner, a transfer pending, an upstream, or not an overlay). Its flags are the live screen and do not carry over, so this script never replaces it: cancel or complete the transfer, or re-point the Diamond yourself with setSanctionsOracle, then re-run. Nothing was sent or recorded"
                )
            );
            console.log("Keeping the overlay the Diamond already screens against:", current);
            return (current, recorded != current);
        }
        if (recorded != address(0) && recorded.code.length != 0) {
            if (_reusable(recorded, admin)) {
                console.log("Reusing the recorded overlay:", recorded);
                return (recorded, false);
            }
            console.log("Recorded overlay not reusable (upstream, owner or pending owner differs):", recorded);
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        TestnetSanctionsOverlay overlay = new TestnetSanctionsOverlay(admin, address(0));
        vm.stopBroadcast();
        console.log("Deployed TestnetSanctionsOverlay:", address(overlay));
        return (address(overlay), true);
    }

    /// @dev True iff `overlay` has no upstream (so it is the whole screen, not
    ///      a layer over a list this script no longer configures) and `admin`
    ///      alone controls it ({AdminControl.aloneControls}: owner, nothing
    ///      pending) — the owner decides who is flagged, so an overlay anyone
    ///      else controls or is about to control is never configured. Every
    ///      read is a {TotalRead}: any that fails — not an overlay at all, a
    ///      malformed answer — is a no.
    function _reusable(address overlay, address admin) internal view returns (bool) {
        (bool read, address up) = TotalRead.addressOf(overlay, TestnetSanctionsOverlay.upstream.selector);
        return read && up == address(0) && AdminControl.aloneControls(overlay, admin);
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
