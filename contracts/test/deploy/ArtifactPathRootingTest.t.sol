// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {
    ArtifactRootBase,
    ARTIFACT_SCRATCH_PREFIX
} from "../../script/lib/ArtifactRoot.sol";
import {RewardCustodyCeremonyBase} from
    "../../script/lib/RewardCustodyCeremonyBase.sol";

/**
 * @notice Exposes the library's path helpers from a contract that CAN carry an
 *         artifact-root override, which is the only context where the rooting
 *         is observable.
 *
 * @dev    `Deployments`' helpers are `internal`, so they execute in the
 *         caller's context and resolve the root by asking `address(this)` for
 *         an override. A plain test contract does not implement
 *         {IArtifactRoot}, so calling them from one always falls through to the
 *         committed root and proves nothing.
 */
contract PathProbe is ArtifactRootBase {
    function namedPath(string memory fileName)
        external
        view
        returns (string memory)
    {
        return Deployments.namedPath(fileName);
    }

    function pathForSlug(string memory slug)
        external
        view
        returns (string memory)
    {
        return Deployments.pathForSlug(slug);
    }

    function addressesPath() external view returns (string memory) {
        return Deployments.path();
    }
}

/**
 * @notice The ceremony record's CALL SITE, in a redirectable context.
 *
 * @dev    `RewardCustodyCeremonyBase` is `abstract` with no unimplemented
 *         members — it is abstract to stop direct instantiation, not because
 *         anything is missing — so a probe only has to extend it. It also is
 *         NOT an {IArtifactRoot}, which is why this probe mixes one in: without
 *         that, `_recordPath` resolves the committed root no matter what the
 *         library does, and this test would pass against the hardcoded string
 *         it exists to catch.
 */
contract CeremonyPathProbe is RewardCustodyCeremonyBase, ArtifactRootBase {
    function recordPath(string memory kind)
        external
        view
        returns (string memory)
    {
        return _recordPath(kind);
    }
}

/**
 * @title  ArtifactPathRootingTest
 * @notice Issue #2261 — every per-chain artifact path resolves through
 *         `Deployments.artifactRoot()`, so a redirected run cannot write into
 *         the committed inventory.
 *
 * @dev    **Why this exists.** #2253 gave `Deployments` a redirectable artifact
 *         root so a test could run a real script without overwriting the
 *         committed tree, and consolidated the paths that carry ADDRESSES into
 *         one builder. Four scripts stayed outside that consolidation because
 *         they built `"deployments/" + slug + "/…"` themselves — two writing
 *         ceremony records, two reading `addresses.json`. A redirected run
 *         would have sent those to the canonical tree while everything else
 *         from the same run went to the scratch tree.
 *
 *         **What these tests can and cannot prove.** The library helpers are
 *         covered directly. The ceremony record's CALL SITE is covered too,
 *         through a probe — revert `_recordPath` to a hardcoded
 *         `"deployments/"` and `test_CeremonyRecord_FollowsTheRedirect` fails.
 *         The two `addresses.json` readers (`Handover._resolveAddressesPath`,
 *         `RefreshAllFacetsInPlace._readAddrOptional`) are NOT covered: both
 *         are `internal` on scripts that do not implement {IArtifactRoot}, so a
 *         probe would have to grant them a capability they do not have, and the
 *         test would then be asserting the probe's wiring rather than theirs.
 *         They are correct by construction — the hand-built root is gone — and
 *         that is stated rather than dressed up as coverage.
 *
 *         **What the sweep leaves behind, and why none of it is a defect.**
 *         `grep -rn '"deployments/' contracts/script/` still returns matches
 *         after this change; they are accounted for here so the next sweeper
 *         does not re-file them. `ARTIFACT_SCRATCH_PREFIX` names the redirect
 *         target itself. `ARCHIVE_MANIFEST` is the COMMITTED publication
 *         ledger, and the only code that reads it returns early when the
 *         artifact root is redirected — it is deliberately outside the
 *         redirect, because a scratch run has no publication to match against.
 *         `SepoliaOpenOffers` has the string inside an error message telling a
 *         human where to look. And the shell wrappers (`deploy-chain.sh`,
 *         `redeploy-testnet-inplace.sh`) build the committed path directly:
 *         the redirect is a Solidity-side, test-only capability those scripts
 *         cannot carry at all.
 */
