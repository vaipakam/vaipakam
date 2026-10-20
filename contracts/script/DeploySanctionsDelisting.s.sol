// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SanctionsList} from "../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../src/compliance/SanctionsDelistingTimelock.sol";
import {TestnetChains} from "../src/compliance/TestnetChains.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";
import {AdminControl} from "./lib/AdminControl.sol";
import {SanctionsRecords} from "./lib/SanctionsRecords.sol";
import {SanctionsClearanceReport} from "./lib/SanctionsClearanceReport.sol";

/**
 * @title  DeploySanctionsDelisting
 * @notice Deploys the `SanctionsDelistingTimelock` for the chain's recorded
 *         `SanctionsList` on a TESTNET, appoints it a remover of that list,
 *         appoints the delister bot as its proposer, and records it.
 *
 * @dev    #2443, owner decision 2026-10-18 ("bot proposes, Safe vetoes").
 *         What this does NOT do, stated so nobody infers it:
 *         - It configures no clearance check. The rehearsal list composes no
 *           secondary, and the cross-chain clearance route needs an attestor
 *           on a chain where RedStone runs plus CCIP channel wiring on both
 *           messengers. Until one of the two exists the timelock refuses
 *           every execution (`ClearanceUnavailable`): proposals and vetoes
 *           work, delistings stay with the Safe's own direct delist. On a
 *           testnet `ConfigureSanctionsClearance` wires the cross-chain route
 *           against a labelled stand-in for RedStone (owner decision
 *           2026-10-20), as a separate, later run. The
 *           summary it prints reads the timelock's actual route
 *           (`clearanceRoute`), so a reused timelock that has since been
 *           given a source is reported as enabled, not as closed, and names
 *           the oracle only from what it reads
 *           ({SanctionsClearanceReport}): never RedStone, the stand-in only
 *           on its own answer.
 *         - It does not touch the Safe's powers: the Safe stays a remover of
 *           the list and may veto any proposal.
 *         - It refuses every mainnet, like `DeploySanctionsList`.
 *
 *         The proposer must not be the list's adder, the owner, or a remover:
 *         one key per role, so losing one never bypasses another.
 *
 *         Keys: `DEPLOYER_PRIVATE_KEY` deploys; `ADMIN_PRIVATE_KEY` owns the
 *         list and the timelock and appoints the roles. The run acts on the
 *         recorded list only while the admin alone controls it
 *         ({AdminControl}: owner, nothing pending). Address:
 *         `SANCTIONS_DELISTER_ADDRESS`. A timelock already recorded for the
 *         same list is reused while the admin alone controls it (no transfer
 *         pending); a re-run only adds a missing role. One the admin does not
 *         alone control is never left beside a replacement: while it is still
 *         a remover of the list the run refuses.
 *
 *         Run (dry, then with `--broadcast`):
 *           forge script script/DeploySanctionsDelisting.s.sol \
 *             --rpc-url "$BASE_SEPOLIA_RPC_URL" [--broadcast --slow]
 */
contract DeploySanctionsDelisting is Script, ArtifactRootBase {
    function run() external {
        runWith(vm.envAddress("SANCTIONS_DELISTER_ADDRESS"));
    }

    /// @notice {run} with the proposer given directly (the keys still come
    ///         from the environment).
    function runWith(address proposer) public {
        require(
            TestnetChains.isTestnet(block.chainid),
            "DeploySanctionsDelisting: mainnet refused - the SanctionsList adder host is undecided (#2443)"
        );
        bool writes = Deployments.artifactWritesEnabled();
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        address admin = vm.addr(adminKey);

        address listAddr = Deployments.readSanctionsListOptional();
        require(listAddr.code.length != 0, "DeploySanctionsDelisting: no SanctionsList recorded - run DeploySanctionsList first");
        SanctionsList list = SanctionsList(listAddr);
        AdminControl.requireAloneControls(listAddr, admin, "DeploySanctionsDelisting: the recorded SanctionsList");

        require(proposer != address(0), "DeploySanctionsDelisting: a proposer is required");
        require(proposer != admin, "DeploySanctionsDelisting: the proposer must not be the owner");
        require(!list.isAdder(proposer), "DeploySanctionsDelisting: the proposer must not be the list's adder");
        require(!list.isRemover(proposer), "DeploySanctionsDelisting: the proposer must not be a remover");

        (SanctionsDelistingTimelock tl, bool deployed) = _timelockFor(list, admin);

        bool needsRemover = !list.isRemover(address(tl));
        bool needsProposer = !tl.isProposer(proposer);
        if (needsRemover || needsProposer) {
            vm.startBroadcast(adminKey);
            if (needsRemover) list.setRemover(address(tl), true);
            if (needsProposer) tl.setProposer(proposer, true);
            vm.stopBroadcast();
        }
        require(list.isRemover(address(tl)) && tl.isProposer(proposer), "DeploySanctionsDelisting: roles not set");
        // Recorded last, once every step has succeeded: an artifact write
        // survives a later revert in a `--broadcast` run's simulation, which
        // would leave it naming a timelock that was never sent.
        if (writes && deployed) Deployments.writeSanctionsDelistingTimelock(address(tl));

        console.log("SanctionsDelistingTimelock:", address(tl));
        console.log("  list    :", address(list));
        console.log("  owner   :", admin);
        console.log("  proposer:", proposer);
        console.log("  delay   :", uint256(tl.delay()));
        // The timelock's actual route, read rather than assumed: a reused
        // timelock may already have a clearance source, or its list a local
        // secondary.
        SanctionsClearanceReport.logRoute(tl);
    }

    /// @dev The recorded timelock while it serves this list and the admin
    ///      alone controls it ({AdminControl.aloneControls}); otherwise a new
    ///      one, which the caller records once the run has succeeded (`deployed`
    ///      true) — but never while the recorded one is still a
    ///      remover of this list. Deploying beside it would leave two
    ///      delisting routes live, one answering to someone other than the
    ///      admin (its owner, or the pending owner once it accepts), while the
    ///      artifact and this script's output name only the new one. That
    ///      case stops the run before anything is deployed or recorded, and
    ///      the admin resolves it deliberately: cancel the transfer (the
    ///      timelock is then reused), or revoke its remover role.
    function _timelockFor(SanctionsList list, address admin)
        internal
        returns (SanctionsDelistingTimelock, bool deployed)
    {
        address recorded = Deployments.readSanctionsDelistingTimelockOptional();
        if (recorded.code.length != 0) {
            if (SanctionsRecords.serves(recorded, address(list))) {
                if (AdminControl.aloneControls(recorded, admin)) {
                    console.log("Reusing the recorded SanctionsDelistingTimelock");
                    return (SanctionsDelistingTimelock(payable(recorded)), false);
                }
                require(
                    !list.isRemover(recorded),
                    "DeploySanctionsDelisting: the recorded timelock is still a remover of this list, but the admin does not alone control it (another owner, or an ownership transfer pending) - cancel the transfer, or revoke it with setRemover(timelock, false), then re-run. Nothing was deployed or recorded"
                );
            }
            console.log("The recorded timelock serves another list, or the admin does not alone control it; deploying a new one");
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        SanctionsDelistingTimelock tl = new SanctionsDelistingTimelock(admin, list);
        vm.stopBroadcast();
        return (tl, true);
    }
}
