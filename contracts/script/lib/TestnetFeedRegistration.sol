// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {VaipakamFeedRegistry} from "../../src/oracle/VaipakamFeedRegistry.sol";
import {TestnetChains} from "../../src/compliance/TestnetChains.sol";

/**
 * @title  TestnetFeedRegistration
 * @notice How a testnet's mock rig registers its feeds in the chain's real
 *         `VaipakamFeedRegistry` (#2880): one owner proposal, executed at
 *         once, which needs the zero delay `FeedRegistryDeployment` sets on a
 *         testnet.
 *
 * @dev    The caller broadcasts as the registry's owner (the admin). Each
 *         change names the feed it replaces, read from the registry, so a
 *         re-run of the rig replaces its earlier feeds rather than failing;
 *         a pair already on the wanted feed is left out. The proposal carries
 *         a zero directory hash and date: these entries come from no
 *         Chainlink directory, and the registry's state says so.
 */
library TestnetFeedRegistration {
    /// @notice One feed the rig wants registered.
    struct Feed {
        address base;
        address quote;
        address feed;
        string pair;
    }

    /// @notice Daily heartbeat the rig declares; its mock feeds always report
    ///         the current block time.
    uint32 internal constant HEARTBEAT = 1 days;

    function register(VaipakamFeedRegistry reg, Feed[] memory feeds) internal {
        require(TestnetChains.isTestnet(block.chainid), "TestnetFeedRegistration: testnets only");
        require(
            reg.delay() == 0,
            "TestnetFeedRegistration: the feed registry's delay is not 0 - the rig registers in one run (re-run DeployFeedRegistry, which sets it on a testnet)"
        );
        VaipakamFeedRegistry.Change[] memory all = new VaipakamFeedRegistry.Change[](feeds.length);
        uint256 n;
        for (uint256 i; i < feeds.length; ++i) {
            Feed memory f = feeds[i];
            address current = reg.getFeed(f.base, f.quote);
            if (current == f.feed) continue;
            all[n++] = VaipakamFeedRegistry.Change({
                base: f.base,
                quote: f.quote,
                expectedFeed: current,
                feed: f.feed,
                feedDecimals: _decimals(f.feed),
                category: VaipakamFeedRegistry.Category.Low,
                heartbeat: HEARTBEAT,
                pair: f.pair
            });
        }
        if (n == 0) return;
        VaipakamFeedRegistry.Change[] memory cs = new VaipakamFeedRegistry.Change[](n);
        for (uint256 i; i < n; ++i) cs[i] = all[i];
        uint256 id = reg.propose(cs, bytes32(0), 0);
        reg.execute(id, cs);
    }

    function _decimals(address feed) private view returns (uint8) {
        return IDecimals(feed).decimals();
    }
}

interface IDecimals {
    function decimals() external view returns (uint8);
}
