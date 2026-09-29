// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm, VmSafe} from "forge-std/Vm.sol";

/**
 * @title  Per-script artifact state
 * @notice Where a script's artifact goes, and the artifact as it stood before
 *         the run, held in the SCRIPT INSTANCE's own storage.
 *
 * @dev    `Deployments` is a library of `internal` functions, so it executes in
 *         the CALLING SCRIPT's context: storage it reads is the script's
 *         storage. That is the whole mechanism here. The state lives in EVM
 *         storage, which under `forge test` is per-test-thread, so it is
 *         THREAD-LOCAL BY CONSTRUCTION — the same property
 *         `DeployDiamond.runWith(admin, treasury, key)` buys by taking
 *         arguments instead of reading env.
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
 *
 *         READ DIRECTLY, NEVER THROUGH A CALL (#2347). #2253 first reached this
 *         state through external self-calls — `IArtifactRoot(address(this))` —
 *         and Foundry's script runner refuses ANY call whose target is the
 *         script contract ("Usage of `address(this)` detected in script
 *         contract"). `forge test` does not apply that guard, so every test
 *         stayed green while every `forge script` deploy reverted before its
 *         first transaction. A namespaced slot reaches the same storage with
 *         no call at all. A script that never sets an override simply reads
 *         the empty default here.
 *
 *         The layout is ERC-7201 so it cannot collide with a script's own
 *         state variables, which occupy the low sequential slots.
 */
/// @custom:storage-location erc7201:vaipakam.script.artifact-root
struct ArtifactRootState {
    /// The directory holding `<chain-slug>/addresses.json` for this run, or
    /// the empty string for the committed default.
    string rootOverride;
    /// The artifact's text before this run wrote to it, so a failed
    /// completeness check can put it back (#2253 r3 P1).
    string priorArtifact;
    /// Whether that artifact existed at all.
    bool priorExisted;
}

// keccak256(abi.encode(uint256(keccak256("vaipakam.script.artifact-root")) - 1))
//   & ~bytes32(uint256(0xff))
bytes32 constant ARTIFACT_ROOT_STATE_SLOT =
    0xce0d3c16c70087118e200f7434dedf6f21fb9e7830331cb2c37244decebfe900;

/// The calling script's artifact state. Free-standing so both `Deployments`
/// (a library) and `ArtifactRootBase` reach the SAME slot through one
/// definition.
function artifactRootState() pure returns (ArtifactRootState storage $) {
    bytes32 slot = ARTIFACT_ROOT_STATE_SLOT;
    assembly {
        $.slot := slot
    }
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

/// Total test: does `s` contain a `..` PATH SEGMENT?
///
/// Segment, not substring — `deployments/.forge-test/my..dir` is a legitimate
/// directory name and must not be refused, while `deployments/.forge-test/../../x`
/// must be. A segment is `..` exactly when both bytes are `.` and each side is
/// either a `/` or the end of the string.
///
/// File-level, and deliberately: this is HALF the confinement invariant stated
/// above — "without `..` nothing beginning with the prefix can climb back out"
/// — and the root is not the only string that gets composed into an artifact
/// path. `Deployments.dirForSlug` appends a SLUG to the root, so a `..` in the
/// slug re-opens the escape the root check closed (#2261 r1 P2). Both checks
/// must therefore be the SAME check; a private copy per contract is how they
/// drift. Plain `//`-style doc rather than the contract-member form for the
/// same solc-6546 reason the constant above carries.
function hasParentSegment(string memory s) pure returns (bool) {
    bytes memory b = bytes(s);
    if (b.length < 2) return false;
    for (uint256 i; i + 1 < b.length; ++i) {
        if (b[i] != "." || b[i + 1] != ".") continue;
        bool leftIsBoundary = (i == 0) || b[i - 1] == "/";
        bool rightIsBoundary = (i + 2 == b.length) || b[i + 2] == "/";
        if (leftIsBoundary && rightIsBoundary) return true;
    }
    return false;
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
abstract contract ArtifactRootBase {
    address private constant VM_ADDR =
        address(uint160(uint256(keccak256("hevm cheat code"))));
    Vm private constant CHEATS = Vm(VM_ADDR);

    /// @notice This script instance's artifact root override, or the empty
    ///         string for the committed default. For tests to read; the
    ///         deploy path reads the state directly (see `artifactRootState`).
    function artifactRootOverride() external view returns (string memory) {
        return artifactRootState().rootOverride;
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
            !hasParentSegment(newRoot),
            "ArtifactRootBase: a redirected artifact root must contain no `..` segment - with one it can climb back out of the scratch directory and reach the committed artifact"
        );
        artifactRootState().rootOverride = newRoot;
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

}
