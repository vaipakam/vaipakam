// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Deployments} from "../../script/lib/Deployments.sol";

/**
 * @title DeploymentsPublicationGateTest
 * @notice #1566 (Codex #2070 r26 P1) — the artifact's identity-bearing keys
 *         (`diamond`, `vpfiToken`, `vpfiMirror`, `chainId`, `deployBlock`)
 *         may only be written by a deploy that has MARKED its live
 *         publication in `deployments/archive-manifest.json` and exported the
 *         same token. This pins the gate itself, not a write: every case calls
 *         {Deployments.requireMarkedPublication} / {publicationMarked}
 *         directly, so nothing under `deployments/` is ever touched by the
 *         test — the gate runs BEFORE the file is created, and the test
 *         inherits that ordering by never reaching a writer.
 *
 *         Runs in the `cifast` lane (`test/deploy/**`).
 */
contract DeploymentsPublicationGateTest is Test {
    string constant TOKEN = "12345-1757400000-4242";

    function _manifest(string memory slug, string memory token) internal pure returns (string memory) {
        return string.concat(
            '{"schema":1,"liveGeneration":3,"entries":[],"livePublicationsInProgress":{"',
            slug,
            '":{"token":"',
            token,
            '","pid":12345,"startedAt":"2026-09-09T00:00:00Z"}}}'
        );
    }

    // ── the predicate ────────────────────────────────────────────────────

    function test_PredicateMatchesTokenForHyphenatedSlug() public view {
        assertTrue(Deployments.publicationMarked(_manifest("base-sepolia", TOKEN), "base-sepolia", TOKEN));
    }

    function test_PredicateRefusesWrongToken() public view {
        assertFalse(Deployments.publicationMarked(_manifest("base-sepolia", TOKEN), "base-sepolia", "other"));
    }

    function test_PredicateRefusesOtherChainsMarker() public view {
        assertFalse(Deployments.publicationMarked(_manifest("sepolia", TOKEN), "base-sepolia", TOKEN));
    }

    function test_PredicateRefusesManifestWithoutMarkerSection() public view {
        // The committed shape between deploys: no `livePublicationsInProgress` at all.
        assertFalse(Deployments.publicationMarked('{"schema":1,"liveGeneration":3,"entries":[]}', "base-sepolia", TOKEN));
    }

    function test_PredicateRefusesEmptyToken() public view {
        assertFalse(Deployments.publicationMarked(_manifest("base-sepolia", ""), "base-sepolia", ""));
    }

    // ── the gate ─────────────────────────────────────────────────────────

    function test_IdentityKeysAreExactlyTheCensusInventoryKeys() public pure {
        assertTrue(Deployments.isIdentityKey(".diamond"));
        assertTrue(Deployments.isIdentityKey(".vpfiToken"));
        assertTrue(Deployments.isIdentityKey(".vpfiMirror"));
        assertTrue(Deployments.isIdentityKey(".chainId"));
        assertTrue(Deployments.isIdentityKey(".deployBlock"));
        assertFalse(Deployments.isIdentityKey(".facets.loanFacet"));
        assertFalse(Deployments.isIdentityKey(".vpfiTokenImpl"));
        assertFalse(Deployments.isIdentityKey(".isCanonicalReward"));
    }

    /// @dev ONE sequential test for every env-dependent case: `vm.setEnv`
    ///      writes the PROCESS env, which the parallel tests of a contract
    ///      share — split into four tests, the no-token case read the token a
    ///      sibling had just exported. Same reason DeployDiamondIntegrationTest
    ///      keeps `DEPLOY_SKIP_ARTIFACTS` handling in one place.
    function test_GateSequence_NoTokenThenTokenWithoutMarker() public {
        // ── no token exported ────────────────────────────────────────────
        vm.setEnv("VAIPAKAM_LIVE_PUBLICATION_TOKEN", "");
        vm.chainId(84532);
        // non-identity keys are never gated (in-place refresh writes them)
        Deployments.requireMarkedPublication(".facets.loanFacet");
        Deployments.requireMarkedPublication(".isCanonicalReward");
        // every identity key refuses
        vm.expectRevert(bytes(_needsMarkedMessage(".diamond")));
        this.gate(".diamond");
        vm.expectRevert(bytes(_needsMarkedMessage(".deployBlock")));
        this.gate(".deployBlock");
        vm.expectRevert(bytes(_needsMarkedMessage(".chainId")));
        this.gate(".chainId");
        // the local Anvil chain is exempt (artifact gitignored, NOT_A_DEPLOYMENT in the census)
        vm.chainId(31337);
        Deployments.requireMarkedPublication(".diamond");

        // ── token exported, but nothing marked ───────────────────────────
        // Reads the REAL committed manifest: between deploys it holds no
        // in-progress marker, so an exported token alone must not pass.
        vm.chainId(84532);
        vm.setEnv("VAIPAKAM_LIVE_PUBLICATION_TOKEN", TOKEN);
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deployments: VAIPAKAM_LIVE_PUBLICATION_TOKEN does not match an in-progress live-publication marker for base-sepolia in ",
                    Deployments.ARCHIVE_MANIFEST,
                    " - the token must come from archive-manifest.mjs live-begin in the same deploy run"
                )
            )
        );
        this.gate(".deployBlock");
        vm.setEnv("VAIPAKAM_LIVE_PUBLICATION_TOKEN", "");
    }

    /// @dev External hop so `expectRevert` observes a library-internal revert.
    function gate(string memory jsonKey) external view {
        Deployments.requireMarkedPublication(jsonKey);
    }

    function _needsMarkedMessage(string memory jsonKey) internal pure returns (string memory) {
        return string.concat(
            "Deployments: writing ",
            jsonKey,
            " changes the census inventory and needs a MARKED live publication - run through deploy-chain.sh / deploy-testnet.sh / deploy-mainnet.sh (they run archive-manifest.mjs live-begin and export VAIPAKAM_LIVE_PUBLICATION_TOKEN), or set DEPLOY_SKIP_ARTIFACTS=true to broadcast without writing the artifact"
        );
    }
}
