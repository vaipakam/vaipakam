// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Deployments} from "../lib/Deployments.sol";
import {PriceGuard} from "../../src/oracle/PriceGuard.sol";
import {PriceGuardState} from "../../src/oracle/PriceGuardState.sol";
import {VaipakamFeedRegistry} from "../../src/oracle/VaipakamFeedRegistry.sol";

/**
 * @title ListPriceFeeds
 * @notice Read-only: every price source the chain's price guard holds, as the
 *         deploy rehearsal's feed re-stamp reads it after a clock step (#3891,
 *         deploy rehearsal design section 14, ruling on open item 4).
 * @dev    The list is read from the chain, never kept by hand. One line per
 *         source, for the driver to parse:
 *           FEED <address> <label>       a Chainlink-style feed the guard or
 *                                        its registry binds (re-stamped)
 *           SKIP <address> <label>       a source deliberately left alone
 *                                        (the sequencer status feed: moving
 *                                        its start time would open the
 *                                        recovery window and refuse prices)
 *           UNCOVERED <label>            a source priced by a signed update or
 *                                        a query oracle with its own times,
 *                                        which the rehearsal cannot re-stamp
 *         Asset direct feeds (keyed by asset, industrial pivot only) are not
 *         enumerable from the guard's storage; the driver finds their assets
 *         from the guard's own change events on the fork.
 *
 *         Run (the driver does):
 *           forge script script/rehearsal/ListPriceFeeds.s.sol --sig 'list(address)' <guard> --rpc-url <fork>
 */
contract ListPriceFeeds is Script {
    uint256 internal constant PAGE = 50;

    /// @notice The chain's guard, from its records.
    function run() external view {
        list(Deployments.readPriceGuardOptional());
    }

    /// @notice The guard given directly (the driver reads it from the run's records).
    function list(address guardAddr) public view {
        if (guardAddr == address(0)) {
            console.log("NOGUARD");
            return;
        }
        PriceGuard guard = PriceGuard(guardAddr);
        _single(guard, PriceGuardState.Kind.EthNumeraireFeed, "eth-numeraire");
        _single(guard, PriceGuardState.Kind.EthPadFeed, "eth-pad");
        _single(guard, PriceGuardState.Kind.PadNumeraireRateFeed, "pad-numeraire-rate");

        address seq = _cfgAddr(guard, PriceGuardState.Kind.SequencerFeed, bytes32(0));
        if (seq != address(0)) console.log(string.concat("SKIP ", vm.toString(seq), " sequencer-status"));

        if (guard.pythOracle() != address(0)) console.log("UNCOVERED pyth-cross-check (signed updates carry their own publish time)");
        for (uint8 i; i <= uint8(type(PriceGuardState.Source).max); ++i) {
            address src = guard.secondarySource(PriceGuardState.Source(i));
            if (src != address(0)) {
                console.log(string.concat("UNCOVERED secondary-source-", vm.toString(uint256(i)), " ", vm.toString(src), " (a query oracle with its own times)"));
            }
        }

        bytes32[] memory syms = guard.stableRefSymbols();
        for (uint256 i; i < syms.length; ++i) {
            address f = guard.stableRefFeed(syms[i]);
            if (f != address(0)) console.log(string.concat("FEED ", vm.toString(f), " stable-ref-", _sym(syms[i])));
        }

        address regAddr = _cfgAddr(guard, PriceGuardState.Kind.FeedRegistry, bytes32(0));
        if (regAddr == address(0)) return;
        VaipakamFeedRegistry reg = VaipakamFeedRegistry(regAddr);
        uint256 n = reg.entryCount();
        for (uint256 off; off < n; off += PAGE) {
            (address[] memory bases, address[] memory quotes, VaipakamFeedRegistry.EntryKind[] memory kinds,
                VaipakamFeedRegistry.Entry[] memory entries) = reg.entriesPage(off, PAGE);
            for (uint256 i; i < entries.length; ++i) {
                if (entries[i].feed == address(0)) continue;
                string memory kind = kinds[i] == VaipakamFeedRegistry.EntryKind.Rate ? "rate" : "price";
                console.log(
                    string.concat(
                        "FEED ", vm.toString(entries[i].feed), " registry-", kind, "-",
                        vm.toString(bases[i]), "-", vm.toString(quotes[i])
                    )
                );
            }
        }
    }

    function _single(PriceGuard guard, PriceGuardState.Kind kind, string memory label) internal view {
        address f = _cfgAddr(guard, kind, bytes32(0));
        if (f != address(0)) console.log(string.concat("FEED ", vm.toString(f), " ", label));
    }

    function _cfgAddr(PriceGuard guard, PriceGuardState.Kind kind, bytes32 subject) internal view returns (address) {
        return address(uint160(uint256(guard.config(kind, subject))));
    }

    /// @dev A left-aligned ASCII symbol word as text, stopping at the first zero byte.
    function _sym(bytes32 w) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && w[len] != 0) ++len;
        bytes memory b = new bytes(len);
        for (uint256 i; i < len; ++i) b[i] = w[i];
        return string(b);
    }
}
