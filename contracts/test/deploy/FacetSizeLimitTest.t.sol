// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {DiamondFacetNames} from "./DiamondFacetNames.sol";

/**
 * @title FacetSizeLimitTest
 * @notice Issue #66 guardrail — asserts every Diamond facet's runtime
 *         bytecode stays under the EIP-170 24,576-byte contract-size
 *         limit.
 * @dev    A facet over the limit cannot be deployed on anvil or any
 *         real chain — `forge script DeployDiamond --broadcast` reverts.
 *         `forge test` does NOT enforce the EIP-170 *deploy-size* rule,
 *         so without this guardrail an over-size facet stays invisible
 *         until an actual `--broadcast` deploy fails. That is exactly
 *         how RiskFacet's 541-byte breach reached `main` unnoticed
 *         (Issue #66). This test makes the breach fail in the regular
 *         `forge test` run instead.
 *
 *         The runtime bytecode is read with `vm.getDeployedCode` — no
 *         deployment, so the EIP-170 limit is not what's being measured
 *         by the EVM here; the test measures the artifact directly.
 *
 *         The facet set comes from the shared `DiamondFacetNames` list
 *         (the `test/deploy/` deploy-sanity suite's single source of
 *         truth) — when a facet is added to the Diamond, update
 *         `cutFacetNames()` there and this guardrail picks it up.
 */
contract FacetSizeLimitTest is Test, DiamondFacetNames {
    /// @dev EIP-170 maximum runtime contract size, in bytes.
    uint256 internal constant EIP170_LIMIT = 24_576;

    /// @dev #1780 — headroom below which a facet is REPORTED (not failed).
    ///      The pass/fail contract above is a wall: a facet at 24,575 bytes
    ///      looks exactly like one at 12,000 until the day someone goes over,
    ///      and then it is whoever wrote the next correct change who discovers
    ///      it. Measuring in August 2026 found TWO facets frozen within ~30
    ///      bytes of the limit and three more inside 600 — none of it visible
    ///      from a green run. This turns the wall into a gradient: the run
    ///      names the tight facets every time, so the squeeze is known before
    ///      it blocks a PR rather than after.
    ///
    ///      1 KB ≈ several guards-plus-custom-errors of margin. Deliberately
    ///      a REPORT and not an assertion: a facet legitimately sits close to
    ///      the limit for a while, and failing the suite for that would train
    ///      people to raise the threshold rather than read it.
    uint256 internal constant HEADROOM_WARN_BYTES = 1_024;

    /// @notice Every facet's runtime bytecode must be within EIP-170.
    function test_EveryFacetUnderEip170SizeLimit() public view {
        string[72] memory facets = cutFacetNames();
        for (uint256 i; i < facets.length; ++i) {
            _assertUnderLimit(facets[i]);
        }
        // `DiamondCutFacet` is installed by the `VaipakamDiamond`
        // constructor, not via a cut list, so it is absent from
        // `cutFacetNames()` — size-check it explicitly here.
        _assertUnderLimit("DiamondCutFacet");
    }

    /// @notice #1780 — report every facet within {HEADROOM_WARN_BYTES} of the
    ///         EIP-170 limit, so a facet running out of room is visible in a
    ///         normal `forge test -vv` run instead of surfacing as a failed
    ///         deploy gate on someone else's PR.
    /// @dev    Always passes. Run with `-vv` to see the lines; a facet that is
    ///         actually OVER the limit is failed by the test above, which is
    ///         where enforcement belongs.
    function test_ReportFacetsNearSizeLimit() public view {
        string[72] memory facets = cutFacetNames();
        uint256 tight;
        for (uint256 i; i < facets.length; ++i) {
            if (_reportIfNearLimit(facets[i])) ++tight;
        }
        if (_reportIfNearLimit("DiamondCutFacet")) ++tight;
        if (tight == 0) {
            console.log(
                "facet headroom: all facets have >= 1024 bytes free"
            );
        } else {
            console.log("facet headroom: %s facet(s) within 1024 bytes of EIP-170", tight);
        }
    }

    /// @dev Log `facet` when its remaining headroom is under the threshold.
    ///      Returns whether it was reported, so the caller can summarise.
    function _reportIfNearLimit(string memory facet)
        private
        view
        returns (bool)
    {
        bytes memory code = vm.getDeployedCode(
            string.concat(facet, ".sol:", facet)
        );
        if (code.length == 0 || code.length > EIP170_LIMIT) return false;
        uint256 headroom = EIP170_LIMIT - code.length;
        if (headroom >= HEADROOM_WARN_BYTES) return false;
        console.log(
            "  NEAR LIMIT: %s at %s bytes", facet, code.length
        );
        console.log("              %s bytes headroom", headroom);
        return true;
    }

    /// @dev Assert a single facet's runtime bytecode is within EIP-170.
    function _assertUnderLimit(string memory facet) private view {
        bytes memory code = vm.getDeployedCode(
            string.concat(facet, ".sol:", facet)
        );
        assertGt(
            code.length, 0, string.concat(facet, " artifact not found")
        );
        assertLe(
            code.length,
            EIP170_LIMIT,
            string.concat(
                facet,
                " runtime bytecode exceeds the EIP-170 24,576-byte limit"
            )
        );
    }
}
