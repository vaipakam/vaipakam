// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {Deployments} from "../../script/lib/Deployments.sol";
import {ArtifactRootBase, ARTIFACT_SCRATCH_PREFIX} from "../../script/lib/ArtifactRoot.sol";

/**
 * @title DeploymentsFacetsNamespaceTest
 * @notice #2263 — `Deployments.writeFacet` is the only door into the
 *         artifact's `.facets` namespace. The generic writers (`writeAddress`,
 *         `writeUint`, `writeBool`, `writeString`) refuse any key inside it,
 *         and `writeFacet` refuses a key that is not one path segment.
 *
 *         The boundary is straddled with REAL writes into a redirected scratch
 *         artifact: `writeFacet` lands its address under `.facets.<key>`, the
 *         equivalent generic write reverts before anything is written, and a
 *         generic key outside the namespace is written as before.
 *
 *         Runs in the `cifast` lane (`test/deploy/**`).
 */
contract DeploymentsFacetsNamespaceTest is Test, ArtifactRootBase {
    /// @dev One scratch root PER TEST: forge runs a contract's tests in
    ///      parallel, and a shared directory would let one test's file satisfy
    ///      (or its cleanup break) another's assertion.
    function _redirect(string memory testName) internal returns (string memory root) {
        root = string.concat(ARTIFACT_SCRATCH_PREFIX, "facets-namespace/", testName);
        if (vm.isDir(root)) vm.removeDir(root, true);
        setArtifactRootOverride(root);
    }

    // ── external wrappers, so a revert is observable by expectRevert ──────

    function writeFacet(string memory key, address a) external {
        Deployments.writeFacet(key, a);
    }

    function writeAddress(string memory key, address a) external {
        Deployments.writeAddress(key, a);
    }

    function writeUint(string memory key, uint256 v) external {
        Deployments.writeUint(key, v);
    }

    function writeBool(string memory key, bool v) external {
        Deployments.writeBool(key, v);
    }

    function writeString(string memory key, string memory v) external {
        Deployments.writeString(key, v);
    }

    function _artifact() internal view returns (string memory) {
        return vm.readFile(Deployments.path());
    }

    // ── the predicate ────────────────────────────────────────────────────

    function test_NamespacePredicate() public pure {
        assertTrue(Deployments.isFacetsNamespaceKey(".facets"));
        assertTrue(Deployments.isFacetsNamespaceKey(".facets.loanFacet"));
        assertTrue(Deployments.isFacetsNamespaceKey(".facets[0]"));
        assertTrue(Deployments.isFacetsNamespaceKey("$.facets"));
        assertTrue(Deployments.isFacetsNamespaceKey("$.facets.loanFacet"));
        // same letters, different key
        assertFalse(Deployments.isFacetsNamespaceKey(".facetCount"));
        assertFalse(Deployments.isFacetsNamespaceKey(".facetsArchive"));
        assertFalse(Deployments.isFacetsNamespaceKey(".facet"));
        assertFalse(Deployments.isFacetsNamespaceKey(".rewardMessengerImpl"));
        assertFalse(Deployments.isFacetsNamespaceKey(""));
        assertFalse(Deployments.isFacetsNamespaceKey("$"));
    }

    // ── the boundary, with real writes ───────────────────────────────────

    function test_WriteFacetIsTheOnlyDoorIntoFacets() public {
        string memory root = _redirect("only-door");
        address impl = address(0xFACE7);

        // the sanctioned door writes
        this.writeFacet("loanFacet", impl);
        assertEq(vm.parseJsonAddress(_artifact(), ".facets.loanFacet"), impl);

        // the generic writers refuse the same namespace, before writing
        address other = address(0xBAD);
        vm.expectRevert(
            abi.encodeWithSelector(Deployments.FacetsNamespaceReserved.selector, ".facets.loanFacet")
        );
        this.writeAddress(".facets.loanFacet", other);
        vm.expectRevert(
            abi.encodeWithSelector(Deployments.FacetsNamespaceReserved.selector, ".facets.ghostFacet")
        );
        this.writeAddress(".facets.ghostFacet", other);
        vm.expectRevert(abi.encodeWithSelector(Deployments.FacetsNamespaceReserved.selector, ".facets"));
        this.writeUint(".facets", 1);
        vm.expectRevert(
            abi.encodeWithSelector(Deployments.FacetsNamespaceReserved.selector, "$.facets.loanFacet")
        );
        this.writeBool("$.facets.loanFacet", true);
        vm.expectRevert(
            abi.encodeWithSelector(Deployments.FacetsNamespaceReserved.selector, ".facets.loanFacet")
        );
        this.writeString(".facets.loanFacet", "x");

        // nothing the refused calls carried reached the artifact
        string memory json = _artifact();
        assertEq(vm.parseJsonAddress(json, ".facets.loanFacet"), impl);
        assertFalse(vm.keyExistsJson(json, ".facets.ghostFacet"));

        // a generic key outside the namespace is unaffected
        this.writeAddress(".rewardMessengerImpl", other);
        this.writeUint(".facetCount", 7);
        json = _artifact();
        assertEq(vm.parseJsonAddress(json, ".rewardMessengerImpl"), other);
        assertEq(vm.parseJsonUint(json, ".facetCount"), 7);

        vm.removeDir(root, true);
    }

    function test_WriteFacetRefusesAKeyThatIsNotOneSegment() public {
        _redirect("malformed-key");
        address impl = address(0xFACE7);
        vm.expectRevert(abi.encodeWithSelector(Deployments.FacetKeyMalformed.selector, ""));
        this.writeFacet("", impl);
        vm.expectRevert(abi.encodeWithSelector(Deployments.FacetKeyMalformed.selector, "loanFacet.impl"));
        this.writeFacet("loanFacet.impl", impl);
        vm.expectRevert(abi.encodeWithSelector(Deployments.FacetKeyMalformed.selector, "loanFacet[0]"));
        this.writeFacet("loanFacet[0]", impl);
        // a refused key wrote nothing: the artifact was never even created
        assertFalse(vm.isFile(Deployments.path()));
    }
}
