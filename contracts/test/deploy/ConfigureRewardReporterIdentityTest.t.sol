// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureRewardReporter} from "../../script/ConfigureRewardReporter.s.sol";
import {ArtifactRootBase, ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";

/// @dev Exposes the record-derived reward identities under a redirected root.
contract RewardIdentityHarness is ConfigureRewardReporter, ArtifactRootBase {
    function agree(string memory name, uint256 cid, address stated) external view returns (address) {
        return _agreeWithRecord(name, cid, stated);
    }

    function mirrorsFromRecords(string memory csv) external view returns (string memory) {
        return _mirrorDeploymentsFromRecords(csv);
    }
}

/// @title  ConfigureRewardReporterIdentityTest
/// @notice #3891 — on a fresh redeploy `.env` can still name the Diamonds
///         being replaced. The reward identities come from each chain's own
///         record; a stated value is accepted only when it agrees.
contract ConfigureRewardReporterIdentityTest is Test {
    RewardIdentityHarness internal h;
    string internal root;
    address internal constant BASE = address(0xBA5E);
    address internal constant ARB = address(0xA4B);

    function setUp() public {
        h = new RewardIdentityHarness();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "reward-identity");
        h.setArtifactRootOverride(root);
        vm.createDir(string.concat(root, "/base-sepolia"), true);
        vm.createDir(string.concat(root, "/arb-sepolia"), true);
        vm.writeFile(string.concat(root, "/base-sepolia/addresses.json"), string.concat('{"diamond":"', vm.toString(BASE), '"}'));
        vm.writeFile(string.concat(root, "/arb-sepolia/addresses.json"), string.concat('{"diamond":"', vm.toString(ARB), '"}'));
        if (vm.isFile(string.concat(root, "/bnb-testnet/addresses.json"))) vm.removeFile(string.concat(root, "/bnb-testnet/addresses.json"));
    }

    function test_TheRecordIsUsedWhenNothingIsStated() public view {
        assertEq(h.agree("BASE_REWARD_DEPLOYMENT", 84532, address(0)), BASE);
    }

    function test_AStatedValueThatAgreesIsAccepted() public view {
        assertEq(h.agree("BASE_REWARD_DEPLOYMENT", 84532, BASE), BASE);
    }

    function test_AStaleStatedValueIsRefused() public {
        vm.expectRevert();
        h.agree("BASE_REWARD_DEPLOYMENT", 84532, address(0x01d));
    }

    function test_WithNoRecordTheStatedValueStands() public view {
        assertEq(h.agree("MIRROR_REWARD_DEPLOYMENTS", 97, address(0xB0B)), address(0xB0B));
    }

    function test_TheMirrorRegistryComesFromTheRecords() public {
        vm.chainId(84532);
        assertEq(h.mirrorsFromRecords("84532,421614,97"), string.concat("421614:", vm.toString(ARB)));
    }
}
