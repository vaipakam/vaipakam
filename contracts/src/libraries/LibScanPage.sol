// src/libraries/LibScanPage.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title LibScanPage
 * @author Vaipakam Developer Team
 * @notice The ONE paging rule for a view that filters a list it walks
 *         (#2930, the convention #2751 set): a call reads at most `maxScan`
 *         rows of its source, starting at `cursor`, and returns the rows that
 *         match together with the cursor to resume from. Its cost is bounded
 *         by the rows it READS, never by the rows it returns, so no single
 *         call depends on how many records exist or how few match.
 * @dev    A page may come back EMPTY with the walk unfinished: the end is the
 *         cursor reaching the source's length, never an empty page. A call
 *         that starts at (or past) the end reads nothing and returns the
 *         length as its cursor, which is how a caller that does not know the
 *         length stops.
 *
 *         Cursors are positions in the source, not counts of matches. For an
 *         array source the position is the array index. For an id-range
 *         source (ids `1..lastId`) the position is `id - 1`, so the length is
 *         `lastId` and position `p` reads id `p + 1`.
 *
 *         Active lists are maintained swap-and-pop, so a removal between two
 *         calls moves the last row into the removed slot: a walk across calls
 *         can miss a row that moved behind the cursor, or see one twice. That
 *         is inherent to paging a live list and is the same for an unfiltered
 *         slice; a caller that needs an exact snapshot reads one block.
 */
library LibScanPage {
    /// @notice The half-open window `[start, end)` one call may read.
    /// @param  len     The source's length (array length, or the last id).
    /// @param  cursor  Where the caller asks to start.
    /// @param  maxScan The most rows this call may read.
    /// @return start   `cursor`, clamped to `len`.
    /// @return end     `start + maxScan`, clamped to `len`. Compared before
    ///                 adding, so an oversized `maxScan` reads as "to the
    ///                 end" rather than overflowing.
    function window(uint256 len, uint256 cursor, uint256 maxScan)
        internal
        pure
        returns (uint256 start, uint256 end)
    {
        start = cursor < len ? cursor : len;
        end = maxScan > len - start ? len : start + maxScan;
    }

    /// @notice The first `n` entries of `buf`, as a new array.
    /// @dev    A copy rather than shrinking `buf`'s length in place: these
    ///         are views, and a copy keeps them free of inline assembly.
    function trim(uint256[] memory buf, uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = buf[i];
    }
}
