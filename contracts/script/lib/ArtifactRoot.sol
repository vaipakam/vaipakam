// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";

/**
 * @title  IArtifactRoot
 * @notice The one question {Deployments} asks the script that is calling it:
 *         "where does your artifact go?".
 *
 * @dev    `Deployments` is a library of `internal` functions, so it executes in
 *         the CALLING SCRIPT's context — `address(this)` inside it is the
 *         script contract. That is the whole mechanism here: the override lives
 *         in the script instance's own storage, which is EVM state, which under
 *         `forge test` is per-test-thread. It is therefore THREAD-LOCAL BY
 *         CONSTRUCTION, the same property `DeployDiamond.runWith(admin,
 *         treasury, key)` buys by taking arguments instead of reading env.
 *
 *         That distinction is the reason this is not an environment variable.
 *         `vm.setEnv` writes the PROCESS environment, which every parallel test
 *         shares; this repository has already been bitten by it twice, and both
 *         scars are written down — `DeployDiamondIntegrationTest` keeps all
 *         `DEPLOY_SKIP_ARTIFACTS` handling in one place, and
 *         `DeploymentsPublicationGateTest` had to fold four env-dependent tests
 *         into one sequential function after a sibling's exported token leaked
 *         into the no-token case. An env-keyed artifact root would have been a
 *         third: one test redirecting its own deploy would silently redirect
 *         every deploy running beside it.
 */
interface IArtifactRoot {
    /// @notice The directory holding `<chain-slug>/addresses.json` for this
    ///         run, or the empty string to use the committed default.
    function artifactRootOverride() external view returns (string memory);
}

/**
 * @title  ArtifactRootBase
 * @notice Inherited by every deploy script whose artifact a TEST may need to
 *         read back. Production runs never touch it: the override starts empty,
 *         nothing on a deploy path sets it, and the setter refuses to run
 *         anywhere a real deployment could land.
 *
 * @dev    Why a script would ever redirect its own artifact: asserting that a
 *         deploy RECORDED every facet it CUT (#1800) requires the real write to
 *         happen and the real file to be read back. Pointed at the default root
 *         that would overwrite the committed `deployments/anvil/addresses.json`
 *         on every `forge test` run, so the assertion needs somewhere else to
 *         write — and needs it without reaching for the process environment.
 */
abstract contract ArtifactRootBase is IArtifactRoot {
    address private constant VM_ADDR =
        address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant CHEATS = Vm(VM_ADDR);

    string private _artifactRootOverride;

    /// @inheritdoc IArtifactRoot
    function artifactRootOverride() external view returns (string memory) {
        return _artifactRootOverride;
    }

    /// @notice Redirect this script instance's artifact. LOCAL-ONLY.
    ///
    /// @dev    Refused unless this is the Anvil chain or a `forge test` run —
    ///         the same two contexts `Deployments.artifactWriteMode` honours
    ///         `DEPLOY_SKIP_ARTIFACTS` in, and for the same reason: a
    ///         deployment that reaches a real chain must publish its artifact
    ///         where the census inventory looks for it. A redirect is a way to
    ///         write an artifact NOWHERE anyone reads, which on a live broadcast
    ///         is the #2070 failure wearing a different hat.
    ///
    ///         The refusal is a `require`, not a silent ignore: a test that
    ///         believes it redirected a live deploy and did not would assert
    ///         against the committed artifact and pass for the wrong reason.
    function setArtifactRootOverride(string memory newRoot) public {
        require(
            block.chainid == 31337 ||
                CHEATS.isContext(VmSafe.ForgeContext.TestGroup),
            "ArtifactRootBase: the artifact root may only be redirected on Anvil (31337) or under forge test - a deployment that reaches a real chain must publish its artifact where the census inventory reads it"
        );
        require(
            bytes(newRoot).length != 0,
            "ArtifactRootBase: artifact root override must be non-empty - pass no override at all to use the committed default"
        );
        _artifactRootOverride = newRoot;
    }
}
