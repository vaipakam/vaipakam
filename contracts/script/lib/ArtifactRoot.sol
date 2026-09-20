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

    /// @notice Hand the script the artifact as it stood before this run.
    ///
    /// @dev    The library cannot hold run state — it is stateless — and the
    ///         CALLER cannot hold it either: `DeployDiamond.runWith` is at the
    ///         viaIR stack ceiling with ~80 live facet addresses, and FOUR
    ///         compiles failed on "Variable expr_… is 1 too deep" from nothing
    ///         more than an extra local or a destructured return in that frame.
    ///         So the library pushes it into the script's storage, through the
    ///         same seam it already reads {artifactRootOverride} from.
    function recordArtifactSnapshot(
        string calldata prior,
        bool priorExisted
    ) external;

    /// @notice The snapshot recorded by {recordArtifactSnapshot}.
    function artifactSnapshot()
        external
        view
        returns (string memory prior, bool priorExisted);
}

// The ONLY directory a redirected artifact may be written to.
//
// #2253 r1 P2 — an earlier revision took any root and decided "is this
// redirected?" by comparing the string against `"deployments"`. `./deployments`,
// `deployments/` and `deployments/.` all fail that comparison while resolving to
// the committed artifact, so each would have been treated as a safe redirect AND
// forced writes on — overwriting the exact file the redirect exists to protect.
//
// The answer is not a path normaliser. Deciding "does this string resolve to
// that directory?" over `.`, `..`, `//`, trailing slashes and symlinks is an
// unbounded predicate, and #1995 is the recorded cost of enumerating one. Two
// TOTAL tests replace it: the root must start with this prefix, and must contain
// no `..` segment. No alias of the committed root can begin with
// `deployments/.forge-test/`, and without `..` nothing beginning with it can
// climb back out — so the committed artifact is unreachable by construction
// rather than by case analysis.
//
// Declared at FILE level rather than on the contract so tests can import it
// directly: an `internal constant` member is not reachable as
// `ArtifactRootBase.SCRATCH_PREFIX` from another contract, and making it
// `public` to work around that would add a getter to every deploy script's ABI
// for a value only a test reads. Plain `//` rather than NatSpec because solc
// rejects `@notice`/`@dev` on a file-level variable (Error 6546).
string constant ARTIFACT_SCRATCH_PREFIX = "deployments/.forge-test/";

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
    string private _priorArtifact;
    bool private _priorExisted;

    /// @inheritdoc IArtifactRoot
    function recordArtifactSnapshot(
        string calldata prior,
        bool priorExisted
    ) external {
        require(
            msg.sender == address(this),
            "ArtifactRootBase: recordArtifactSnapshot is an internal hop"
        );
        _priorArtifact = prior;
        _priorExisted = priorExisted;
    }

    /// @inheritdoc IArtifactRoot
    function artifactSnapshot()
        external
        view
        returns (string memory, bool)
    {
        return (_priorArtifact, _priorExisted);
    }

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
        require(
            _startsWith(newRoot, ARTIFACT_SCRATCH_PREFIX),
            "ArtifactRootBase: a redirected artifact root must start with deployments/.forge-test/ - any other root can alias the committed artifact, and fs_permissions grants write access under deployments/ only"
        );
        require(
            !_hasParentSegment(newRoot),
            "ArtifactRootBase: a redirected artifact root must contain no `..` segment - with one it can climb back out of the scratch directory and reach the committed artifact"
        );
        _artifactRootOverride = newRoot;
    }

    /// @dev Total test: does `s` begin with `prefix`?
    function _startsWith(string memory s, string memory prefix)
        private
        pure
        returns (bool)
    {
        bytes memory b = bytes(s);
        bytes memory p = bytes(prefix);
        if (b.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }

    /// @dev Total test: does `s` contain a `..` PATH SEGMENT?
    ///
    ///      Segment, not substring — `deployments/.forge-test/my..dir` is a
    ///      legitimate directory name and must not be refused, while
    ///      `deployments/.forge-test/../../x` must be. A segment is `..`
    ///      exactly when both bytes are `.` and each side is either a `/` or
    ///      the end of the string.
    function _hasParentSegment(string memory s) private pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length < 2) return false;
        for (uint256 i; i + 1 < b.length; ++i) {
            if (b[i] != "." || b[i + 1] != ".") continue;
            bool leftIsBoundary = (i == 0) || b[i - 1] == "/";
            bool rightIsBoundary =
                (i + 2 == b.length) || b[i + 2] == "/";
            if (leftIsBoundary && rightIsBoundary) return true;
        }
        return false;
    }
}
