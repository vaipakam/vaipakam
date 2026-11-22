// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {ConfigureRewardReporter} from "../../script/ConfigureRewardReporter.s.sol";
import {ArtifactRootBase, ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";

/// @dev Answers the two identity reads the configure readback makes.
contract IdentityReadStub {
    address public base;
    mapping(uint32 => address) public mirror;

    function set(address b, uint32 id, address m) external {
        base = b;
        mirror[id] = m;
    }

    function getBaseRewardDeployment() external view returns (address) {
        return base;
    }

    function getMirrorRewardDeployment(uint32 id) external view returns (address) {
        return mirror[id];
    }
}

/// @dev Exposes the record-derived reward identities under a redirected root.
contract RewardIdentityHarness is ConfigureRewardReporter, ArtifactRootBase {
    function agree(string memory name, uint256 cid, address stated) external view returns (address) {
        return _agreeWithRecord(name, cid, stated);
    }

    function mirrorsFromRecords(string memory csv) external view returns (string memory) {
        return _mirrorDeploymentsFromRecords(csv);
    }

    function verify(uint256 baseChainId, string memory csv) external view {
        _verifyIdentities(baseChainId, csv);
    }

    function samePairs(string memory a, string memory b) external pure {
        _requireSamePairs(a, b);
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

    /// @dev One root per test, named for it: tests run in parallel over one
    ///      filesystem, so a shared root lets one test's records leak into another.
    function _init(string memory name) internal {
        h = new RewardIdentityHarness();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "reward-identity/", name);
        h.setArtifactRootOverride(root);
        vm.createDir(string.concat(root, "/base-sepolia"), true);
        vm.createDir(string.concat(root, "/arb-sepolia"), true);
        vm.writeFile(string.concat(root, "/base-sepolia/addresses.json"), string.concat('{"diamond":"', vm.toString(BASE), '"}'));
        vm.writeFile(string.concat(root, "/arb-sepolia/addresses.json"), string.concat('{"diamond":"', vm.toString(ARB), '"}'));
        if (vm.isFile(string.concat(root, "/bnb-testnet/addresses.json"))) vm.removeFile(string.concat(root, "/bnb-testnet/addresses.json"));
    }

    function test_TheRecordIsUsedWhenNothingIsStated() public {
        _init("TheRecordIsUsedWhenNothingIsStated");
        assertEq(h.agree("BASE_REWARD_DEPLOYMENT", 84532, address(0)), BASE);
    }

    function test_AStatedValueThatAgreesIsAccepted() public {
        _init("AStatedValueThatAgreesIsAccepted");
        assertEq(h.agree("BASE_REWARD_DEPLOYMENT", 84532, BASE), BASE);
    }

    function test_AStaleStatedValueIsRefused() public {
        _init("AStaleStatedValueIsRefused");
        vm.expectRevert();
        h.agree("BASE_REWARD_DEPLOYMENT", 84532, address(0x01d));
    }

    function test_WithNoRecordTheStatedValueStands() public {
        _init("WithNoRecordTheStatedValueStands");
        assertEq(h.agree("MIRROR_REWARD_DEPLOYMENTS", 97, address(0xB0B)), address(0xB0B));
    }

    function test_TheMirrorRegistryComesFromTheRecords() public {
        _init("TheMirrorRegistryComesFromTheRecords");
        vm.chainId(84532);
        assertEq(h.mirrorsFromRecords("84532,421614,97"), string.concat("421614:", vm.toString(ARB)));
    }

    // ── mainnet: the record is the only source (design ruling 2026-11-22) ──

    function _mainnetRecords() internal {
        vm.createDir(string.concat(root, "/arbitrum"), true);
        vm.writeFile(string.concat(root, "/arbitrum/addresses.json"), string.concat('{"diamond":"', vm.toString(ARB), '"}'));
        if (vm.isFile(string.concat(root, "/base/addresses.json"))) vm.removeFile(string.concat(root, "/base/addresses.json"));
        if (vm.isFile(string.concat(root, "/optimism/addresses.json"))) vm.removeFile(string.concat(root, "/optimism/addresses.json"));
    }

    function test_Mainnet_AMirrorRefusesWhenBaseHasNoRecord() public {
        _init("Mainnet_AMirrorRefusesWhenBaseHasNoRecord");
        _mainnetRecords();
        vm.chainId(42161);
        vm.expectRevert();
        h.agree("BASE_REWARD_DEPLOYMENT", 8453, address(0));
    }

    function test_Mainnet_AnEnvValueWithNoRecordIsRefused() public {
        _init("Mainnet_AnEnvValueWithNoRecordIsRefused");
        _mainnetRecords();
        vm.chainId(42161);
        vm.expectRevert();
        h.agree("BASE_REWARD_DEPLOYMENT", 8453, address(0xBA5E));
    }

    function test_Mainnet_BaseRefusesWhenAnExpectedMirrorHasNoRecord() public {
        _init("Mainnet_BaseRefusesWhenAnExpectedMirrorHasNoRecord");
        _mainnetRecords();
        vm.chainId(8453);
        vm.expectRevert();
        h.mirrorsFromRecords("8453,42161,10");
    }

    function test_Mainnet_TheRegistryCoversEveryRecordedMirror() public {
        _init("Mainnet_TheRegistryCoversEveryRecordedMirror");
        _mainnetRecords();
        vm.chainId(8453);
        assertEq(h.mirrorsFromRecords("8453,42161"), string.concat("42161:", vm.toString(ARB)));
    }

    function test_AStatedRegistryMustNameExactlyTheRecordedPairs() public {
        _init("AStatedRegistryMustNameExactlyTheRecordedPairs");
        string memory rec = string.concat("42161:", vm.toString(ARB), ",10:", vm.toString(BASE));
        h.samePairs(string.concat("10:", vm.toString(BASE), ",42161:", vm.toString(ARB)), rec);
        vm.expectRevert();
        h.samePairs(string.concat("42161:", vm.toString(ARB)), rec);
        vm.expectRevert();
        h.samePairs(string.concat("42161:", vm.toString(ARB), ",42161:", vm.toString(ARB)), rec);
        vm.expectRevert();
        h.samePairs(string.concat("42161:", vm.toString(ARB), ",10:", vm.toString(address(0x01d))), rec);
    }

    // ── the readback before the configure marker (ruling item 4) ──

    function _thisChainIs(string memory slug, address diamond) internal {
        vm.createDir(string.concat(root, "/", slug), true);
        vm.writeFile(string.concat(root, "/", slug, "/addresses.json"), string.concat('{"diamond":"', vm.toString(diamond), '"}'));
    }

    function test_Readback_AMirrorMustNameBasesRecordedDiamond() public {
        _init("Readback_AMirrorMustNameBasesRecordedDiamond");
        IdentityReadStub stub = new IdentityReadStub();
        _thisChainIs("bnb-testnet", address(stub));
        vm.chainId(97);
        stub.set(BASE, 0, address(0));
        h.verify(84532, "");
        stub.set(address(0x01d), 0, address(0));
        vm.expectRevert();
        h.verify(84532, "");
    }

    function test_Readback_BaseMustRegisterEveryRecordedMirror() public {
        _init("Readback_BaseMustRegisterEveryRecordedMirror");
        IdentityReadStub stub = new IdentityReadStub();
        _thisChainIs("base-sepolia", address(stub));
        vm.chainId(84532);
        stub.set(address(0), 421614, ARB);
        h.verify(0, "84532,421614");
        stub.set(address(0), 421614, address(0x01d));
        vm.expectRevert();
        h.verify(0, "84532,421614");
    }
}
