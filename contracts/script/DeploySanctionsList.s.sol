// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SanctionsList} from "../src/compliance/SanctionsList.sol";
import {TestnetChains} from "../src/compliance/TestnetChains.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";
import {AdminControl} from "./lib/AdminControl.sol";

/**
 * @title  DeploySanctionsList
 * @notice Deploys Vaipakam's own `SanctionsList` on a TESTNET, appoints its
 *         adder and remover, and records it in the chain's artifact — the
 *         target the sanctions adder service rehearses against
 *         (ops/sanctions/).
 *
 * @dev    #2443. What this does NOT do, stated so nobody infers it:
 *         - It never points the Diamond at the list. On a testnet the Diamond
 *           screens against the admin's `TestnetSanctionsOverlay`
 *           (`ConfigureSanctionsOracle`); this list runs beside it so the
 *           adder can be exercised against real OFAC data without changing
 *           what any user sees.
 *         - It composes no secondary oracle: RedStone's adoption waits on its
 *           terms (#2443), so the rehearsal list is the own record alone.
 *         - It refuses every mainnet: the mainnet adder host is not decided.
 *
 *         Roles follow the owner decision of 2026-10-18 ("Bot adds, Safe
 *         removes"): the ADDER (the service's key) may only list or record a
 *         publication, the REMOVER alone may delist. The two must differ, and
 *         the adder must not be the owner — an owner key on the service host
 *         would let that host appoint itself remover.
 *
 *         Keys: `DEPLOYER_PRIVATE_KEY` deploys; `ADMIN_PRIVATE_KEY` is the
 *         list's owner and appoints the roles. Addresses:
 *         `SANCTIONS_ADDER_ADDRESS`, `SANCTIONS_REMOVER_ADDRESS`. A list
 *         already recorded for the chain is reused while the admin alone
 *         controls it (owner, no transfer pending) and it composes no
 *         secondary; a re-run only adds a role it is missing. Any other
 *         recorded list is refused, never replaced: its listings and the
 *         roles attached to it are state a replacement would fork (see
 *         {_listFor}). Nor is a new list started while the artifact still
 *         records a delisting timelock, which is bound to another list.
 *
 *         Artifact writes follow `Deployments.artifactWritesEnabled()`.
 *
 *         Run (dry, then with `--broadcast`):
 *           forge script script/DeploySanctionsList.s.sol \
 *             --rpc-url "$BASE_SEPOLIA_RPC_URL" [--broadcast --slow]
 */
contract DeploySanctionsList is Script, ArtifactRootBase {
    function run() external {
        runWith(vm.envAddress("SANCTIONS_ADDER_ADDRESS"), vm.envAddress("SANCTIONS_REMOVER_ADDRESS"));
    }

    /// @notice {run} with the two role holders given directly (the keys still
    ///         come from the environment).
    function runWith(address adder, address remover) public {
        require(
            TestnetChains.isTestnet(block.chainid),
            "DeploySanctionsList: mainnet refused - the SanctionsList adder host is undecided (#2443)"
        );
        bool writes = Deployments.artifactWritesEnabled();
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);
        require(adder != address(0) && remover != address(0), "DeploySanctionsList: adder and remover are required");
        require(adder != remover, "DeploySanctionsList: the adder and the remover must be different keys");
        require(adder != admin, "DeploySanctionsList: the adder must not be the owner");

        (SanctionsList list, bool deployed) = _listFor(admin);

        bool needsAdder = !list.isAdder(adder);
        bool needsRemover = !list.isRemover(remover);
        if (needsAdder || needsRemover) {
            vm.startBroadcast(adminKey);
            if (needsAdder) list.setAdder(adder, true);
            if (needsRemover) list.setRemover(remover, true);
            vm.stopBroadcast();
        }
        require(list.isAdder(adder) && list.isRemover(remover), "DeploySanctionsList: roles not set");
        require(!list.isRemover(adder), "DeploySanctionsList: the adder is also a remover - remove that role first");
        // Recorded last, once every step has succeeded: an artifact write
        // survives a later revert in a `--broadcast` run's simulation, which
        // would leave it naming a list that was never sent.
        if (writes && deployed) Deployments.writeSanctionsList(address(list));

        console.log("SanctionsList:", address(list));
        console.log("  owner  :", admin);
        console.log("  adder  :", adder);
        console.log("  remover:", remover);
        console.log("  The Diamond is NOT pointed at it; it is the adder service's rehearsal target.");
    }

    /// @dev The recorded list, which must be one the admin alone controls
    ///      ({AdminControl.aloneControls}) composing no secondary; a new one
    ///      (`deployed`, recorded by the caller once the run has succeeded)
    ///      only when no list is recorded, or the record names an address
    ///      with no code on this chain.
    ///
    ///      A recorded list that fails either test is REFUSED, never
    ///      replaced. A list holds the listings every consumer reads, and its
    ///      adder, removers and timelock stay attached to it: a fresh, empty
    ///      replacement would fork that state (the services follow the
    ///      record, the timelock stays bound to the old list) and silently
    ///      drop every listing for anyone reading the record. Starting a new
    ///      list is the operator's deliberate act: resolve the transfer, or
    ///      remove `.sanctionsList` from the artifact, together with the
    ///      `.sanctionsDelistingTimelock` that serves it, and re-run.
    ///
    ///      A new list is also never started while a timelock is still
    ///      recorded. A timelock is bound to its list for good, so it serves
    ///      another list, and recording a new list beside it would pair the
    ///      two in the artifact ({SanctionsRecords}): the clearance wiring and
    ///      the delister would then act on a set-up the new list does not use.
    function _listFor(address admin) internal returns (SanctionsList, bool deployed) {
        address recorded = Deployments.readSanctionsListOptional();
        if (recorded.code.length != 0) {
            require(
                AdminControl.aloneControls(recorded, admin),
                "DeploySanctionsList: the recorded SanctionsList is not one the admin alone controls (another owner, or an ownership transfer pending). A list holds the listings every consumer reads, so this script never replaces one: cancel or complete the transfer, or remove .sanctionsList and the .sanctionsDelistingTimelock that serves it from the artifact to start a new list deliberately, then re-run. Nothing was sent or recorded"
            );
            // A total read: any answer but one zero word (a secondary, a
            // revert, a malformed reply) is "not the rehearsal list".
            (bool ok, bytes memory ret) =
                recorded.staticcall(abi.encodeWithSelector(SanctionsList.secondary.selector));
            require(
                ok && ret.length == 32 && abi.decode(ret, (uint256)) == 0,
                "DeploySanctionsList: the recorded SanctionsList composes a secondary oracle (or its secondary cannot be read), and the rehearsal list composes none. This script never replaces a list: remove .sanctionsList and the .sanctionsDelistingTimelock that serves it from the artifact to start a new list deliberately, then re-run. Nothing was sent or recorded"
            );
            console.log("Reusing the recorded SanctionsList");
            return (SanctionsList(recorded), false);
        }
        require(
            Deployments.readSanctionsDelistingTimelockOptional() == address(0),
            "DeploySanctionsList: the artifact records a sanctionsDelistingTimelock but no list this script can reuse. A timelock is bound to its list for good, so a new list recorded beside it would be paired with another list's timelock: remove .sanctionsDelistingTimelock as well (it stays with its own list), then re-run. Nothing was sent or recorded"
        );
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        SanctionsList list = new SanctionsList(admin, address(0));
        vm.stopBroadcast();
        return (list, true);
    }
}
