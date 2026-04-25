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

    // ─── Phase 7b.2 — Tellor + API3 + DIA + chain-level deviation cfg ──
    //
    // Pyth was removed in Phase 7b.2 because its `priceId` requires a
    // per-asset governance mapping that conflicts with the platform's
    // no-per-asset-config policy. The three replacement sources
    // (Tellor / API3 / DIA) all derive their lookup key from the
    // asset's ERC-20 symbol on-chain, so adding new collateral assets
    // never requires a per-asset governance write.

    /**
     * @notice Set the chain's Tellor oracle address. Owner-only.
     *         Zero disables Tellor's leg of the secondary deviation
     *         check globally; the price view falls back to Chainlink-
     *         only (plus API3 if configured).
     *
     *         No per-asset config: {OracleFacet} derives Tellor's
     *         queryId at call time by reading `asset.symbol()` and
     *         packing the standard SpotPrice query
     *         (`keccak256(abi.encode("SpotPrice", abi.encode(symbol,
     *         "usd")))`). Assets without a Tellor reporter are
     *         silently skipped — the deviation check only fires when
     *         Tellor returns non-zero data.
     * @param oracle Tellor contract address on this chain, or zero.
     */
    function setTellorOracle(address oracle) external {
        LibVaipakam.setTellorOracle(oracle);
    }

    /// @notice Read the configured Tellor oracle address. Zero
    ///         indicates Tellor is disabled.
    function getTellorOracle() external view returns (address) {
        return LibVaipakam.storageSlot().tellorOracle;
    }

    /**
     * @notice Set the chain's API3 ServerV1 contract address. Same
     *         no-per-asset-config policy as Tellor — {OracleFacet}
     *         derives the dAPI name from `asset.symbol()` at call
     *         time. Owner-only.
     * @param server API3 ServerV1 address on this chain, or zero.
     */
    function setApi3ServerV1(address server) external {
        LibVaipakam.setApi3ServerV1(server);
    }

    /// @notice Read the configured API3 ServerV1 address. Zero
    ///         indicates API3 is disabled.
    function getApi3ServerV1() external view returns (address) {
        return LibVaipakam.storageSlot().api3ServerV1;
    }

    /**
     * @notice Set the chain's DIA Oracle V2 contract address. Same
     *         no-per-asset-config policy as Tellor + API3 — {OracleFacet}
     *         derives the DIA key (`<SYMBOL>/USD`) from `asset.symbol()`
     *         at call time. Owner-only.
     * @param oracle DIA Oracle V2 address on this chain, or zero.
     */
    function setDIAOracleV2(address oracle) external {
        LibVaipakam.setDIAOracleV2(oracle);
    }

    /// @notice Read the configured DIA Oracle V2 address. Zero
    ///         indicates DIA is disabled.
    function getDIAOracleV2() external view returns (address) {
        return LibVaipakam.storageSlot().diaOracleV2;
    }

    /**
     * @notice Set the chain-level deviation tolerance applied to
     *         every secondary oracle (Tellor / API3) when it
     *         disagrees with the Chainlink primary.
     * @dev Owner-only. Must be in (0, 10000) basis points.
     * @param bps Allowed deviation, e.g. 500 = 5%.
     */
    function setSecondaryOracleMaxDeviationBps(uint16 bps) external {
        LibVaipakam.setSecondaryOracleMaxDeviationBps(bps);
    }

    /// @notice Read the effective secondary-oracle deviation tolerance.
    function getSecondaryOracleMaxDeviationBps() external view returns (uint16) {
        return LibVaipakam.effectiveSecondaryOracleMaxDeviationBps();
    }

    /**
     * @notice Set the chain-level secondary-oracle staleness tolerance.
     * @dev Owner-only. Must be non-zero (seconds).
     */
    function setSecondaryOracleMaxStaleness(uint40 maxStaleness) external {
        LibVaipakam.setSecondaryOracleMaxStaleness(maxStaleness);
    }

    /// @notice Read the effective secondary-oracle staleness tolerance.
    function getSecondaryOracleMaxStaleness() external view returns (uint40) {
        return LibVaipakam.effectiveSecondaryOracleMaxStaleness();
    }
}
