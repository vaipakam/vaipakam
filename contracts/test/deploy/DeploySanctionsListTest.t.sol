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

    /// @dev A list holds the listings every consumer reads, so an unfit
    ///      recorded list is refused, never replaced by a fresh empty one —
    ///      another owner, a pending transfer, or a secondary alike. Removing
    ///      the record is the deliberate way to start a new list.
    function test_Testnet_AnUnfitRecordedList_IsRefusedNeverReplaced() public {
        DeploySanctionsList s = _script(84532, "base-sepolia-unfit");
        string memory path = string.concat(root, "/", Deployments.chainSlug(), "/addresses.json");
        string memory notControlled =
            "DeploySanctionsList: the recorded SanctionsList is not one the admin alone controls (another owner, or an ownership transfer pending). A list holds the listings every consumer reads, so this script never replaces one: cancel or complete the transfer, or remove .sanctionsList from the artifact to start a new list deliberately, then re-run. Nothing was sent or recorded";

        SanctionsList foreign = new SanctionsList(makeAddr("someoneElse"), address(0));
        vm.writeJson(vm.toString(address(foreign)), path, ".sanctionsList");
        string memory before = _artifact();
        vm.expectRevert(bytes(notControlled));
        s.run();
        assertEq(_artifact(), before, "another owner's list: nothing recorded");

        SanctionsList mine = new SanctionsList(admin, address(0));
        vm.writeJson(vm.toString(address(mine)), path, ".sanctionsList");
        vm.prank(admin);
        mine.transferOwnership(makeAddr("next owner"));
        before = _artifact();
        vm.expectRevert(bytes(notControlled));
        s.run();
        assertEq(_artifact(), before, "a pending transfer: nothing recorded");
        vm.prank(admin);
        mine.transferOwnership(address(0));
        s.run();
        assertEq(vm.parseJsonAddress(_artifact(), ".sanctionsList"), address(mine), "reused once nothing is pending");

        SanctionsList composed = new SanctionsList(admin, address(new SanctionsList(admin, address(0))));
        vm.writeJson(vm.toString(address(composed)), path, ".sanctionsList");
        vm.expectRevert(
            bytes(
                "DeploySanctionsList: the recorded SanctionsList composes a secondary oracle (or its secondary cannot be read), and the rehearsal list composes none. This script never replaces a list: remove .sanctionsList from the artifact to start a new list deliberately, then re-run. Nothing was sent or recorded"
            )
        );
        s.run();

        // The deliberate path: with the record removed, a new list is deployed.
        vm.writeJson(string.concat("{\"chainId\":", vm.toString(uint256(84532)), "}"), path);
        s.run();
        address fresh = vm.parseJsonAddress(_artifact(), ".sanctionsList");
        assertTrue(fresh != address(composed) && fresh != address(mine) && fresh != address(foreign));
        assertEq(SanctionsList(fresh).owner(), admin);
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
            vm.expectRevert(
                bytes("DeploySanctionsList: mainnet refused - the SanctionsList adder host is undecided (#2443)")
            );
            s.run();
            assertFalse(vm.keyExistsJson(_artifact(), ".sanctionsList"));
            vm.removeDir(root, true);
        }
    }
}
