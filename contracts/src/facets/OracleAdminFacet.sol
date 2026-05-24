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
    // ─── Bound-related errors (post-audit hardening, 2026-05-14) ──────
    // Two gaps closed off `docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`:
    // `setStableTokenFeed` accepting an unbounded `string symbol`
    // (storage / observability noise vector), and `setTierReferenceAssets`
    // accepting an unbounded array (hot-path-cost vector).
    //
    // The audit's Gap #1 candidate (`setUsdChainlinkDenominator`
    // accepting zero) turned out to be a false positive — zero is an
    // intentional sentinel mirroring `setChainlinkRegistry`'s
    // "disable this leg, fall through to the ETH path" semantics. The
    // existing `testOwnerCanZeroUsdDenominator` documents the
    // supported flow: post-zero, `getAssetPrice` reverts cleanly with
    // `NoPriceFeed` (no silent breakage). Closing it out
    // (revert-on-zero) would break the documented l2 / fallback path.

    /// @notice `setStableTokenFeed.symbol` exceeded MAX_STABLE_SYMBOL_LEN
    ///         (10 bytes — accommodates every ISO 4217 fiat code +
    ///         common precious-metal tickers like "XAU" / "XAG").
    error StableSymbolTooLong(uint256 length, uint256 maxLength);

    /// @notice `setTierReferenceAssets.assets` exceeded
    ///         MAX_TIER_REFERENCE_ASSETS (20). The cache-refresh
    ///         iteration is O(assets × peers) on the hot path; an
    ///         unbounded list would let a single config call DoS the
    ///         permissionless refresh.
    error TierReferenceAssetsTooLong(uint256 length, uint256 maxLength);

    /// @dev See {StableSymbolTooLong}.
    uint256 internal constant MAX_STABLE_SYMBOL_LEN = 10;

    /// @dev See {TierReferenceAssetsTooLong}. 20 leaves headroom over
    ///      today's 4-asset Tier-3 reference set without permitting
    ///      a 1000-asset hot-path-DoS vector.
    uint256 internal constant MAX_TIER_REFERENCE_ASSETS = 20;

    /**
     * @notice Sets the Chainlink Feed Registry address used by
     *         OracleFacet for asset/USD and asset/ETH lookups.
     * @dev Owner-only (enforced inside `LibVaipakam.setChainlinkRegistry`).
     *      Setting to `address(0)` disables registry-based price lookups —
     *      correct for l2 deployments where the Feed Registry is not
     *      available; OracleFacet then falls through to the direct
     *      `ethNumeraireFeed` path for WETH.
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
     *         v3-style AMM asset/WETH pool-depth quote asset AND as the
     *         fallback PAA list entry when {paaAssets} is empty.
     * @dev Owner-only. Setting to `address(0)` fail-closes every asset
     *      to Illiquid (no pool to discover).
     *
     *      **Chain-specificity** (per the 2026-05-14 WETH chain-safety
     *      audit, `docs/internal/WethChainSafetyAudit-2026-05-14.md`):
     *      this value MUST be the chain's canonical bridged-WETH9 ERC-20,
     *      NOT the chain's wrapped-native (WBNB / WMATIC / etc.).
     *
     *      Specifically:
     *      - **Ethereum / Base / Arbitrum / Optimism / Polygon zkEVM**:
     *        the chain's wrapped-native IS WETH (native gas is ETH);
     *        wrapped-native and bridged-WETH are the same address; either
     *        intent works.
     *      - **BNB Chain mainnet (chainId 56)**: native gas is BNB, NOT
     *        ETH. Wrapped-native = WBNB (`0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`),
     *        bridged-WETH9 = `0x2170Ed0880ac9A755fd29B2688956BD959F933F8`.
     *        **MUST set the bridged-WETH9**, never WBNB — the pool-depth
     *        leg assumes ETH-denominated value, and using WBNB would
     *        mis-price every depth-tier classification.
     *      - **Polygon PoS mainnet (chainId 137)**: native gas is POL,
     *        NOT ETH. Wrapped-native = WPOL/WMATIC, bridged-WETH9 =
     *        `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`. **MUST set
     *        the bridged-WETH9**, never WPOL.
     *
     *      The VPFIBuyAdapter's payment-token policy already enforces
     *      this for the cross-chain buy lane (CLAUDE.md "VPFIBuyAdapter
     *      — payment-token mode by chain"); this setter is the
     *      equivalent operator-responsibility surface for the
     *      OracleFacet liquidity / tier classification path. There's no
     *      runtime contract check that the address is WETH-shaped —
     *      operator must verify against the chain's official bridge
     *      registry. CLAUDE.md tracks the canonical addresses.
     *
     * @param weth The bridged-WETH9 ERC-20 contract address on the active
     *             network (NOT the wrapped-native on non-ETH-gas chains).
     */
    function setWethContract(address weth) external {
        LibVaipakam.setWethContract(weth);
    }

    /**
     * @notice Sets the direct Chainlink ETH/USD AggregatorV3 feed.
     * @dev Owner-only. REQUIRED — used to price WETH itself, to
     *      convert asset/WETH pool depth into USD for the Liquid /
     *      Illiquid classification, AND to multiply against the
     *      asset/ETH fallback feed when no direct asset/USD feed
     *      is available. Setting to `address(0)` disables every
     *      ETH-quoted code path; WETH pricing reverts NoPriceFeed
     *      and every asset classifies Illiquid.
     *
     *      **Chain-specificity** (per the 2026-05-14 WETH chain-safety
     *      audit, `docs/internal/WethChainSafetyAudit-2026-05-14.md`):
     *      this MUST be the **ETH/USD** feed on every chain, NOT the
     *      chain's native-gas/USD feed. Specifically:
     *      - **Ethereum / Base / Arbitrum / Optimism / Polygon zkEVM**:
     *        native gas IS ETH; the chain's "native-gas/USD" feed AND
     *        the "ETH/USD" feed are the same Chainlink aggregator.
     *        Either intent works.
     *      - **BNB Chain mainnet (chainId 56)**: native gas is BNB,
     *        NOT ETH. **MUST set the chain's ETH/USD aggregator** (the
     *        BNB-side Chainlink feed that prices ETH in USD), NEVER
     *        the BNB/USD aggregator. The asset/ETH fallback formula
     *        is `asset/ETH × ETH/USD`; with BNB/USD substituted, asset
     *        prices mis-report by the ETH-to-BNB ratio (~6× as of
     *        2026-05). Every depth-tier classification + every LTV /
     *        HF read that traverses the fallback path mis-prices.
     *      - **Polygon PoS mainnet (chainId 137)**: native gas is POL
     *        (formerly MATIC), NOT ETH. **MUST set the chain's ETH/USD
     *        aggregator**, NEVER POL/USD. Same failure mode as BNB.
     *
     *      The storage slot is named `ethNumeraireFeed` for historical
     *      reasons (pre-numeraire-generalization). Read it as "the
     *      ETH-side reference feed", not "the numeraire feed for the
     *      chain's native asset". CLAUDE.md's deploy runbook + the
     *      bounds-audit doc cover the canonical addresses per chain.
     *
     * @param feed The ETH/USD Chainlink aggregator contract address
     *             on the active network (NOT the native-gas/USD feed
     *             on non-ETH-gas chains).
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
        // Gap #2 from the 2026-05-14 bounds audit
        // (`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`):
        // `symbol` was unconstrained. A fat-fingered or malicious
        // governance call could register a 100-KB symbol, polluting
        // the peg-lookup table + bloating storage. Cap at 10 bytes —
        // covers every ISO 4217 fiat ticker ("USD", "EUR", "JPY", …)
        // and the precious-metal tickers ("XAU" / "XAG") the design
        // anticipates.
        uint256 len = bytes(symbol).length;
        if (len > MAX_STABLE_SYMBOL_LEN) {
            revert StableSymbolTooLong(len, MAX_STABLE_SYMBOL_LEN);
        }
        LibVaipakam.setStableTokenFeed(symbol, feed);
    }

    /**
     * @notice Sets the Chainlink l2 Sequencer Uptime feed used as an
     *         oracle circuit breaker on l2 deployments.
     * @dev Owner-only. Setting to `address(0)` disables the check —
     *      correct for l1/Ethereum mainnet where no sequencer exists;
     *      required on L2s (Base, Arbitrum, Optimism, etc.) where
     *      Chainlink publishes a uptime feed. When non-zero,
     *      `OracleFacet.getAssetPrice` and `checkLiquidity` will revert
     *      with `SequencerDown` (sequencer currently offline) or
     *      `SequencerGracePeriod` (came back up <1h ago) before any
     *      price read.
     * @param feed The Chainlink l2 Sequencer Uptime feed address.
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

    // ─── T-033 — Pyth numeraire-redundancy admin surface ───────────────────
    //
    // Single Pyth feed per chain (ETH/USD, or bridged WETH/USD on
    // BNB / Polygon mainnet). Used as a sanity gate alongside the
    // existing Chainlink WETH/USD reading — divergence > tolerance
    // reverts the price view (`OracleCrossCheckDivergence`). Per-asset
    // redundancy is unchanged: the symbol-derived Tellor + API3 +
    // DIA quorum continues to handle that. Pyth here is specifically
    // the redundancy on the most load-bearing oracle reading in the
    // protocol, with zero per-asset governance overhead.
    //
    // Every tunable below is bounded by compiled-in min/max so a
    // compromised admin / governance multisig can't push the value
    // outside the policy range without a contract upgrade.

    /// @notice Set the chain's Pyth contract address. Zero disables
    ///         the numeraire gate globally — protocol falls back to
    ///         Chainlink-only on the WETH/USD leg.
    function setPythOracle(address oracle) external {
        LibVaipakam.setPythOracle(oracle);
    }

    /// @notice Read the configured Pyth contract address.
    function getPythOracle() external view returns (address) {
        return LibVaipakam.storageSlot().pythOracle;
    }

    /// @notice Set the Pyth feed id used as the chain's numeraire
    ///         (ETH/USD on ETH-native chains; bridged-WETH/USD on
    ///         non-ETH-native chains).
    function setPythCrossCheckFeedId(bytes32 feedId) external {
        LibVaipakam.setPythCrossCheckFeedId(feedId);
    }

    /// @notice Read the configured Pyth numeraire feed id.
    function getPythNumeraireFeedId() external view returns (bytes32) {
        return LibVaipakam.storageSlot().pythCrossCheckFeedId;
    }

    /// @notice Set the Pyth max-staleness budget (seconds). Bounded
    ///         to [60, 3600]. See `PYTH_MAX_STALENESS_*` constants
    ///         in {LibVaipakam} for the policy rationale.
    function setPythMaxStalenessSeconds(uint64 secondsBudget) external {
        LibVaipakam.setPythMaxStalenessSeconds(secondsBudget);
    }

    /// @notice Read the effective Pyth max-staleness budget.
    function getPythMaxStalenessSeconds() external view returns (uint64) {
        return LibVaipakam.effectivePythMaxStalenessSeconds();
    }

    /// @notice Set the Chainlink ↔ Pyth max-deviation tolerance, in
    ///         basis points. Bounded to [100, 2000] (1% to 20%).
    function setPythCrossCheckMaxDeviationBps(uint16 bps) external {
        LibVaipakam.setPythCrossCheckMaxDeviationBps(bps);
    }

    /// @notice Read the effective Pyth deviation tolerance.
    function getPythNumeraireMaxDeviationBps() external view returns (uint16) {
        return LibVaipakam.effectivePythCrossCheckMaxDeviationBps();
    }

    /// @notice Set the Pyth confidence-fraction ceiling, in basis
    ///         points. Bounded to [50, 500] (0.5% to 5%).
    function setPythConfidenceMaxBps(uint16 bps) external {
        LibVaipakam.setPythConfidenceMaxBps(bps);
    }

    /// @notice Read the effective Pyth confidence ceiling.
    function getPythConfidenceMaxBps() external view returns (uint16) {
        return LibVaipakam.effectivePythConfidenceMaxBps();
    }

    /**
     * @notice Configure the per-chain peer-lending-protocol addresses
     *         the autonomous tier-LTV cache reads. Phase 3 of
     *         AutonomousLtvAndOracleFallback.md.
     * @dev    Owner-only (TimelockController post-handover, so 48h-gated).
     *         Setting any to `address(0)` skips that peer in the
     *         aggregation — fine for chains where the peer isn't
     *         deployed. Addresses must be verified against each
     *         protocol's official docs before this call; the on-chain
     *         layer doesn't validate provenance.
     *
     *         Verification examples per peer:
     *           - Aave V3 PoolDataProvider — per-chain address from
     *             https://aave.com/docs/resources/addresses (chain-
     *             specific deployment).
     *           - Compound V3 Comet — one Comet per base asset; pick
     *             the largest by liquidity on the target chain. From
     *             https://docs.compound.finance/#networks.
     *           - Morpho-Blue — single deployment per chain. From
     *             https://docs.morpho.org. (For v1, this slot is
     *             read but the Morpho aggregator is a Phase-3.5
     *             follow-up — the address can be set early so the
     *             registry is ready when the reader lands.)
     *
     * @param aaveV3PoolDataProvider Aave V3 data-provider, or zero.
     * @param compoundV3Comet        Compound V3 Comet (one), or zero.
     * @param morphoBlue             Morpho-Blue contract, or zero.
     */
    function setPeerProtocolAddresses(
        address aaveV3PoolDataProvider,
        address compoundV3Comet,
        address morphoBlue
    ) external {
        LibVaipakam.setPeerProtocolAddresses(
            aaveV3PoolDataProvider,
            compoundV3Comet,
            morphoBlue
        );
    }

    /// @notice Read the configured peer-protocol addresses for this
    ///         chain. Single-call view that returns the full triple,
    ///         shaped to feed the protocol-console + the audit-package
    ///         per-chain verification step.
    function getPeerProtocolAddresses()
        external
        view
        returns (
            address aaveV3PoolDataProvider,
            address compoundV3Comet,
            address morphoBlue
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.aaveV3PoolDataProvider, s.compoundV3Comet, s.morphoBlue);
    }

    /**
     * @notice Set a tier's reference asset list. Phase 4 of
     *         AutonomousLtvAndOracleFallback.md. Constitution-level
     *         setting: changes are rare, governance-gated, and require
     *         re-audit of the new asset list for collateral suitability.
     * @dev    Owner-only (TimelockController post-handover, 48h-gated).
     *         An empty array clears the tier — refreshes for that tier
     *         then emit `no-reference-assets` and the cache stays at
     *         its previous value (or library default if hard-stale).
     *
     *         Recommended reference lists per tier (per-chain — the
     *         operator picks each chain's canonical token addresses):
     *           Tier 3 (deepest, blue-chip): WBTC, WETH, USDC, USDT, DAI
     *           Tier 2 (mid-cap):            LINK, AAVE, UNI, COMP, MKR
     *           Tier 1 (entry):              a small list of well-attested mid/long-tail
     *
     *         The aggregator (`OracleFacet.refreshTierLtvCache`) reads
     *         these assets' LTVs from each configured peer, applies
     *         per-asset + per-tier consensus, applies the tier's
     *         haircut, bound-checks, and persists. The list itself is
     *         constitution-level: changing it doesn't auto-trigger a
     *         refresh; operators call `refreshTierLtvCache()` after
     *         updating the list to pick up the new asset universe.
     * @param  tier   1, 2, or 3.
     * @param  assets New reference asset list for this tier. Pass an
     *                empty array to clear.
     */
    function setTierReferenceAssets(uint8 tier, address[] calldata assets) external {
        // Gap #3 from the 2026-05-14 bounds audit
        // (`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`):
        // `refreshTierLtvCache`'s hot-path iterates O(assets × peers).
        // Without a cap, a single config call could push 1000+ assets
        // per tier and DoS the permissionless refresh. 20 leaves
        // headroom over today's 4-asset Tier-3 reference set without
        // permitting griefing.
        if (assets.length > MAX_TIER_REFERENCE_ASSETS) {
            revert TierReferenceAssetsTooLong(
                assets.length,
                MAX_TIER_REFERENCE_ASSETS
            );
        }
        // Convert calldata to memory once (LibVaipakam takes memory[]).
        address[] memory mem = new address[](assets.length);
        for (uint256 i = 0; i < assets.length; ++i) mem[i] = assets[i];
        LibVaipakam.setTierReferenceAssets(tier, mem);
    }

    /// @notice Read a tier's reference asset list. Single-call view
    ///         that returns the full array, shaped to feed the
    ///         protocol-console + the audit-package per-chain
    ///         verification step.
    function getTierReferenceAssets(uint8 tier)
        external
        view
        returns (address[] memory)
    {
        return LibVaipakam.getTierReferenceAssets(tier);
    }
}
