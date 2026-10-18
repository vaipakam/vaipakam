// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  LibOracleFreshness
 * @notice The one reading of a sanctions oracle's own "last updated" time
 *         (#2443). `SanctionsList.secondaryLastUpdate`, the delisting
 *         timelock's local RedStone gate and `SanctionsClearanceAttestor`
 *         all read it here, so the rule for what counts as a known time
 *         cannot drift between them.
 *
 * @dev    Calls `getLastUpdateBlockTimestamp()` (RedStone's freshness read)
 *         with a low-level static call, so an oracle that lacks the
 *         function, reverts, or answers in an unexpected shape yields
 *         `known = false` instead of reverting the caller. A freshness that
 *         cannot be read is reported as unknown, never as a time. So is a
 *         word that cannot be one: zero (never updated, or a fallback
 *         answering with an empty word) and any value after the current
 *         block are reported as unknown, so a reader is never shown a 1970
 *         or future "last updated" figure, and a gate never treats either as
 *         fresh.
 */
library LibOracleFreshness {
    /// @param oracle The oracle to ask; `address(0)` is reported as unknown.
    /// @return known     The oracle answered with a plausible timestamp.
    /// @return timestamp Its answer; 0 when `known` is false.
    function lastUpdate(address oracle) internal view returns (bool known, uint256 timestamp) {
        if (oracle == address(0)) return (false, 0);
        (bool ok, bytes memory ret) = oracle.staticcall(abi.encodeWithSignature("getLastUpdateBlockTimestamp()"));
        if (!ok || ret.length != 32) return (false, 0);
        uint256 ts = abi.decode(ret, (uint256));
        if (ts == 0 || ts > block.timestamp) return (false, 0);
        return (true, ts);
    }
}
