// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {DeployDiamond} from "../../script/DeployDiamond.s.sol";
import {
    DeployDiamondVerificationProbe,
    DeployDiamondFailingVerificationProbe
} from "./DeployDiamondVerificationProbes.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";
import {IDiamondCut} from "@diamond-3/interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";

/**
 * @title  DeployArtifactCompletenessTest
 * @notice Issue #1800 — the regression guard for #1798, which found THIRTEEN
 *         facets cut into the Diamond and never recorded in `addresses.json`.
 *         The fix shipped; the guard did not, and this file is it.
 *
 * @dev    **Why this is not a check over the deploy script's text.** #1798 did
 *         write one — predeploy step `[4c]`, reading `DeployDiamond.s.sol` and
 *         `RefreshAllFacetsInPlace.s.sol` as source and trying to prove every
 *         cut facet was also recorded. Over four review rounds it collected
 *         SIXTEEN distinct ways to get a registration past it: a `//` inside a
 *         string, a registration quoted inside a string, an escaped key
 *         literal, a registration in an uncalled helper, an uncalled OVERLOAD
 *         of a called helper, an alias selector getter hiding the key, a
 *         chain-gated `if (block.chainid == …)`, a braceless one-line
 *         conditional, a `for` header whose own semicolons split the statement
 *         it guarded, a local `writeDiamond` shadowing `Deployments.`, a
 *         parameter shadowing an outer cut variable, a bare `writeFacet` from a
 *         non-canonical writer, the generic `writeAddress(".facets.…")` reaching
 *         the same namespace, and a facet variable reassigned between its cut
 *         and its write. Every one reproduced; every fix opened the next.
 *
 *         That is not bad luck. "This registration executes, under this
 *         identity, on every chain" is a question about scope, control flow and
 *         aliasing, and a line-oriented parser cannot answer it — it was
 *         reaching a green verdict it had not earned, which on a gate standing
 *         between a change and a deploy is worse than no gate, because nobody
 *         reads a green one. The step was withdrawn.
 *
 *         **What replaces it needs no parsing.** Run the real deploy, let it
 *         write its real artifact, and compare what the deploy PRODUCED against
 *         what the Diamond REPORTS:
 *
 *             for every address `facetAddresses()` reports,
 *             some key in the written JSON carries that address
 *
 *         Every row of that evasion table is answered by construction. The
 *         assertion does not care how a registration is spelled, which function
 *         hosts it, what guards it, whether the variable was reassigned, or
 *         which writer performed it. Two of the sixteen — the chain-gated write
 *         and the generic-writer overwrite — are things no static reading could
 *         ever have settled.
 *
 *         **Where the artifact goes.** A `forge test` deploy writing to the
 *         default root would overwrite the committed
 *         `deployments/anvil/addresses.json` on every run, which is why every
 *         other deploy-suite test sets `DEPLOY_SKIP_ARTIFACTS=true` — and why
 *         this one cannot: it needs the write it is asserting about. It
 *         redirects the artifact instead, through
 *         `ArtifactRootBase.setArtifactRootOverride`, which is SCRIPT-INSTANCE
 *         STORAGE and therefore thread-local. Not an environment variable:
 *         `vm.setEnv` writes the process environment that every parallel test
 *         shares, and this repository has been bitten by that twice already
 *         (see the notes in `DeployDiamondIntegrationTest` and
 *         `DeploymentsPublicationGateTest`). An env-keyed root would have made
 *         a third — one test redirecting its own deploy would redirect every
 *         deploy running beside it, and a sibling's `DEPLOY_SKIP_ARTIFACTS`
 *         would silently switch off the write this file reads back.
 *
 * @custom:audit-priority HIGH — the artifact is how every follow-on script,
 *         the frontend bundle and the census inventory learn a facet's address.
 *         A facet missing from it is recoverable (the loupe still knows), but
 *         only by someone who notices.
 */
