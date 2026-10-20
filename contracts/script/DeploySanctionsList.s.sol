// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SanctionsList} from "../src/compliance/SanctionsList.sol";
import {ISanctionsList} from "../src/interfaces/ISanctionsList.sol";
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
 *         already recorded for the chain is reused while the admin owns it;
 *         a re-run only adds a role it is missing.
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

        SanctionsList list = _listFor(admin, writes);

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

        console.log("SanctionsList:", address(list));
        console.log("  owner  :", admin);
        console.log("  adder  :", adder);
        console.log("  remover:", remover);
        console.log("  The Diamond is NOT pointed at it; it is the adder service's rehearsal target.");
    }

    /// @dev The recorded list while the admin alone controls it
    ///      ({AdminControl.aloneControls}) and it composes no secondary;
    ///      otherwise a new one, recorded.
    function _listFor(address admin, bool writes) internal returns (SanctionsList) {
        address recorded = Deployments.readSanctionsListOptional();
        if (recorded.code.length != 0) {
            SanctionsList existing = SanctionsList(recorded);
            if (AdminControl.aloneControls(recorded, admin)) {
                try existing.secondary() returns (ISanctionsList secondary) {
                    if (address(secondary) == address(0)) {
                        console.log("Reusing the recorded SanctionsList");
                        return existing;
                    }
                } catch {}
            }
            console.log("The recorded SanctionsList is not one the admin alone controls with no secondary; deploying a new one");
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        SanctionsList list = new SanctionsList(admin, address(0));
        vm.stopBroadcast();
        if (writes) Deployments.writeSanctionsList(address(list));
        return list;
    }
}
