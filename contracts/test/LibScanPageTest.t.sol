// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {LibScanPage} from "../src/libraries/LibScanPage.sol";

/// @title LibScanPageTest
/// @notice #2930 — the one paging rule every filtered view reads its window
///         through: a call reads `[start, end)`, at most `maxScan` rows, and
///         never past the source's length.
contract LibScanPageTest is Test {
    function test_windowWithinTheSource() public pure {
        (uint256 start, uint256 end) = LibScanPage.window(10, 3, 4);
        assertEq(start, 3);
        assertEq(end, 7);
    }

    function test_windowClampsAtTheEnd() public pure {
        (uint256 start, uint256 end) = LibScanPage.window(10, 8, 4);
        assertEq(start, 8);
        assertEq(end, 10);
    }

    function test_anOversizedMaxScanReadsToTheEndWithoutOverflow() public pure {
        (uint256 start, uint256 end) = LibScanPage.window(10, 3, type(uint256).max);
        assertEq(start, 3);
        assertEq(end, 10);
    }

    function test_aCursorAtOrPastTheEndReadsNothingAndReportsTheLength() public pure {
        (uint256 s1, uint256 e1) = LibScanPage.window(10, 10, 4);
        assertEq(s1, 10);
        assertEq(e1, 10);
        (uint256 s2, uint256 e2) = LibScanPage.window(10, type(uint256).max, type(uint256).max);
        assertEq(s2, 10);
        assertEq(e2, 10);
    }

    function test_aZeroMaxScanReadsNothing() public pure {
        (uint256 start, uint256 end) = LibScanPage.window(10, 3, 0);
        assertEq(start, 3);
        assertEq(end, 3);
    }

    function testFuzz_windowIsBoundedAndInsideTheSource(uint256 len, uint256 cursor, uint256 maxScan)
        public
        pure
    {
        (uint256 start, uint256 end) = LibScanPage.window(len, cursor, maxScan);
        assertLe(start, end);
        assertLe(end, len);
        assertLe(end - start, maxScan);
        assertEq(start, cursor < len ? cursor : len);
    }

    function test_trimKeepsThePrefix() public pure {
        uint256[] memory buf = new uint256[](4);
        buf[0] = 7;
        buf[1] = 8;
        buf[2] = 9;
        uint256[] memory out = LibScanPage.trim(buf, 2);
        assertEq(out.length, 2);
        assertEq(out[0], 7);
        assertEq(out[1], 8);
    }
}
