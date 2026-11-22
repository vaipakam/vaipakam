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

// ── Rehearsal mode (#3891) ─────────────────────────────────────────────────
//
// A deploy rehearsal (`deploy-testnet.sh --rehearse`, driven by
// `script/rehearse.sh`) runs the REAL operator scripts against a local fork of
// a target chain. A fork keeps the real chain id, so every per-chain path
// resolves exactly as it would on the real chain. Two things must therefore
// hold for the whole run, and both are decided here, once:
//
//   1. Every record read and write goes to the run's scratch folder, never the
//      committed `deployments/<slug>/` files.
//   2. The mode cannot be entered against a real chain, and a node that only a
//      development node could be (the marker below) is never treated as a real
//      chain.
//
// The FLAG is the environment variable {REHEARSAL_FLAG_ENV} = "1", exported by
// the deploy script's `--rehearse` mode together with {REHEARSAL_ROOT_ENV}.
// The NODE is the chain this script runs against carrying the local-node marker.
// Both must agree. The shell adds the half Solidity cannot see (the RPC URL is
// a loopback address).
//
// Why an environment variable here, when {ArtifactRootBase} explains at length
// why its override is NOT one: that reason is `forge test`, where every
// parallel test shares one process environment. The rule below never reads the
// environment under `forge test` (`underTest` short-circuits it), so the hazard
// does not arise, and a `forge script` run is one process for one script.
string constant REHEARSAL_FLAG_ENV = "VAIPAKAM_REHEARSAL";
string constant REHEARSAL_ROOT_ENV = "VAIPAKAM_REHEARSAL_ROOT";

// A rehearsal's records live under this narrower prefix of
// {ARTIFACT_SCRATCH_PREFIX}, one folder per run.
string constant REHEARSAL_SCRATCH_PREFIX = "deployments/.forge-test/rehearsal/";

// The harness's local-node marker (`packages/anvil-harness`, `LOCAL_NODE_MARKER`).
// File level so {ArtifactRootBase}, {Deployments} and `Signers` read ONE copy.
// The address is a hash, so nobody holds its key and no CREATE or CREATE2 can be
// steered to it short of a 160-bit preimage: on a real chain it never has code.
// Only a dev node's `anvil_setCode` can place code there. The code opens with
// INVALID (0xfe), so a call to it reverts. The two must match the harness's
// copies byte for byte; a mismatch fails closed.
address constant LOCAL_NODE_MARKER =
    address(uint160(uint256(keccak256("vaipakam.e2e.local-node-marker"))));
bytes32 constant LOCAL_NODE_MARKER_CODEHASH =
    keccak256(hex"fe76616970616b616d20653265206c6f63616c206e6f6465");

/// TRUE when the chain the calling script runs against carries the marker.
function carriesLocalNodeMarker() view returns (bool) {
    return LOCAL_NODE_MARKER.codehash == LOCAL_NODE_MARKER_CODEHASH;
}

/// Where a script's records resolve when no scenario wrapper has redirected
/// them. Every non-`Committed` value but `Rehearsal` is a refusal.
enum RecordRoot {
    /// The committed `deployments/` tree: a real chain, Anvil (31337) or a test.
    Committed,
    /// The rehearsal's scratch folder ({REHEARSAL_ROOT_ENV}).
    Rehearsal,
    /// The flag is set against a node that does not carry the marker: an
    /// attempt to rehearse against a real chain.
    RefuseFlagWithoutMarker,
    /// The flag is set but no scratch root was exported with it.
    RefuseFlagWithoutRoot,
    /// The exported root is outside {REHEARSAL_SCRATCH_PREFIX} or climbs out.
    RefuseRootOutsideScratch,
    /// A marker node, no flag and no wrapper redirect: a script run by hand on
    /// a local fork would otherwise read and write the committed records of the
    /// real chain whose id the fork presents.
    RefuseMarkerWithoutRehearsal
}

/// The rule, as a pure function of its four inputs so every combination is
/// testable without touching the process environment.
///
/// @param underTest A `forge test` run: the environment is never consulted.
/// @param flag      {REHEARSAL_FLAG_ENV} is "1".
/// @param marker    The node carries the local-node marker.
/// @param root      The value of {REHEARSAL_ROOT_ENV} ("" when unset).
function recordRootRule(bool underTest, bool flag, bool marker, string memory root)
    pure
    returns (RecordRoot)
{
    if (underTest) return RecordRoot.Committed;
    if (flag) {
        if (!marker) return RecordRoot.RefuseFlagWithoutMarker;
        if (bytes(root).length == 0) return RecordRoot.RefuseFlagWithoutRoot;
        if (!_startsWithPrefix(root, REHEARSAL_SCRATCH_PREFIX) || hasParentSegment(root)) {
            return RecordRoot.RefuseRootOutsideScratch;
        }
        return RecordRoot.Rehearsal;
    }
    if (marker) return RecordRoot.RefuseMarkerWithoutRehearsal;
    return RecordRoot.Committed;
}

