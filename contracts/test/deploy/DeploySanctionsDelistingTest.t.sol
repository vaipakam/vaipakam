// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeploySanctionsDelisting} from "../../script/DeploySanctionsDelisting.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";
import {SanctionsDelistingTimelock} from "../../src/compliance/SanctionsDelistingTimelock.sol";

/**
 * @title  DeploySanctionsDelistingTest
 * @notice #2443 — what `DeploySanctionsDelisting` deploys and records: on a
 *         testnet, a timelock for the recorded list, appointed remover, with
 *         the delister as proposer and kept apart from every other role,
 *         reused on a re-run; with no list recorded, or on a mainnet, a
 *         refusal.
 */
contract DeploySanctionsDelistingTest is Test {
    uint256 internal adminKey = 0xA11CE;
    uint256 internal deployerKey = 0xDE9;
    address internal admin;
    address internal adder = makeAddr("adder");
    address internal safe = makeAddr("safe");
    address internal delister = makeAddr("delister");
    string internal root;

    function setUp() public {
        admin = vm.addr(adminKey);
        vm.setEnv("ADMIN_PRIVATE_KEY", vm.toString(adminKey));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
    }

    function _script(uint256 chainId, string memory name, bool withList)
        internal
        returns (DeploySanctionsDelisting s, SanctionsList list)
    {
        vm.chainId(chainId);
        s = new DeploySanctionsDelisting();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "deploy-sanctions-delisting-", name);
        s.setArtifactRootOverride(root);
        string memory dir = string.concat(root, "/", Deployments.chainSlug());
        vm.createDir(dir, true);
        string memory path = string.concat(dir, "/addresses.json");
        vm.writeJson(string.concat("{\"chainId\":", vm.toString(chainId), "}"), path);
        if (withList) {
            list = new SanctionsList(admin, address(0));
            vm.startPrank(admin);
            list.setAdder(adder, true);
            list.setRemover(safe, true);
            vm.stopPrank();
            vm.writeJson(vm.toString(address(list)), path, ".sanctionsList");
        }
    }

    function _artifact() internal view returns (string memory) {
        return vm.readFile(string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"));
    }

    function test_Testnet_DeploysAppointsAndRecords() public {
        (DeploySanctionsDelisting s, SanctionsList list) = _script(84532, "base-sepolia", true);
        s.runWith(delister);
        SanctionsDelistingTimelock tl =
            SanctionsDelistingTimelock(vm.parseJsonAddress(_artifact(), ".sanctionsDelistingTimelock"));
        assertEq(address(tl.list()), address(list));
        assertEq(tl.owner(), admin);
        assertTrue(list.isRemover(address(tl)), "appointed remover");
        assertTrue(list.isRemover(safe), "the Safe keeps its direct delist");
        assertTrue(tl.isProposer(delister));
        assertEq(tl.clearanceMessenger(), address(0), "no RedStone check configured by the script");

        // A re-run reuses it.
        s.runWith(delister);
        assertEq(vm.parseJsonAddress(_artifact(), ".sanctionsDelistingTimelock"), address(tl));
        vm.removeDir(root, true);
    }

    function test_Testnet_RefusesSharedKeysAndAMissingList() public {
        (DeploySanctionsDelisting s,) = _script(84532, "base-sepolia-keys", true);
        vm.expectRevert(bytes("DeploySanctionsDelisting: the proposer must not be the owner"));
        s.runWith(admin);
        vm.expectRevert(bytes("DeploySanctionsDelisting: the proposer must not be the list's adder"));
        s.runWith(adder);
        vm.expectRevert(bytes("DeploySanctionsDelisting: the proposer must not be a remover"));
        s.runWith(safe);
        vm.removeDir(root, true);

        (s,) = _script(84532, "base-sepolia-nolist", false);
        vm.expectRevert(bytes("DeploySanctionsDelisting: no SanctionsList recorded - run DeploySanctionsList first"));
        s.runWith(delister);
        vm.removeDir(root, true);
    }

    function test_Mainnet_IsRefused() public {
        (DeploySanctionsDelisting s,) = _script(8453, "mainnet-base", true);
        vm.expectRevert(bytes("DeploySanctionsDelisting: mainnet refused - the SanctionsList adder host is undecided (#2443)"));
        s.runWith(delister);
        assertFalse(vm.keyExistsJson(_artifact(), ".sanctionsDelistingTimelock"));
        vm.removeDir(root, true);
    }
}
