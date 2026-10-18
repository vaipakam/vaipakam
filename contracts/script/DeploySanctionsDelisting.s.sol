// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SanctionsList} from "../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../src/compliance/SanctionsDelistingTimelock.sol";
import {TestnetChains} from "../src/compliance/TestnetChains.sol";
import {Deployments} from "./lib/Deployments.sol";
import {ArtifactRootBase} from "./lib/ArtifactRoot.sol";

/**
 * @title  DeploySanctionsDelisting
 * @notice Deploys the `SanctionsDelistingTimelock` for the chain's recorded
 *         `SanctionsList` on a TESTNET, appoints it a remover of that list,
 *         appoints the delister bot as its proposer, and records it.
 *
 * @dev    #2443, owner decision 2026-10-18 ("bot proposes, Safe vetoes").
 *         What this does NOT do, stated so nobody infers it:
 *         - It configures no RedStone check. The rehearsal list composes no
 *           secondary, and the cross-chain clearance route needs an attestor
 *           on a chain where RedStone runs plus CCIP channel wiring on both
 *           messengers. Until one of the two exists the timelock refuses
 *           every execution (`ClearanceUnavailable`): proposals and vetoes
 *           work, delistings stay with the Safe's own direct delist. The
 *           summary it prints reads the timelock's actual route
 *           (`clearanceRoute`), so a reused timelock that has since been
 *           given a source is reported as enabled, not as closed.
 *         - It does not touch the Safe's powers: the Safe stays a remover of
 *           the list and may veto any proposal.
 *         - It refuses every mainnet, like `DeploySanctionsList`.
 *
 *         The proposer must not be the list's adder, the owner, or a remover:
 *         one key per role, so losing one never bypasses another.
 *
 *         Keys: `DEPLOYER_PRIVATE_KEY` deploys; `ADMIN_PRIVATE_KEY` owns the
 *         list and the timelock and appoints the roles. Address:
 *         `SANCTIONS_DELISTER_ADDRESS`. A timelock already recorded for the
 *         same list and owner is reused; a re-run only adds a missing role.
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
        require(list.owner() == admin, "DeploySanctionsDelisting: the recorded SanctionsList is not owned by the admin");

        require(proposer != address(0), "DeploySanctionsDelisting: a proposer is required");
        require(proposer != admin, "DeploySanctionsDelisting: the proposer must not be the owner");
        require(!list.isAdder(proposer), "DeploySanctionsDelisting: the proposer must not be the list's adder");
        require(!list.isRemover(proposer), "DeploySanctionsDelisting: the proposer must not be a remover");

        SanctionsDelistingTimelock tl = _timelockFor(list, admin, writes);

        bool needsRemover = !list.isRemover(address(tl));
        bool needsProposer = !tl.isProposer(proposer);
        if (needsRemover || needsProposer) {
            vm.startBroadcast(adminKey);
            if (needsRemover) list.setRemover(address(tl), true);
            if (needsProposer) tl.setProposer(proposer, true);
            vm.stopBroadcast();
        }
        require(list.isRemover(address(tl)) && tl.isProposer(proposer), "DeploySanctionsDelisting: roles not set");

        console.log("SanctionsDelistingTimelock:", address(tl));
        console.log("  list    :", address(list));
        console.log("  owner   :", admin);
        console.log("  proposer:", proposer);
        console.log("  delay   :", uint256(tl.delay()));
        _logRoute(tl);
    }

    /// @dev Reports the RedStone check the timelock actually has, read from
    ///      the contract rather than assumed: a reused timelock may already
    ///      have a clearance source, or its list a local secondary.
    function _logRoute(SanctionsDelistingTimelock tl) internal view {
        SanctionsDelistingTimelock.Route route = tl.clearanceRoute();
        if (route == SanctionsDelistingTimelock.Route.Local) {
            console.log("  RedStone check: LOCAL - the list's secondary, read live:", address(tl.list().secondary()));
            console.log("    Automated delisting is ENABLED once a proposal matures and RedStone clears it.");
        } else if (route == SanctionsDelistingTimelock.Route.CrossChain) {
            console.log("  RedStone check: CROSS-CHAIN via messenger", tl.clearanceMessenger());
            console.log("    attestor", tl.clearanceAttestor(), "on chain", tl.clearanceSourceChainId());
            console.log("    Automated delisting is ENABLED once a proposal matures and the attestor clears it.");
        } else {
            console.log("  RedStone check: none configured - executions refuse until one is (ClearanceUnavailable).");
        }
    }

    /// @dev The recorded timelock while it serves this list under this owner;
    ///      otherwise a new one, recorded.
    function _timelockFor(SanctionsList list, address admin, bool writes) internal returns (SanctionsDelistingTimelock) {
        address recorded = Deployments.readSanctionsDelistingTimelockOptional();
        if (recorded.code.length != 0) {
            SanctionsDelistingTimelock existing = SanctionsDelistingTimelock(payable(recorded));
            try existing.list() returns (SanctionsList l) {
                if (address(l) == address(list) && existing.owner() == admin) {
                    console.log("Reusing the recorded SanctionsDelistingTimelock");
                    return existing;
                }
            } catch {}
            console.log("The recorded timelock serves another list or owner; deploying a new one");
        }
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        SanctionsDelistingTimelock tl = new SanctionsDelistingTimelock(admin, list);
        vm.stopBroadcast();
        if (writes) Deployments.writeSanctionsDelistingTimelock(address(tl));
        return tl;
    }
}