contract DeployArtifactCompletenessTest is Test {
    /// @dev Same deterministic deployer the rest of the deploy suite uses.
    uint256 internal constant DEPLOYER_KEY = 1;

    /// @dev Distinct from the deployer so the artifact's treasury key is
    ///      unambiguous if this test ever grows an assertion about it.
    address internal constant TREASURY = address(0xBEEF);

    /// @dev Distinct from the deployer so `runWith` takes the handover branch —
    ///      the topology every testnet and mainnet deploy actually uses.
    address internal constant ADMIN_FOR_HANDOVER = address(0xA11CE);

    /// @dev Scratch artifact roots live under `deployments/` because
    ///      `foundry.toml#fs_permissions` grants read-write on that subtree and
    ///      nowhere else. One directory per test FUNCTION, named after it: test
    ///      function names are unique across the suite, so two concurrently
    ///      running tests cannot land on the same file however Foundry
    ///      schedules them.
    function _scratchRoot(string memory testName)
        internal
        pure
        returns (string memory)
    {
        return string.concat(ARTIFACT_SCRATCH_PREFIX, testName);
    }

    /// @dev The chain ids the completeness assertion is exercised on.
    ///
    ///      #2253 r1 P2 — an earlier revision ran on 31337 ALONE and hard-coded
    ///      the `/anvil/` path, which made a chain-gated omission
    ///      (`if (block.chainid == 31337) Deployments.writeFacet(…)`) pass the
    ///      guard while being absent from every live-chain artifact. That is
    ///      precisely the evasion the PR claimed to have answered, so the claim
    ///      was wrong for every chain but the one being tested.
    ///
    ///      Every Phase-1 mainnet target and its testnet is listed. Arbitrum is
    ///      deliberately INCLUDED rather than skipped as awkward: it is the one
    ///      chain whose deploy takes a different code path
    ///      (`Deployments.currentL2Block` queries the ArbSys precompile at
    ///      0x64, absent from forge's EVM), so omitting it would leave the
    ///      chain most likely to diverge as the one never checked.
    function _chainIds() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](11);
        ids[0] = 31337;      // anvil
        ids[1] = 84532;      // base-sepolia  — ACTIVE (canonical-VPFI)
        ids[2] = 421614;     // arb-sepolia   — ACTIVE (mirror, ArbSys path)
        ids[3] = 97;         // bnb-testnet   — ACTIVE (mirror)
        ids[4] = 11155420;   // op-sepolia    — a deploy-chain.sh target
        ids[5] = 80002;      // polygon-amoy  — a deploy-chain.sh target
        ids[6] = 1;          // ethereum      — Phase-1 mainnet
        ids[7] = 8453;       // base          — Phase-1 mainnet
        ids[8] = 10;         // optimism      — Phase-1 mainnet
        ids[9] = 137;        // polygon       — Phase-1 mainnet
        ids[10] = 42161;     // arbitrum      — Phase-1 mainnet, ArbSys path
    }

    /// @dev Chain-slug directory the artifact lands in, mirroring
    ///      `Deployments.slugForChainId`. Written out rather than imported so a
    ///      silent change to that mapping shows up as a missing file here
    ///      instead of both sides moving together and the test still passing.
    function _slug(uint256 cid) internal pure returns (string memory) {
        if (cid == 31337)     return "anvil";
        if (cid == 1)         return "ethereum";
        if (cid == 8453)      return "base";
        if (cid == 84532)     return "base-sepolia";
        if (cid == 10)        return "optimism";
        if (cid == 137)       return "polygon";
        if (cid == 42161)     return "arbitrum";
        if (cid == 421614)    return "arb-sepolia";
        if (cid == 97)        return "bnb-testnet";
        if (cid == 11155420)  return "op-sepolia";
        if (cid == 80002)     return "polygon-amoy";
        revert("test: unlisted chain id");
    }

    /// @dev Deploy for real ON `chainId`, into a scratch root, and hand back
    ///      both the Diamond and the artifact the deploy itself wrote.
    function _deployWritingArtifact(string memory testName, uint256 chainId)
        internal
        returns (address diamond, string memory artifactJson)
    {
        string memory root = string.concat(
            _scratchRoot(testName), "/", vm.toString(chainId)
        );

        // A previous run's file would satisfy the assertion without this run
        // having written anything — the vacuous pass this suite is required to
        // watch for. Start from nothing every time.
        if (vm.isDir(root)) vm.removeDir(root, true);

        vm.chainId(chainId);

        // forge's EVM does not emulate the Arbitrum ArbSys precompile, and
        // `Deployments.currentL2Block` reverts with an instruction to set
        // ARB_L2_DEPLOY_BLOCK rather than silently stamping the L1 block. That
        // env var is process-global — the hazard this whole file is built to
        // avoid — so the precompile is mocked instead, which is thread-local.
        vm.mockCall(
            address(0x64),
            abi.encodeWithSignature("arbBlockNumber()"),
            abi.encode(uint256(1))
        );

        // #2253 r2 P2 — a DISTINCT admin, so the post-deploy handover branch
        // executes exactly as it does on testnet and mainnet. Passing the
        // deployer as admin took the single-EOA path and left every
        // production-topology artifact unobserved.
        address deployer = vm.addr(DEPLOYER_KEY);
        require(ADMIN_FOR_HANDOVER != deployer, "test: admin must differ from deployer");
        DeployDiamond script = new DeployDiamond();
        script.setArtifactRootOverride(root);
        script.runWith(ADMIN_FOR_HANDOVER, TREASURY, DEPLOYER_KEY);
        diamond = script.diamond();

        string memory artifactPath = string.concat(
            root, "/", _slug(chainId), "/addresses.json"
        );
        assertTrue(
            vm.isFile(artifactPath),
            string.concat(
                "the deploy on chain ",
                vm.toString(chainId),
                " wrote no artifact at all - the redirect or the write step is broken, and every assertion below would pass vacuously without this line"
            )
        );
        artifactJson = vm.readFile(artifactPath);

        vm.removeDir(root, true);
    }

    /// @dev TRUE when `needle` is the value of some key under `.facets`.
    ///
    ///      `.facets` is the whole search space on purpose, not a convenience.
    ///      `Deployments.writeFacet` is the sanctioned door into that
    ///      namespace, and a facet address recorded anywhere else is a finding
    ///      rather than an alternative spelling — issue #1800 proposes closing
    ///      the second door (the generic `writeAddress(".facets.…")`) for the
    ///      same reason.
    function _recordedAsFacet(string memory artifactJson, address needle)
        internal
        view
        returns (bool)
    {
        string[] memory keys = vm.parseJsonKeys(artifactJson, ".facets");
        for (uint256 i; i < keys.length; ++i) {
            address recorded = vm.parseJsonAddress(
                artifactJson,
                string.concat(".facets.", keys[i])
            );
            if (recorded == needle) return true;
        }
        return false;
    }

    // ── 1. Every cut facet reached the artifact ───────────────────────

    /// @notice Every address the live Diamond reports through
    ///         `facetAddresses()` is recorded in the artifact the same deploy
    ///         wrote.
    function test_EveryLoupeFacetAddress_IsRecordedInTheArtifact() public {
        uint256[] memory ids = _chainIds();
        for (uint256 c; c < ids.length; ++c) {
            (address diamond, string memory artifactJson) =
                _deployWritingArtifact("every-loupe-facet-address", ids[c]);

            address[] memory live = IDiamondLoupe(diamond).facetAddresses();
            assertGt(
                live.length,
                0,
                "the loupe reported no facets - the deploy did not build a Diamond"
            );

            for (uint256 i; i < live.length; ++i) {
                assertTrue(
                    _recordedAsFacet(artifactJson, live[i]),
                    string.concat(
                        "on chain ",
                        vm.toString(ids[c]),
                        ": facet at ",
                        vm.toString(live[i]),
                        " is cut into the Diamond but appears under no `.facets.*` key in addresses.json - add its Deployments.writeFacet(...) line to DeployDiamond.s.sol"
                    )
                );
            }
        }
    }

    // ── 2. The facet the enumeration cannot see ───────────────────────

    /// @notice `diamondCutFacet` is recorded too — asserted separately,
    ///         because the enumeration above structurally cannot reach it.
    ///
    /// @dev    `VaipakamDiamond`'s constructor installs that facet by writing
    ///         `selectorToFacetAndPosition[IDiamondCut.diamondCut.selector]
    ///         .facetAddress` DIRECTLY, without pushing into the
    ///         `facetAddresses` array or the per-facet selector list. So
    ///         `facetAddresses()` never reports it, and test 1 above would keep
    ///         its green tick with `writeFacet("diamondCutFacet", …)` deleted —
    ///         leaving the artifact incomplete for the one facet that can never
    ///         be re-cut, since removing the cut function removes the ability to
    ///         cut. (Found by Codex on #1798 r9. The withdrawn `[4c]` carried a
    ///         `cutFacet` exception for this same reason, in its reverse
    ///         direction; the knowledge existed and did not survive into the
    ///         replacement design, which is why it is written down here.)
    ///
    ///         The middle assertion is not decoration. It pins the structural
    ///         claim that makes this test necessary at all: the day
    ///         `diamondCut` starts appearing in the enumeration, this test
    ///         becomes redundant and should say so out loud rather than quietly
    ///         duplicating test 1.
    function test_DiamondCutFacet_IsRecordedAlthoughUnenumerated() public {
        uint256[] memory ids = _chainIds();
        for (uint256 c; c < ids.length; ++c) {
        (address diamond, string memory artifactJson) =
            _deployWritingArtifact("diamond-cut-facet", ids[c]);

        address cutFacet = IDiamondLoupe(diamond).facetAddress(
            IDiamondCut.diamondCut.selector
        );
        assertTrue(
            cutFacet != address(0),
            "diamondCut is not routed - the Diamond cannot be upgraded"
        );

        address[] memory live = IDiamondLoupe(diamond).facetAddresses();
        for (uint256 i; i < live.length; ++i) {
            assertTrue(
                live[i] != cutFacet,
                "facetAddresses() now enumerates the constructor-installed cut facet - test 1 already covers it, so fold this test into that one rather than leaving two"
            );
        }

        assertTrue(
            _recordedAsFacet(artifactJson, cutFacet),
            string.concat(
                "on chain ",
                vm.toString(ids[c]),
                ": diamondCutFacet is installed by the constructor but appears under no `.facets.*` key in addresses.json - facetAddresses() cannot see it, so nothing else would have caught this"
            )
        );
        }
    }

    // ── 3. The redirect refuses rather than quietly meaning something ──

    /// @notice An empty artifact root is refused outright, not read as "the
    ///         default".
    ///
    /// @dev    The test name says only what this asserts, deliberately. The
    ///         OTHER half of the guard — that a redirect is refused anywhere
    ///         but Anvil or `forge test`, because writing an artifact where
    ///         nobody reads it is the #2070 failure in a new hat — CANNOT be
    ///         reached from here: the guard's test-context arm is satisfied by
    ///         the very fact that this is running under `forge test`, whatever
    ///         chain id `vm.chainId` claims. Exercising it needs a live
    ///         broadcast, which no test performs. Naming this function after
    ///         the unreachable half would have been a fixture that passes
    ///         VACUOUSLY while reading as coverage of something else.
    ///
    ///         Both halves refuse by reverting rather than falling back to the
    ///         default, for the same reason: a caller that believed it had
    ///         redirected and had not would assert against the COMMITTED
    ///         artifact and pass for entirely the wrong reason.
    function test_ArtifactRootOverride_RefusesAnEmptyRoot() public {
        DeployDiamond script = new DeployDiamond();

        // Under `forge test` the test-context arm of the guard is satisfied
        // whatever the chain id, so the refusal cannot be reached from here —
        // asserting it would need a live broadcast. What IS reachable, and is
        // the property a caller depends on, is that an empty override is
        // refused outright instead of quietly meaning "the default".
        vm.expectRevert(
            bytes(
                "ArtifactRootBase: artifact root override must be non-empty - pass no override at all to use the committed default"
            )
        );
        script.setArtifactRootOverride("");

        assertEq(
            script.artifactRootOverride(),
            "",
            "a refused override must leave the script on the committed default"
        );
    }

    /// @notice Every root that could resolve to the COMMITTED artifact is
    ///         refused, and none of them by comparing strings to the default.
    ///
    /// @dev    #2253 r1 P2. The first revision decided "is this redirected?"
    ///         by `artifactRoot() != "deployments"`, so each alias below was
    ///         NOT equal, therefore counted as redirected, therefore forced
    ///         writes on — and wrote straight over the committed
    ///         `deployments/anvil/addresses.json` that the redirect exists to
    ///         protect. The fix is not a path normaliser (that predicate is
    ///         unbounded — `.`, `..`, `//`, trailing slashes, symlinks — and
    ///         #1995 is the recorded cost of enumerating one). It is two total
    ///         tests, and these cases pin both.
    function test_ArtifactRootOverride_RefusesAnythingOutsideTheScratchTree()
        public
    {
        DeployDiamond script = new DeployDiamond();

        string[6] memory aliasesOfTheDefault = [
            "deployments",
            "deployments/",
            "./deployments",
            "deployments/.",
            "deployments/anvil",
            "/tmp/somewhere-else"
        ];
        for (uint256 i; i < aliasesOfTheDefault.length; ++i) {
            vm.expectRevert(
                bytes(
                    "ArtifactRootBase: a redirected artifact root must start with deployments/.forge-test/ - any other root can alias the committed artifact, and fs_permissions grants write access under deployments/ only"
                )
            );
            script.setArtifactRootOverride(aliasesOfTheDefault[i]);
        }

        // Inside the scratch tree by prefix, but climbing back out.
        string[3] memory escapes = [
            "deployments/.forge-test/../..",
            "deployments/.forge-test/../../anvil",
            "deployments/.forge-test/a/../../.."
        ];
        for (uint256 i; i < escapes.length; ++i) {
            vm.expectRevert(
                bytes(
                    "ArtifactRootBase: a redirected artifact root must contain no `..` segment - with one it can climb back out of the scratch directory and reach the committed artifact"
                )
            );
            script.setArtifactRootOverride(escapes[i]);
        }

        assertEq(
            script.artifactRootOverride(),
            "",
            "not one of those may have been accepted"
        );

        // `..` is rejected as a SEGMENT, not as a substring: a directory whose
        // name merely contains two dots is legitimate and must still be
        // accepted, or the guard would be refusing safe roots to look strict.
        script.setArtifactRootOverride("deployments/.forge-test/my..dir");
        assertEq(
            script.artifactRootOverride(),
            "deployments/.forge-test/my..dir",
            "a directory name containing `..` is not a parent-directory segment"
        );
    }

    /// @notice The scratch prefix lies inside the committed root.
    ///
    /// @dev    **This is a BOUNDS GUARD, not a behavioural test** — it passes
    ///         whether or not the rest of this file is correct, and would only
    ///         fail if someone edited one of the two constants. It is here
    ///         because `fs_permissions` grants write access under
    ///         `deployments/` and nowhere else: a scratch prefix that drifted
    ///         outside it would fail every redirected write with an FS
    ///         permission error rather than anything self-explanatory.
    function test_BoundsGuard_ScratchPrefixLiesUnderTheCommittedRoot()
        public
        pure
    {
        bytes memory prefix = bytes(ARTIFACT_SCRATCH_PREFIX);
        bytes memory root = bytes(Deployments.ARTIFACT_ROOT);
        assertGt(prefix.length, root.length, "prefix cannot be the root itself");
        for (uint256 i; i < root.length; ++i) {
            assertEq(prefix[i], root[i], "scratch prefix left the committed root");
        }
        assertEq(prefix[root.length], "/", "scratch prefix must be a subdirectory");
    }

    // ── 4. An un-redirected script still writes where it always did ───

    /// @notice A script that sets no override resolves the committed root.
    ///
    /// @dev    The redirect widened a path every production deploy takes, so
    ///         the default has to be pinned too — otherwise a mistake in the
    ///         override plumbing would silently move every real artifact, and
    ///         the only test exercising the path would be the one that asked
    ///         for it to move.
    function test_UnredirectedScript_ResolvesTheCommittedRoot() public {
        DeployDiamond script = new DeployDiamond();
        assertEq(
            script.artifactRootOverride(),
            "",
            "a fresh script must carry no override"
        );
        assertEq(
            Deployments.ARTIFACT_ROOT,
            "deployments",
            "the committed artifact root moved - every deploy script, the frontend export and the census inventory read it"
        );
    }

    // ── 5. The deploy's own verification is wired, not just present ───

    /// @notice `DeployDiamond` actually INVOKES its artifact verification.
    ///
    /// @dev    #2253 r2. Every other test in this file reads the artifact and
    ///         asserts completeness itself, which means all of them stay green
    ///         with the deploy's own check deleted — mutation-checked and
    ///         confirmed: removing `Deployments.finalizeArtifact(diamond)` from
    ///         Step 7b gave "6 passed; 0 failed". The check was correct and
    ///         entirely unguarded.
    ///
    ///         This is the fixture that fails when the CALL SITE goes away. It
    ///         matters more than it looks: the in-deploy check is the whole
    ///         reason the guarantee does not depend on this file's chain matrix
    ///         being complete, so losing the call silently would quietly return
    ///         the guarantee to whatever these tests happen to enumerate.
    function test_TheDeployItself_InvokesArtifactVerification() public {
        string memory root = string.concat(
            _scratchRoot("verification-wired"), "/31337"
        );
        if (vm.isDir(root)) vm.removeDir(root, true);

        DeployDiamondVerificationProbe probe =
            new DeployDiamondVerificationProbe();
        probe.setArtifactRootOverride(root);

        assertFalse(
            probe.verificationRan(),
            "the probe must start un-fired, or its assertion below proves nothing"
        );

        probe.runWith(ADMIN_FOR_HANDOVER, TREASURY, DEPLOYER_KEY);

        assertTrue(
            probe.verificationRan(),
            "DeployDiamond completed without reaching its artifact verification - the completeness guarantee is not wired into the deploy, and every other test in this file would still pass"
        );

        vm.removeDir(root, true);
    }

    // ── 6. A failed verification leaves the artifact as it found it ───

    /// @notice When verification fails, the artifact is restored to what it
    ///         was before the run — not left holding the failed run's writes.
    ///
    /// @dev    #2253 r3 P1, and this is the fixture the fix needs rather than
    ///         the fix the tests happened to have. Every OTHER test in this
    ///         file writes to a scratch root, so none of them would notice the
    ///         restore being deleted; the property only matters for the file a
    ///         later reader trusts.
    ///
    ///         Why it matters on a real deploy: filesystem cheatcode effects
    ///         survive a revert, and a `--broadcast` run executes the whole
    ///         script body in forge's pre-send simulation — the repo's own
    ///         wrapper documents that such a refusal sends no transactions. So
    ///         without the restore, a caught omission leaves the inventory's
    ///         source of truth naming simulated addresses for a Diamond that
    ///         was never deployed. The check would have manufactured a worse
    ///         failure than the silence it exists to end.
    ///
    ///         Two deploys with DIFFERENT deployer keys, so their addresses
    ///         differ and a restore is distinguishable from a no-op.
    function test_FailedVerification_LeavesThePriorArtifactIntact() public {
        string memory root = string.concat(
            _scratchRoot("failed-verification-restores"), "/31337"
        );
        if (vm.isDir(root)) vm.removeDir(root, true);
        string memory artifact = string.concat(root, "/anvil/addresses.json");

        // ── a good deploy, which the artifact should keep describing ──
        DeployDiamond good = new DeployDiamond();
        good.setArtifactRootOverride(root);
        good.runWith(ADMIN_FOR_HANDOVER, TREASURY, DEPLOYER_KEY);
        address firstDiamond = good.diamond();

        assertEq(
            vm.parseJsonAddress(vm.readFile(artifact), ".diamond"),
            firstDiamond,
            "the good deploy did not record its own diamond"
        );

        // ── a deploy that fails verification, from a different deployer ──
        uint256 otherKey = DEPLOYER_KEY + 1;
        DeployDiamondFailingVerificationProbe bad =
            new DeployDiamondFailingVerificationProbe();
        bad.setArtifactRootOverride(root);

        vm.expectRevert();
        bad.runWith(ADMIN_FOR_HANDOVER, TREASURY, otherKey);

        assertEq(
            vm.parseJsonAddress(vm.readFile(artifact), ".diamond"),
            firstDiamond,
            "a failed verification left the artifact describing the FAILED run - the restore is missing, and on a real --broadcast deploy this file would name simulated addresses for a Diamond that was never deployed"
        );

        vm.removeDir(root, true);
    }

    // ── 7. A re-deploy does not inherit the previous run's facet keys ─

    /// @notice Deploying twice into the SAME artifact leaves `.facets`
    ///         describing only the second run.
    ///
    /// @dev    #2253 r5 P2. The typed writers MERGE into the existing file, so
    ///         without `clearFacets()` a second deploy inherits the first run's
    ///         keys — and on the documented fresh-Anvil workflow
    ///         (`anvil-bootstrap.sh` restarts the chain and reuses the fixed
    ///         default deployer) the CREATE addresses REPEAT, so a deleted
    ///         `writeFacet` leaves a matching stale value and the completeness
    ///         scan passes for a facet the run never recorded.
    ///
    ///         **A SEEDED key is what makes this test able to fail, and the
    ///         first version of it could not.** That version deployed twice
    ///         from different deployer keys and asserted no first-run address
    ///         survived — which passes with or without the clear, because both
    ///         runs write the SAME key set, so every key is overwritten and
    ///         merge is indistinguishable from replace. Mutation-checking
    ///         caught it: deleting the wipe left all nine tests green. Staleness
    ///         is only observable through a key the second run does NOT write,
    ///         which is precisely the #1798 shape — a `writeFacet` line that
    ///         went missing. So one is planted.
    ///
    ///         The extra key does not make the deploy fail on its own: the
    ///         completeness check requires every INSTALLED facet to be recorded
    ///         and is indifferent to additional keys. That asymmetry is the
    ///         whole reason a stale key is dangerous rather than loud, and the
    ///         reason clearing is the fix.
    function test_Redeploy_DoesNotInheritThePriorRunsFacetKeys() public {
        string memory root = string.concat(
            _scratchRoot("redeploy-clears-facets"), "/31337"
        );
        if (vm.isDir(root)) vm.removeDir(root, true);
        string memory artifact = string.concat(root, "/anvil/addresses.json");

        DeployDiamond first = new DeployDiamond();
        first.setArtifactRootOverride(root);
        first.runWith(ADMIN_FOR_HANDOVER, TREASURY, DEPLOYER_KEY);
        assertGt(
            IDiamondLoupe(first.diamond()).facetAddresses().length,
            0,
            "first deploy built no Diamond"
        );

        // A facet the FIRST run recorded under a key the second run does not
        // write — the `writeFacet` line that went missing in #1798, planted so
        // the second run has something to leave behind.
        address ghost = address(0xF05511);
        vm.writeJson(vm.toString(ghost), artifact, ".facets.retiredFacet");
        assertTrue(
            _recordedAsFacet(vm.readFile(artifact), ghost),
            "the seeded stale key did not take - the rest of this test would prove nothing"
        );

        // Deliberately NOT clearing the root: this is the re-deploy case.
        DeployDiamond second = new DeployDiamond();
        second.setArtifactRootOverride(root);
        second.runWith(ADMIN_FOR_HANDOVER, TREASURY, DEPLOYER_KEY + 1);

        string memory json = vm.readFile(artifact);
        assertFalse(
            _recordedAsFacet(json, ghost),
            "the artifact still carries a facet key the second deploy never wrote - `.facets` was not cleared, so it describes two Diamonds at once and the completeness scan can pass on a stale value"
        );

        address[] memory secondFacets =
            IDiamondLoupe(second.diamond()).facetAddresses();
        for (uint256 i; i < secondFacets.length; ++i) {
            assertTrue(
                _recordedAsFacet(json, secondFacets[i]),
                "the second deploy's own facet is missing after the clear"
            );
        }

        vm.removeDir(root, true);
    }
}
