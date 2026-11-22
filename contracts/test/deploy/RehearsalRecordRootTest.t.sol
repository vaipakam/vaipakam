// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {
    RecordRoot,
    recordRootRule,
    recordRootRefusal,
    rehearsalMode,
    unredirectedRecordRoot,
    REHEARSAL_SCRATCH_PREFIX,
    ARTIFACT_SCRATCH_PREFIX
} from "../../script/lib/ArtifactRoot.sol";

/**
 * @notice The record-root rule of a deploy rehearsal (#3891, deploy rehearsal
 *         design §11, §13, §20 tests 1-3), over every combination of its four
 *         inputs.
 *
 * @dev    The rule is a pure function so this suite never touches the process
 *         environment, which every parallel test shares. What the rule cannot
 *         see from here (a real `forge script` run reading the flag and the
 *         marker from a live node) is driven end to end by
 *         `script/rehearsal-seam.test.sh` against a local node.
 */
contract RehearsalRecordRootTest is Test {
    string internal constant ROOT = "deployments/.forge-test/rehearsal/run-1";

    function test_UnderTestTheEnvironmentIsNeverConsulted() public pure {
        // Every flag, marker and root combination resolves to the committed
        // root under `forge test`.
        bool[2] memory bools = [false, true];
        string[3] memory roots = ["", ROOT, "/etc"];
        for (uint256 f; f < 2; ++f) {
            for (uint256 m; m < 2; ++m) {
                for (uint256 r; r < 3; ++r) {
                    assertEq(
                        uint8(recordRootRule(true, bools[f], bools[m], roots[r])),
                        uint8(RecordRoot.Committed)
                    );
                }
            }
        }
    }

    function test_RealChainWithoutFlagIsCommitted() public pure {
        assertEq(uint8(recordRootRule(false, false, false, "")), uint8(RecordRoot.Committed));
        // A stray root without the flag changes nothing.
        assertEq(uint8(recordRootRule(false, false, false, ROOT)), uint8(RecordRoot.Committed));
    }

    /// §20 test 1: the flag against a node without the marker is refused.
    function test_FlagWithoutMarkerIsRefused() public pure {
        assertEq(
            uint8(recordRootRule(false, true, false, ROOT)), uint8(RecordRoot.RefuseFlagWithoutMarker)
        );
    }

    /// §20 tests 2 and 3: a marker node that is not rehearsing never reaches
    /// the committed records.
    function test_MarkerWithoutFlagIsRefused() public pure {
        assertEq(
            uint8(recordRootRule(false, false, true, "")), uint8(RecordRoot.RefuseMarkerWithoutRehearsal)
        );
        assertEq(
            uint8(recordRootRule(false, false, true, ROOT)), uint8(RecordRoot.RefuseMarkerWithoutRehearsal)
        );
    }

    function test_FlagWithoutRootIsRefused() public pure {
        assertEq(uint8(recordRootRule(false, true, true, "")), uint8(RecordRoot.RefuseFlagWithoutRoot));
    }

    function test_RootOutsideTheRehearsalScratchIsRefused() public pure {
        string[6] memory bad = [
            "deployments",
            "deployments/base-sepolia",
            // The general scratch prefix is not enough: a rehearsal gets its own.
            "deployments/.forge-test/e2e",
            "deployments/.forge-test/rehearsal",
            "deployments/.forge-test/rehearsal/../../base-sepolia",
            "/tmp/deployments/.forge-test/rehearsal/run"
        ];
        for (uint256 i; i < bad.length; ++i) {
            assertEq(
                uint8(recordRootRule(false, true, true, bad[i])),
                uint8(RecordRoot.RefuseRootOutsideScratch),
                bad[i]
            );
        }
    }

    function test_FlagMarkerAndScratchRootIsRehearsal() public pure {
        assertEq(uint8(recordRootRule(false, true, true, ROOT)), uint8(RecordRoot.Rehearsal));
    }

    function test_RehearsalPrefixSitsInsideTheScratchPrefix() public pure {
        bytes memory a = bytes(ARTIFACT_SCRATCH_PREFIX);
        bytes memory r = bytes(REHEARSAL_SCRATCH_PREFIX);
        assertGt(r.length, a.length);
        for (uint256 i; i < a.length; ++i) assertEq(r[i], a[i]);
    }

    function test_EveryRefusalHasText() public pure {
        assertEq(bytes(recordRootRefusal(RecordRoot.Committed)).length, 0);
        assertEq(bytes(recordRootRefusal(RecordRoot.Rehearsal)).length, 0);
        for (uint8 r = uint8(RecordRoot.RefuseFlagWithoutMarker); r <= uint8(RecordRoot.RefuseMarkerWithoutRehearsal); ++r) {
            assertGt(bytes(recordRootRefusal(RecordRoot(r))).length, 40);
        }
    }

    function test_UnderForgeTestTheRunIsNeverARehearsal() public view {
        assertFalse(rehearsalMode());
        assertEq(bytes(unredirectedRecordRoot()).length, 0);
    }
}