/// The refusal text for each refusing value of {RecordRoot}.
function recordRootRefusal(RecordRoot r) pure returns (string memory) {
    if (r == RecordRoot.RefuseFlagWithoutMarker) {
        return "Rehearsal: VAIPAKAM_REHEARSAL=1 against a node without the local-node marker - a rehearsal runs only on a local fork started by script/rehearse.sh, never against a real chain";
    }
    if (r == RecordRoot.RefuseFlagWithoutRoot) {
        return "Rehearsal: VAIPAKAM_REHEARSAL=1 with no VAIPAKAM_REHEARSAL_ROOT - the run's scratch folder must be exported with the flag";
    }
    if (r == RecordRoot.RefuseRootOutsideScratch) {
        return "Rehearsal: VAIPAKAM_REHEARSAL_ROOT must start with deployments/.forge-test/rehearsal/ and contain no `..` segment";
    }
    if (r == RecordRoot.RefuseMarkerWithoutRehearsal) {
        return "Deployments: this node carries the local-node marker but the run is neither a rehearsal nor redirected by a scenario wrapper - refusing to touch the committed records of the chain it presents (use script/rehearse.sh)";
    }
    return "";
}

/// TRUE when this `forge script` run is a deploy rehearsal. Reverts when the
/// flag is set against a node without the marker. Never TRUE under `forge test`.
function rehearsalMode() view returns (bool) {
    Vm cheats = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    if (cheats.isContext(VmSafe.ForgeContext.TestGroup)) return false;
    if (!_flagSet(cheats)) return false;
    require(carriesLocalNodeMarker(), recordRootRefusal(RecordRoot.RefuseFlagWithoutMarker));
    return true;
}

/// The record root for a run with no wrapper redirect: the committed root
/// (returned as ""), or the rehearsal's scratch root. Reverts on every refusal
/// of {recordRootRule}.
function unredirectedRecordRoot() view returns (string memory) {
    Vm cheats = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bool underTest = cheats.isContext(VmSafe.ForgeContext.TestGroup);
    if (underTest) return "";
    bool flag = _flagSet(cheats);
    // The marker is read only when it can change the answer, so a real
    // deploy against a real chain pays one EXTCODEHASH and nothing more.
    string memory root = flag ? cheats.envOr(REHEARSAL_ROOT_ENV, string("")) : "";
    RecordRoot r = recordRootRule(false, flag, carriesLocalNodeMarker(), root);
    if (r == RecordRoot.Committed) return "";
    if (r == RecordRoot.Rehearsal) return root;
    revert(recordRootRefusal(r));
}

function _flagSet(Vm cheats) view returns (bool) {
    return keccak256(bytes(cheats.envOr(REHEARSAL_FLAG_ENV, string("")))) == keccak256("1");
}

function _startsWithPrefix(string memory s, string memory prefix) pure returns (bool) {
    bytes memory b = bytes(s);
    bytes memory p = bytes(prefix);
    if (b.length < p.length) return false;
    for (uint256 i; i < p.length; ++i) {
        if (b[i] != p[i]) return false;
    }
    return true;
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
    /// @dev    Refused unless this is a local Anvil node or a `forge test`
    ///         run, for the reason `Deployments.artifactWriteMode` honours
    ///         `DEPLOY_SKIP_ARTIFACTS` only in local contexts: a deployment
    ///         that reaches a real chain must publish its artifact where the
    ///         census inventory looks for it. A redirect is a way to write an
    ///         artifact NOWHERE anyone reads, which on a live broadcast is the
    ///         #2070 failure wearing a different hat.
    ///
    ///         "A local node" is either chain id 31337 or a node carrying the
    ///         harness's local-node marker (see {_carriesLocalNodeMarker}).
    ///         The second form exists for the e2e harnesses (#2516): a
    ///         two-chain scenario runs one Anvil node PRESENTING Base Sepolia
    ///         and one presenting Sepolia, and the operator scripts it runs on
    ///         them (`DeployCrosschain`, `ConfigureCcip`,
    ///         `ConfigureRewardReporter`) decide canonical-versus-mirror and
    ///         read every chain's artifact by `block.chainid`. Without this
    ///         they could run there only by writing the COMMITTED per-chain
    ///         artifact, which is the one thing a redirect exists to prevent.
    ///
    ///         The marker is chain STATE that a real chain cannot hold, not an
    ///         RPC method's answer: an endpoint that answers a dev-node method
    ///         says nothing about where its transactions land (Codex #2604 r6
    ///         P1 retired an `anvil_nodeInfo` probe for exactly that reason).
    ///
    ///         The refusal is a `require`, not a silent ignore: a test that
    ///         believes it redirected a live deploy and did not would assert
    ///         against the committed artifact and pass for the wrong reason.
    function setArtifactRootOverride(string memory newRoot) public {
        require(
            block.chainid == 31337 ||
                CHEATS.isContext(VmSafe.ForgeContext.TestGroup) ||
                _carriesLocalNodeMarker(),
            "ArtifactRootBase: the artifact root may only be redirected on Anvil (31337), on a harness node carrying the local-node marker, or under forge test - a deployment that reaches a real chain must publish its artifact where the census inventory reads it"
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

    /// @dev TRUE when the chain this script runs against carries the harness's
    ///      local-node marker (the file-level {LOCAL_NODE_MARKER}). Read only
    ///      after the two cheaper tests above have failed, so a 31337 or
    ///      `forge test` run never reads it.
    function _carriesLocalNodeMarker() private view returns (bool) {
        return carriesLocalNodeMarker();
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
