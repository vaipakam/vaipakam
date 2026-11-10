// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IPriceGuard
 * @author Vaipakam Developer Team
 * @notice The read surface of {PriceGuard} (#3272): the one price source the
 *         Diamond and every vault read. The Diamond finds it through the
 *         `ProtocolRegistry` pointer `RegistryKeys.PRICE_GUARD`; a vault never
 *         reads a mutable registry (#3431), so it holds the address in its
 *         own code (#3268).
 * @dev    The errors are the ones the Diamond's oracle has always raised, with
 *         the same names and parameters, so their selectors are unchanged and
 *         a caller that reads a refusal by selector reads it the same way.
 */
interface IPriceGuard {
    /// @notice What a price read found. `Priced`: a price every rule accepts.
    ///         `Unavailable`: no price (missing, stale, sequencer down, or a
    ///         zero composition). `Divergent`: a price the sources contradict,
    ///         which is distrusted rather than missing (#666).
    enum PriceStatus {
        Priced,
        Unavailable,
        Divergent
    }

    error NoPriceFeed();
    error StalePriceData();
    error ZeroPrice(address asset);
    error OraclePriceDivergence();
    error OracleCrossCheckDivergence(
        uint256 chainlinkPrice,
        uint256 pythPrice,
        uint256 deviationBps,
        uint256 maxDeviationBps
    );
    error SequencerDown();
    error SequencerGracePeriod();
    error PadNumeraireRateUnavailable();

    /// @notice The asset's numeraire price and its decimals. Reverts with one
    ///         of the errors above when no accepted price exists.
    function getAssetPrice(address asset) external view returns (uint256 price, uint8 decimals);

    /// @notice {getAssetPrice} as a status, never reverting.
    function getAssetPriceStatus(address asset)
        external
        view
        returns (PriceStatus status, uint256 price, uint8 decimals);

    /// @notice {getAssetPrice} as a success flag, never reverting. `ok` is
    ///         false for a missing and for a distrusted price alike.
    function tryGetAssetPrice(address asset) external view returns (bool ok, uint256 price, uint8 decimals);

    /// @notice The live secondary sources for `asset`, split by whether each
    ///         agrees with the primary. Reverts only when the primary read does.
    function countLiveSecondaryOracleFeeds(address asset)
        external
        view
        returns (uint8 agreeing, uint8 disagreeing);

    /// @notice Whether the L2 sequencer is up and past its grace period. True
    ///         when no sequencer feed is configured (an L1).
    function sequencerHealthy() external view returns (bool);

    /// @notice One Chainlink answer judged by the guard's freshness rule,
    ///         never reverting: the rule the price read applies, for a caller
    ///         that reads a feed itself (the liquidity probe).
    function readFeed(address feed, bool allowStablePeg)
        external
        view
        returns (bool ok, uint256 price, uint8 decimals);

    // ─── Config the Diamond reads for its own rules (#3272 part 2) ───────
    //
    // The liquidity classification stays in the Diamond, and routes its pool
    // probes over WETH and sizes them with the ETH reference feed. It reads
    // those from here, so the guard is the one place they are set.

    /// @notice The numeraire's Chainlink denominator, fixed at construction.
    function NUMERAIRE_DENOMINATOR() external view returns (address);

    /// @notice The numeraire's lower-case ASCII symbol (`"usd"`), fixed at
    ///         construction. The unit of every numeraire-denominated
    ///         threshold the Diamond holds.
    function NUMERAIRE_SYMBOL() external view returns (bytes32);

    /// @notice The denominator asset prices are read in before any pivot,
    ///         fixed at construction (the numeraire's own on retail).
    function PAD_DENOMINATOR() external view returns (address);

    /// @notice The Chainlink ETH denominator, fixed at construction.
    function ETH_DENOMINATOR() external view returns (address);

    /// @notice The chain's feed registry; zero while unset.
    function feedRegistry() external view returns (address);

    /// @notice The chain's WETH, priced from the ETH reference feed; zero
    ///         while unset.
    function weth() external view returns (address);

    /// @notice The ETH/<numeraire> feed; zero while unset.
    function ethNumeraireFeed() external view returns (address);

    /// @notice The L2 sequencer uptime feed; zero on an L1.
    function sequencerFeed() external view returns (address);
}
