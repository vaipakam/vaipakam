// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeploySanctionsList} from "../../script/DeploySanctionsList.s.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";
import {SanctionsList} from "../../src/compliance/SanctionsList.sol";

/**
 * @title  DeploySanctionsListTest
 * @notice #2443 — what `DeploySanctionsList` deploys and records: on a
 *         testnet, the admin's own list with no secondary, its adder and
 *         remover appointed and kept apart, reused on a re-run; on a mainnet,
 *         a refusal.
 */
contract DeploySanctionsListTest is Test {
    uint256 internal adminKey = 0xA11CE;
    uint256 internal deployerKey = 0xDE9;
    address internal admin;
    address internal adder = makeAddr("adder");
    address internal remover = makeAddr("remover");
    string internal root;

    function setUp() public {
        admin = vm.addr(adminKey);
        vm.setEnv("ADMIN_PRIVATE_KEY", vm.toString(adminKey));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(deployerKey));
        vm.setEnv("SANCTIONS_ADDER_ADDRESS", vm.toString(adder));
        vm.setEnv("SANCTIONS_REMOVER_ADDRESS", vm.toString(remover));
    }

    function _script(uint256 chainId, string memory name) internal returns (DeploySanctionsList s) {
        vm.chainId(chainId);
        s = new DeploySanctionsList();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "deploy-sanctions-list-", name);
        s.setArtifactRootOverride(root);
        string memory dir = string.concat(root, "/", Deployments.chainSlug());
        vm.createDir(dir, true);
        vm.writeJson(string.concat("{\"chainId\":", vm.toString(chainId), "}"), string.concat(dir, "/addresses.json"));
    }

    function _artifact() internal view returns (string memory) {
        return vm.readFile(string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"));
    }

    function test_Testnet_DeploysAppointsAndRecords() public {
        DeploySanctionsList s = _script(84532, "base-sepolia");
        s.run();
        SanctionsList list = SanctionsList(vm.parseJsonAddress(_artifact(), ".sanctionsList"));
        assertTrue(address(list).code.length != 0, "deployed and recorded");
        assertEq(list.owner(), admin, "owned by the admin");
        assertEq(address(list.secondary()), address(0), "no secondary on the rehearsal list");
        assertTrue(list.isAdder(adder));
        assertTrue(list.isRemover(remover));
        assertFalse(list.isRemover(adder), "the adder cannot delist");
        assertFalse(vm.keyExistsJson(_artifact(), ".sanctions"), "the Diamond's screen is not recorded as changed");
        vm.removeDir(root, true);
    }

    function test_Testnet_SecondRun_ReusesTheRecordedList() public {
        DeploySanctionsList s = _script(84532, "base-sepolia-rerun");
        s.run();
        address first = vm.parseJsonAddress(_artifact(), ".sanctionsList");
        s.run();
        assertEq(vm.parseJsonAddress(_artifact(), ".sanctionsList"), first, "reused, not redeployed");
        vm.removeDir(root, true);
    }

    function test_Testnet_RecordedListOwnedByAnother_IsReplaced() public {
        DeploySanctionsList s = _script(84532, "base-sepolia-foreign");
        SanctionsList foreign = new SanctionsList(makeAddr("someoneElse"), address(0));
        vm.writeJson(vm.toString(address(foreign)), string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"), ".sanctionsList");
        s.run();
        address now_ = vm.parseJsonAddress(_artifact(), ".sanctionsList");
        assertTrue(now_ != address(foreign), "a list the admin does not own is not reused");
        assertEq(SanctionsList(now_).owner(), admin);
        vm.removeDir(root, true);
    }

    function test_Testnet_RefusesSharedOrOwnerKeys() public {
        DeploySanctionsList s = _script(84532, "base-sepolia-keys");
        // Given directly, not through the environment, which every test in
        // this suite shares while they run in parallel.
        vm.expectRevert(bytes("DeploySanctionsList: the adder and the remover must be different keys"));
        s.runWith(adder, adder);
        vm.expectRevert(bytes("DeploySanctionsList: the adder must not be the owner"));
        s.runWith(admin, remover);
        vm.removeDir(root, true);
    }

    function test_Mainnet_IsRefused() public {
        uint256[6] memory mainnets = [uint256(1), 8453, 42161, 10, 137, 56];
        for (uint256 i; i < mainnets.length; ++i) {
            DeploySanctionsList s = _script(mainnets[i], string.concat("mainnet-", vm.toString(mainnets[i])));
            vm.expectRevert(bytes("DeploySanctionsList: mainnet refused - the SanctionsList adder host is undecided (#2443)"));
            s.run();
            assertFalse(vm.keyExistsJson(_artifact(), ".sanctionsList"));
            vm.removeDir(root, true);
        }
    }
}