contract ArtifactPathRootingTest is Test {
    function _scratchRoot(string memory name)
        internal
        pure
        returns (string memory)
    {
        return string.concat(ARTIFACT_SCRATCH_PREFIX, name);
    }

    // ── The named-artifact helper ─────────────────────────────────────

    /// @notice A named artifact lands under the redirected root, not the
    ///         committed one.
    function test_NamedPath_FollowsTheRedirect() public {
        PathProbe probe = new PathProbe();
        string memory root = _scratchRoot("named-path");
        probe.setArtifactRootOverride(root);

        string memory got = probe.namedPath("reward-custody-activated.json");

        assertEq(
            got,
            string.concat(root, "/", Deployments.chainSlug(), "/reward-custody-activated.json"),
            "a named artifact must sit beside addresses.json under the ACTIVE root"
        );
        assertTrue(
            !_startsWith(got, "deployments/anvil"),
            "a redirected run resolved a path into the committed tree"
        );
    }

    /// @notice With no override the committed root is resolved — the ordinary
    ///         operator case, pinned so the redirect support cannot quietly
    ///         change where real deploys write.
    ///
    /// @dev    BOUNDS GUARD: passes with or without the #2261 change, because
    ///         the hand-built string and the helper agree when the root is the
    ///         default. It is here to pin the default, not to catch the bug.
    function test_NamedPath_UnredirectedResolvesTheCommittedRoot() public {
        PathProbe probe = new PathProbe();
        assertEq(
            probe.namedPath("x.json"),
            string.concat("deployments/", Deployments.chainSlug(), "/x.json"),
            "an unredirected run must write beside the committed addresses.json"
        );
    }

    // ── The slug-addressed helper ─────────────────────────────────────

    /// @notice `pathForSlug` exists because one caller resolves its chain from
    ///         `CHAIN_SLUG` rather than `block.chainid`; it must still root.
    function test_PathForSlug_FollowsTheRedirect() public {
        PathProbe probe = new PathProbe();
        string memory root = _scratchRoot("slug-path");
        probe.setArtifactRootOverride(root);

        assertEq(
            probe.pathForSlug("base-sepolia"),
            string.concat(root, "/base-sepolia/addresses.json"),
            "a slug-addressed path must resolve through the active root"
        );
    }

    /// @notice The slug-addressed and chain-id-addressed helpers agree for the
    ///         active chain, so the two layers cannot drift.
    function test_SlugAndChainIdHelpersAgree() public {
        PathProbe probe = new PathProbe();
        string memory root = _scratchRoot("layer-agreement");
        probe.setArtifactRootOverride(root);

        assertEq(
            probe.pathForSlug(Deployments.chainSlug()),
            probe.addressesPath(),
            "pathForSlug and path() disagree for the active chain - the path API has two roots again"
        );
    }

    // ── The ceremony record's CALL SITE ───────────────────────────────

    /// @notice The reward-custody ceremony record resolves through the active
    ///         root.
    ///
    /// @dev    THE MUTATION TARGET of this file. Restore
    ///         `RewardCustodyCeremonyBase._recordPath`'s
    ///         `string.concat("deployments/", …)` and this fails, because the
    ///         probe carries an override the hardcoded string ignores.
    function test_CeremonyRecord_FollowsTheRedirect() public {
        CeremonyPathProbe probe = new CeremonyPathProbe();
        string memory root = _scratchRoot("ceremony-record");
        probe.setArtifactRootOverride(root);

        assertEq(
            probe.recordPath("bind"),
            string.concat(root, "/", Deployments.chainSlug(), "/reward-custody-bind.json"),
            "the ceremony record ignored the artifact-root override - a redirected run would write it into the committed tree"
        );
    }

    // ── helpers ───────────────────────────────────────────────────────

    function _startsWith(string memory s, string memory prefix)
        private
        pure
        returns (bool)
    {
        bytes memory b = bytes(s);
        bytes memory p = bytes(prefix);
        if (p.length > b.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }
}
