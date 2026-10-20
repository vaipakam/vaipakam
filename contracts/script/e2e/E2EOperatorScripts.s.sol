// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactRootBase} from "../lib/ArtifactRoot.sol";
import {DeployVPFIToken} from "../DeployVPFIToken.s.sol";
import {DeployCrosschain} from "../DeployCrosschain.s.sol";
import {ConfigureVPFIToken} from "../ConfigureVPFIToken.s.sol";
import {ConfigureCcip} from "../ConfigureCcip.s.sol";
import {ConfigureRewardReporter} from "../ConfigureRewardReporter.s.sol";
import {SetInteractionLaunch} from "../SetInteractionLaunch.s.sol";

/**
 * @title  The operator scripts, run unchanged against an e2e node (#2516)
 * @notice Each contract here IS the operator script it names — it inherits it
 *         and its `run()` is the script's own, line for line — with ONE
 *         addition: before `run()`, `setUp()` redirects this script
 *         instance's artifact root to the scratch directory named by
 *         `E2E_ARTIFACT_ROOT` (`ArtifactRootBase`). So every artifact read
 *         and write the script makes — its own chain's file, and in
 *         `ConfigureCcip` every OTHER chain's — lands under the gitignored
 *         `deployments/.forge-test/`, never on a committed per-chain file.
 *
 * @dev    WHY WRAP RATHER THAN REPRODUCE. The single-chain keeper fixture
 *         (`ConfigureKeeperRewardsFixture`) re-states each operator step
 *         inline, because the operator scripts key everything on
 *         `block.chainid` and on the per-chain artifact — and on a node
 *         presenting 84532 that artifact was the committed Base Sepolia file.
 *         A two-chain scenario is about exactly that keying: which chain is
 *         canonical, which messenger peers with which, which pool is whose
 *         remote. Reproducing it would test a copy. `ArtifactRootBase` now
 *         admits a redirect on any Anvil node (it asks the node), so the real
 *         scripts can run on a node that presents a live chain id.
 *
 *         Run with `forge script <this file> --tc <Contract>`; the harness
 *         (`apps/keeper/e2e/mesh/fixture.ts`) does, in the order an operator
 *         would. Each script's env is its own — see its header.
 *         `ArtifactRootBase` refuses the redirect anywhere but a local Anvil
 *         node or `forge test`, and refuses any root outside
 *         `deployments/.forge-test/`.
 */
contract E2EDeployVPFIToken is DeployVPFIToken, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}

contract E2EDeployCrosschain is DeployCrosschain, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}

contract E2EConfigureVPFIToken is ConfigureVPFIToken, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}

contract E2EConfigureCcip is ConfigureCcip, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}

contract E2EConfigureRewardReporter is ConfigureRewardReporter, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}

contract E2ESetInteractionLaunch is SetInteractionLaunch, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}
