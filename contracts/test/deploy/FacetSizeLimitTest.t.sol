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

    /// @dev #1842 — headroom below which a facet is reported as CRITICAL
    ///      rather than merely near the limit.
    ///
    ///      The warn band above turned the pass/fail wall into a gradient,
    ///      which was the right move and is not what this adds. What it does
    ///      not do is RANK: measuring at `0501225c9` put SEVEN facets inside
    ///      1 KB, and in a flat list the one with 32 bytes left reads exactly
    ///      like the one with 1,008 — a report that lists without ordering,
    ///      when the whole point is to be read at a glance by someone who has
    ///      not been thinking about facet sizes.
    ///
    ///      256 bytes is chosen against what the band is FOR: a facet is out
    ///      of room when the next ordinary change will not fit, and a guard
    ///      plus its custom error is on the order of a couple of hundred
    ///      bytes. `EarlyWithdrawalFacet` had 30 bytes when #1780 had to split
    ///      it; #1835's deferred guard is 164 bytes against exactly 164 bytes
    ///      free on `OfferAcceptFacet`. Both sit well inside this tier, and
    ///      both were already blocking work by the time anyone measured.
    ///
    ///      Still a REPORT, for the reason the warn band is: a facet may
    ///      legitimately run close for a while, and failing here would train
    ///      people to raise the threshold rather than read it.
    uint256 internal constant HEADROOM_CRITICAL_BYTES = 256;

    /// @notice Every facet's runtime bytecode must be within EIP-170.
    function test_EveryFacetUnderEip170SizeLimit() public view {
        string[76] memory facets = cutFacetNames();
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
        string[76] memory facets = cutFacetNames();

        // TWO passes, critical band first (#1842). The report is read top
        // down by someone who did not come looking for it, so the facets
        // that are actually out of room have to be the first lines — a
        // single pass in `cutFacetNames()` order buries a 32-byte facet
        // under whatever happens to precede it alphabetically.
        uint256 critical = _reportBand(facets, 0, HEADROOM_CRITICAL_BYTES, "CRITICAL");
        uint256 near = _reportBand(
            facets, HEADROOM_CRITICAL_BYTES, HEADROOM_WARN_BYTES, "near limit"
        );

        if (critical + near == 0) {
            console.log("facet headroom: all facets have >= 1024 bytes free");
        } else {
            console.log(
                "facet headroom: %s CRITICAL (< 256 bytes), %s more within 1024",
                critical,
                near
            );
        }
    }

    /// @dev Report every facet whose headroom is in `[lo, hi)`, tagged with
    ///      `label`. Returns the count so the caller can summarise.
    ///      `DiamondCutFacet` is checked alongside the cut list for the same
    ///      reason the limit test checks it: the Diamond's constructor
    ///      installs it, so it never appears in `cutFacetNames()`.
    function _reportBand(
        string[76] memory facets,
        uint256 lo,
        uint256 hi,
        string memory label
    ) private view returns (uint256 found) {
        for (uint256 i; i < facets.length; ++i) {
            if (_reportIfInBand(facets[i], lo, hi, label)) ++found;
        }
        if (_reportIfInBand("DiamondCutFacet", lo, hi, label)) ++found;
    }

    /// @dev Log `facet` when its remaining headroom falls in `[lo, hi)`.
    ///      Returns whether it was reported, so the caller can summarise.
    ///      Half-open on purpose: the bands must partition, or a facet
    ///      exactly at the critical threshold would be counted in both and
    ///      the summary would not add up to the number of lines above it.
    function _reportIfInBand(
        string memory facet,
        uint256 lo,
        uint256 hi,
        string memory label
    ) private view returns (bool) {
        bytes memory code = vm.getDeployedCode(
            string.concat(facet, ".sol:", facet)
        );
        // Over the limit is the size TEST's business, not the report's —
        // it fails there with a message naming the breach, and reporting it
        // here as well would double-count it as a headroom warning.
        if (code.length == 0 || code.length > EIP170_LIMIT) return false;
        uint256 headroom = EIP170_LIMIT - code.length;
        if (headroom < lo || headroom >= hi) return false;
        console.log("  %s: %s at %s bytes", label, facet, code.length);
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
