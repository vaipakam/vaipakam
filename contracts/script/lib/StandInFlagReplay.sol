// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";

/**
 * @title  StandInFlagReplay
 * @notice The accounts a `TestnetSanctionsOracleStandIn` flags now, rebuilt
 *         from its `StandInFlagSet` events, so a replacement stand-in can be
 *         given exactly the same list (#3113).
 *
 * @dev    The stand-in keeps its flags in a mapping, which cannot be listed,
 *         so its own events are the only complete record. Replaying them in
 *         chain order (block, then log index) gives each account's last
 *         setting; the accounts whose last setting is `true` are the list.
 *         The replay is complete only if the events read reach back to the
 *         stand-in's deployment, which the caller proves separately (the
 *         constructor's `OwnershipTransferred(address(0), owner)`), and the
 *         caller checks every account against the live mapping as well.
 */
library StandInFlagReplay {
    /// @notice `StandInFlagSet(address indexed account, bool flagged)`.
    bytes32 internal constant FLAG_SET = keccak256("StandInFlagSet(address,bool)");

    /// @notice A log that is not a well-formed `StandInFlagSet` of `standIn`.
    error NotAFlagSet(uint256 index);

    /// @notice The accounts flagged after replaying `logs`, in the order each
    ///         was first seen. Every log must be a `StandInFlagSet` emitted by
    ///         `standIn`; anything else reverts rather than being skipped.
    function flaggedNow(Vm.EthGetLogs[] memory logs, address standIn) internal pure returns (address[] memory out) {
        _sortByChainOrder(logs);
        address[] memory seen = new address[](logs.length);
        bool[] memory state = new bool[](logs.length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            Vm.EthGetLogs memory l = logs[i];
            if (
                l.removed || l.emitter != standIn || l.topics.length != 2 || l.topics[0] != FLAG_SET
                    || uint256(l.topics[1]) >> 160 != 0 || l.data.length != 32
            ) revert NotAFlagSet(i);
            uint256 word = abi.decode(l.data, (uint256));
            if (word > 1) revert NotAFlagSet(i);
            address account = address(uint160(uint256(l.topics[1])));
            uint256 j;
            while (j < n && seen[j] != account) ++j;
            if (j == n) seen[n++] = account;
            state[j] = word == 1;
        }
        uint256 count;
        for (uint256 j; j < n; ++j) {
            if (state[j]) ++count;
        }
        out = new address[](count);
        count = 0;
        for (uint256 j; j < n; ++j) {
            if (state[j]) out[count++] = seen[j];
        }
    }

    /// @dev Insertion sort by (block, log index): the inputs are chunks that
    ///      are each already in order, so this is close to linear.
    function _sortByChainOrder(Vm.EthGetLogs[] memory a) private pure {
        for (uint256 i = 1; i < a.length; ++i) {
            Vm.EthGetLogs memory x = a[i];
            uint256 j = i;
            while (j > 0 && _after(a[j - 1], x)) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
    }

    function _after(Vm.EthGetLogs memory p, Vm.EthGetLogs memory q) private pure returns (bool) {
        return p.blockNumber > q.blockNumber || (p.blockNumber == q.blockNumber && p.logIndex > q.logIndex);
    }
}
