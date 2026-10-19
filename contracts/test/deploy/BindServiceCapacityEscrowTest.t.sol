// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {BindServiceCapacityEscrow} from "../../script/BindServiceCapacityEscrow.s.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ServiceCapacityFacet} from "../../src/facets/ServiceCapacityFacet.sol";

/// @notice #2583 — bind and record are separate steps. A bind writes nothing; the
///         escrow is published only by `record()`, from the address the Diamond
///         reports in live state, through the dedicated reconciliation writer.
///         Artifacts are redirected to a scratch root, never the committed files.
/// @dev Exposes the script's non-broadcast write policy for the test above.
contract WritePolicyProbe is BindServiceCapacityEscrow {
    function writesEnabled() external view returns (bool) {
        return _nonBroadcastWritesEnabled();
    }
}

contract BindServiceCapacityEscrowTest is Test {
    uint256 internal constant DEPLOYER_KEY = 1;
    address internal diamond;
    string internal root;

    function setUp() public {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("DEPLOY_SKIP_ARTIFACTS", "true");
        DeployDiamond deployScript = new DeployDiamond();
        deployScript.runWith(vm.addr(DEPLOYER_KEY), address(0xBEEF), DEPLOYER_KEY);
        diamond = deployScript.diamond();
    }

    function _script(string memory name) internal returns (BindServiceCapacityEscrow s) {
        s = new BindServiceCapacityEscrow();
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "bind-capacity-escrow-", name);
        s.setArtifactRootOverride(root);
        string memory dir = string.concat(root, "/", Deployments.chainSlug());
        vm.createDir(dir, true);
        vm.writeJson(
            string.concat("{\"chainId\":", vm.toString(block.chainid), ",\"diamond\":\"", vm.toString(diamond), "\"}"),
            string.concat(dir, "/addresses.json")
        );
    }

    function _artifact() internal view returns (string memory) {
        return vm.readFile(string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"));
    }

    function _escrow() internal view returns (address e) {
        (e,,) = ServiceCapacityFacet(diamond).getServiceCapacityEscrow();
    }

    /// Straddle: the bind writes nothing; record() then publishes exactly the
    /// escrow the Diamond reports, and a second record() is a no-op rewrite.
    function test_BindWritesNothing_RecordPublishesTheLiveEscrow() public {
        BindServiceCapacityEscrow s = _script("direct");
        assertEq(_escrow(), address(0), "fixture-live: a fresh deploy leaves the escrow unbound");
        s.bindWith(diamond, DEPLOYER_KEY);
        address bound = _escrow();
        assertTrue(bound != address(0) && bound.code.length != 0, "the bind constructed a holder");
        assertFalse(vm.keyExistsJson(_artifact(), ".serviceCapacityEscrow"), "the bind wrote nothing");

        assertEq(s.recordFor(diamond), bound, "record reports the bound escrow");
        assertEq(vm.parseJsonAddress(_artifact(), ".serviceCapacityEscrow"), bound, "and publishes it");
        s.recordFor(diamond);
        assertEq(vm.parseJsonAddress(_artifact(), ".serviceCapacityEscrow"), bound, "idempotent");
        vm.removeDir(root, true);
    }

    function test_RecordBeforeAnyBind_Refuses() public {
        BindServiceCapacityEscrow s = _script("unbound");
        vm.expectRevert(bytes("BindServiceCapacityEscrow: no escrow is bound yet -- bind (run() or stage()) and let it confirm first"));
        s.recordFor(diamond);
        vm.removeDir(root, true);
    }

    function test_BindWithoutAdminRole_RefusesAndPointsAtStage() public {
        BindServiceCapacityEscrow s = _script("norole");
        vm.expectRevert(bytes("BindServiceCapacityEscrow: ADMIN_PRIVATE_KEY does not hold ADMIN_ROLE -- after governance handover use stage() / record()"));
        s.bindWith(diamond, 2);
        vm.removeDir(root, true);
    }

    function test_SecondBind_Refuses_StageSendsNothing() public {
        BindServiceCapacityEscrow s = _script("second");
        s.stageFor(diamond); // unbound: prints the Timelock calldata only
        assertEq(_escrow(), address(0), "stage sent nothing");
        s.bindWith(diamond, DEPLOYER_KEY);
        vm.expectRevert(bytes("BindServiceCapacityEscrow: the escrow is already bound (binding is one-shot) -- run record() to publish it"));
        s.bindWith(diamond, DEPLOYER_KEY);
        vm.removeDir(root, true);
    }

    /// Codex #2585 r2 — the non-broadcast write policy itself: under forge test
    /// writes are OFF unless the artifact is redirected to a scratch root, so a
    /// test can never rewrite a committed artifact through record().
    function test_WritePolicy_OffUnderTest_OnlyARedirectEnablesIt() public {
        WritePolicyProbe probe = new WritePolicyProbe();
        assertFalse(probe.writesEnabled(), "under test, no redirect: writes are off");
        string memory scratch = string.concat(ARTIFACT_SCRATCH_PREFIX, "bind-capacity-escrow-policy");
        probe.setArtifactRootOverride(scratch);
        assertTrue(probe.writesEnabled(), "a redirected (scratch) artifact may be written");
    }

    /// Codex #2585 r2 — a stale artifact naming an escrow while the Diamond has
    /// none bound refuses BEFORE the one-shot bind, in both bind routes.
    function test_StaleArtifactWhileUnbound_RefusesBindAndStage() public {
        BindServiceCapacityEscrow s = _script("stale");
        vm.writeJson(
            vm.toString(makeAddr("staleHolder")),
            string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"),
            ".serviceCapacityEscrow"
        );
        bytes memory reason = bytes("BindServiceCapacityEscrow: the artifact names an escrow but the Diamond has none bound -- reconcile the artifact before binding");
        vm.expectRevert(reason);
        s.bindWith(diamond, DEPLOYER_KEY);
        vm.expectRevert(reason);
        s.stageFor(diamond);
        assertEq(_escrow(), address(0), "nothing was bound");
        vm.removeDir(root, true);
    }

    /// Codex #2585 r4 — every entry acts on the artifact's Diamond only: a
    /// different Diamond, bound or not, is refused before anything is read or
    /// written, and nothing is published.
    function test_ADiamondOtherThanTheArtifacts_IsRefused() public {
        BindServiceCapacityEscrow s = _script("other");
        DeployDiamond other = new DeployDiamond();
        other.runWith(vm.addr(DEPLOYER_KEY), address(0xBEEF), DEPLOYER_KEY);
        address otherDiamond = other.diamond();
        bytes memory reason = bytes("BindServiceCapacityEscrow: the Diamond is not this chain's deployment artifact Diamond");
        vm.expectRevert(reason);
        s.bindWith(otherDiamond, DEPLOYER_KEY);
        vm.expectRevert(reason);
        s.stageFor(otherDiamond);
        vm.prank(vm.addr(DEPLOYER_KEY));
        ServiceCapacityFacet(otherDiamond).bindServiceCapacityEscrow();
        vm.expectRevert(reason);
        s.recordFor(otherDiamond);
        assertFalse(vm.keyExistsJson(_artifact(), ".serviceCapacityEscrow"), "nothing published");
        vm.removeDir(root, true);
    }

    function test_ArtifactNamingADifferentEscrow_Refuses() public {
        BindServiceCapacityEscrow s = _script("foreign");
        s.bindWith(diamond, DEPLOYER_KEY);
        vm.writeJson(
            vm.toString(makeAddr("someOtherHolder")),
            string.concat(root, "/", Deployments.chainSlug(), "/addresses.json"),
            ".serviceCapacityEscrow"
        );
        vm.expectRevert(bytes("BindServiceCapacityEscrow: the artifact names a different escrow than the Diamond reports"));
        s.recordFor(diamond);
        vm.removeDir(root, true);
    }
}
