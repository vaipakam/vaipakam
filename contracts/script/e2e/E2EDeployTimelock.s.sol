// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ArtifactRootBase} from "../lib/ArtifactRoot.sol";
import {DeployTimelock} from "../DeployTimelock.s.sol";

/**
 * @title  E2EDeployTimelock
 * @notice The operator's `DeployTimelock`, run unchanged against an e2e node
 *         (#3306): its `run()` is the script's own, with ONE addition. Before
 *         it, `setUp()` redirects this instance's artifact root to the scratch
 *         directory named by `E2E_ARTIFACT_ROOT` (`ArtifactRootBase`), so the
 *         `.timelock` the script records lands under the gitignored
 *         `deployments/.forge-test/`, never on the committed per-chain file.
 *
 * @dev    The same wrapper shape as `E2EOperatorScripts.s.sol`. It lives in
 *         its own file so the alpha05 suite, which needs only this one,
 *         compiles only the Timelock and not the cross-chain scripts beside
 *         them. `ArtifactRootBase` refuses the redirect anywhere but a local
 *         Anvil node or `forge test`, and any root outside
 *         `deployments/.forge-test/`. Env: `E2E_ARTIFACT_ROOT` plus the
 *         script's own (see `DeployTimelock`'s header).
 */
contract E2EDeployTimelock is DeployTimelock, ArtifactRootBase {
    function setUp() public {
        setArtifactRootOverride(vm.envString("E2E_ARTIFACT_ROOT"));
    }
}
