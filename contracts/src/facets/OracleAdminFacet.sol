// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title OracleAdminFacet
 * @notice Admin facet exposing oracle configuration setters. All functions
 *         are owner-only (enforced in the LibVaipakam internal setters).
 *         Per README §1.5, liquidity classification is never manually
 *         overrideable — assets must pass the on-chain Chainlink +
 *         v3-style AMM checks or be treated as Illiquid.
 */
contract OracleAdminFacet {
    /**
     * @notice Sets the Chainlink Feed Registry address used by
     *         OracleFacet for asset/USD and asset/ETH lookups.
     * @dev Owner-only (enforced inside `LibVaipakam.setChainlinkRegistry`).
     *      Setting to `address(0)` disables registry-based price lookups —
     *      correct for L2 deployments where the Feed Registry is not
     *      available; OracleFacet then falls through to the direct
     *      `ethUsdFeed` path for WETH.
     * @param registry The Chainlink Feed Registry contract address.
     */
    function setChainlinkRegistry(address registry) external {
        LibVaipakam.setChainlinkRegistry(registry);
    }

    /**
     * @notice Sets the Chainlink USD denominator used when querying
     *         asset → USD feeds via the Feed Registry.
     * @dev Owner-only. Must match the denominator registered in the Feed
     *      Registry (typically the canonical USD pseudo-address).
     * @param denominator The USD-denominator address recognised by the
     *                    Chainlink Feed Registry.
     */
    function setUsdChainlinkDenominator(address denominator) external {
        LibVaipakam.setUsdChainlinkDenominator(denominator);
    }

    /**
     * @notice Sets the Chainlink ETH denominator used by the asset/ETH
     *         fallback price path in OracleFacet.getAssetPrice.
     * @dev Owner-only. Set to `address(0)` on L2s where the Feed Registry
     *      is not deployed — disables the ETH-route fallback (assets
     *      without a direct asset/USD feed then revert NoPriceFeed).
     * @param denominator The ETH-denominator address recognised by the
     *                    Chainlink Feed Registry (typically
     *                    0x0000...0000eEeeE...).
     */
    function setEthChainlinkDenominator(address denominator) external {
        LibVaipakam.setEthChainlinkDenominator(denominator);
    }

    /**
     * @notice Sets the canonical WETH ERC-20 used by OracleFacet as the
     *         v3-style AMM asset/WETH pool-depth quote asset.
     * @dev Owner-only. Setting to `address(0)` fail-closes every asset to
     *      Illiquid (no pool to discover).
     * @param weth The WETH ERC-20 contract address on the active network.
     */
    function setWethContract(address weth) external {
        LibVaipakam.setWethContract(weth);
    }

    /**
     * @notice Sets the direct Chainlink ETH/USD AggregatorV3 feed.
     * @dev Owner-only. REQUIRED — used to price WETH itself and to
     *      convert asset/WETH pool depth into USD for the Liquid/Illiquid
     *      classification. Setting to `address(0)` disables every
     *      ETH-quoted code path; WETH pricing reverts NoPriceFeed and
     *      every asset classifies Illiquid.
     * @param feed The ETH/USD Chainlink aggregator contract address.
     */
    function setEthUsdFeed(address feed) external {
        LibVaipakam.setEthUsdFeed(feed);
    }

    /**
     * @notice Sets the v3-style AMM factory used by
     *         `OracleFacet.checkLiquidity` for pool discovery.
     * @dev Owner-only. Setting to `address(0)` collapses the liquidity
     *      classification to Illiquid for every asset (fail-closed).
     * @param factory The v3-style AMM factory contract address.
     */
    function setUniswapV3Factory(address factory) external {
        LibVaipakam.setUniswapV3Factory(factory);
    }

    /**
     * @notice Registers, replaces, or deregisters a fiat / commodity peg
     *         reference feed for OracleFacet's generalized peg-aware
     *         stable-staleness branch.
     * @dev Owner-only. The implicit USD $1 peg is always honoured and
     *      does not need to be registered. Call with `feed == address(0)`
     *      to deregister a previously-set symbol.
     *
     *      Example configs:
     *        setStableTokenFeed("EUR", 0xb49f...); // EUR/USD aggregator
     *        setStableTokenFeed("JPY", 0xBcE2...); // JPY/USD aggregator
     *        setStableTokenFeed("XAU", 0x214e...); // XAU/USD aggregator
     *
     *      The peg-loop in OracleFacet walks the registered set only
     *      once an asset's own feed has aged past the 2h volatile
     *      ceiling; the reference feed itself must still be fresh
     *      within the 25h stable ceiling to anchor the check.
     * @param symbol Short fiat / commodity ticker, e.g. "EUR".
     * @param feed   Chainlink `<symbol>/USD` aggregator (8 decimals);
     *               `address(0)` to deregister.
     */
    function setStableTokenFeed(string calldata symbol, address feed) external {
        LibVaipakam.setStableTokenFeed(symbol, feed);
    }

    /**
     * @notice Sets the Chainlink L2 Sequencer Uptime feed used as an
     *         oracle circuit breaker on L2 deployments.
     * @dev Owner-only. Setting to `address(0)` disables the check —
     *      correct for L1/Ethereum mainnet where no sequencer exists;
     *      required on L2s (Base, Arbitrum, Optimism, etc.) where
     *      Chainlink publishes a uptime feed. When non-zero,
     *      `OracleFacet.getAssetPrice` and `checkLiquidity` will revert
     *      with `SequencerDown` (sequencer currently offline) or
     *      `SequencerGracePeriod` (came back up <1h ago) before any
     *      price read.
     * @param feed The Chainlink L2 Sequencer Uptime feed address.
     */
    function setSequencerUptimeFeed(address feed) external {
        LibVaipakam.setSequencerUptimeFeed(feed);
    }

    /**
     * @notice Sets a per-feed staleness override + minimum-valid-answer
     *         floor for a specific Chainlink aggregator.
     * @dev Owner-only (enforced inside `LibVaipakam.setFeedOverride`).
     *      The two-tier global defaults (ORACLE_VOLATILE_STALENESS,
     *      ORACLE_STABLE_STALENESS) apply as the fallback — an override
     *      is consulted only when `maxStaleness > 0`.
     *
     *      When the override is active:
     *        - `maxStaleness` bounds the allowable age (seconds). The
     *          stable-peg branch is bypassed — operators take explicit
     *          responsibility for the freshness budget on this feed.
     *        - `minValidAnswer` imposes a hard floor on the aggregator's
     *          returned answer, in the aggregator's own decimals. A
     *          reading below this floor triggers `StalePriceData`.
     *
     *      Pass `maxStaleness = 0` to clear the override entirely (both
     *      fields are cleared regardless of `minValidAnswer`). Emits
     *      {LibVaipakam.FeedOverrideSet}.
     *
     * @param feed           The Chainlink aggregator address.
     * @param maxStaleness   Max age in seconds. 0 = clear the override.
     * @param minValidAnswer Minimum acceptable raw answer from this feed.
     *                       0 or negative = no floor (only the baseline
     *                       `answer > 0` sanity check applies).
     */
    function setFeedOverride(
        address feed,
        uint40 maxStaleness,
        int256 minValidAnswer
    ) external {
        LibVaipakam.setFeedOverride(feed, maxStaleness, minValidAnswer);
    }

    /**
     * @notice Reads the current per-feed override (if any) for a given
     *         aggregator. Used by UI + monitoring to surface tightened
     *         staleness bounds to users and to let audit tooling diff
     *         the configured policy vs. expected policy.
     * @param feed The Chainlink aggregator address.
     * @return maxStaleness   Current max age in seconds; 0 means no
     *                        override is set.
     * @return minValidAnswer Current minimum-valid-answer floor;
     *                        0 or negative means no floor.
     */
    function getFeedOverride(
        address feed
    ) external view returns (uint40 maxStaleness, int256 minValidAnswer) {
        LibVaipakam.FeedOverride storage ovr = LibVaipakam
            .storageSlot()
            .feedOverrides[feed];
        return (ovr.maxStaleness, ovr.minValidAnswer);
    }

    /**
     * @notice Installs the chain's Pyth endpoint address — the deployed
     *         Pyth oracle contract this chain reads secondary prices
     *         from and posts signed update payloads to. Canonical
     *         per-chain addresses at
     *         https://docs.pyth.network/price-feeds/contract-addresses/evm.
     * @dev Owner-only (via `LibVaipakam.setPythEndpoint`). Setting to
     *      `address(0)` disables the Pyth secondary-oracle path
     *      globally — every asset falls back to Chainlink-only reads
     *      regardless of per-asset config. Governance-controlled, so
     *      timelock-gated after the Safe-Timelock handover.
     * @param endpoint Pyth contract address for this chain, or zero.
     */
    function setPythEndpoint(address endpoint) external {
        LibVaipakam.setPythEndpoint(endpoint);
    }

    /**
     * @notice Returns the current Pyth endpoint. Zero when disabled.
     */
    function getPythEndpoint() external view returns (address endpoint) {
        return LibVaipakam.storageSlot().pythEndpoint;
    }

    /**
     * @notice Installs or clears a Pyth secondary-feed configuration
     *         for a specific asset. When installed,
     *         {OracleFacet.getAssetPrice} reads Pyth alongside
     *         Chainlink and reverts on divergence above
     *         `maxDeviationBps` or Pyth-staleness above `maxStaleness`.
     * @dev Owner-only (via `LibVaipakam.setPythFeedConfig`).
     *      `priceId = bytes32(0)` clears the config and reverts the
     *      asset to Chainlink-only reads. Install requires:
     *        - `maxDeviationBps` in (0, 10000) — 10000 or higher would
     *          make the deviation check pointless; 0 would refuse every
     *          price.
     *        - `maxStaleness > 0` — zero would refuse every Pyth read.
     *      Pyth prices can be reasonably tight since Pyth publishes
     *      sub-second; typical `maxStaleness` is 30-120 seconds.
     * @param asset           Asset address to configure.
     * @param priceId         Pyth feed id, or `bytes32(0)` to clear.
     * @param maxDeviationBps Max allowed divergence from Chainlink, in
     *                        basis points (100 = 1%).
     * @param maxStaleness    Max acceptable Pyth publishTime age, in
     *                        seconds.
     */
    function setPythFeedConfig(
        address asset,
        bytes32 priceId,
        uint16 maxDeviationBps,
        uint40 maxStaleness
    ) external {
        LibVaipakam.setPythFeedConfig(
            asset,
            priceId,
            maxDeviationBps,
            maxStaleness
        );
    }

    /**
     * @notice Reads the current Pyth secondary-feed configuration for
     *         an asset. Returned `priceId == bytes32(0)` means no Pyth
     *         check is active for this asset — the asset falls back to
     *         Chainlink-only reads.
     */
    function getPythFeedConfig(
        address asset
    )
        external
        view
        returns (bytes32 priceId, uint16 maxDeviationBps, uint40 maxStaleness)
    {
        LibVaipakam.PythFeedConfig storage cfg = LibVaipakam
            .storageSlot()
            .pythFeedConfigs[asset];
        return (cfg.priceId, cfg.maxDeviationBps, cfg.maxStaleness);
    }
}
