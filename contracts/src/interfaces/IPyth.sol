// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IPyth — minimal Pyth Network consumer interface.
 *
 * @dev T-033: re-introduces Pyth as a *numeraire-redundancy* oracle
 *      after Phase 7b.2 removed the per-asset variant. Scope is
 *      deliberately narrow:
 *        - Vaipakam registers ONE Pyth feed per chain — the chain's
 *          ETH/USD (or WETH/USD on chains where bridged WETH is the
 *          unit of account, e.g. BNB / Polygon mainnet).
 *        - That single feed is consulted as a sanity gate alongside
 *          the existing Chainlink WETH/USD reading. A divergence
 *          beyond the governance-tunable
 *          `pythNumeraireMaxDeviationBps` reverts the price view
 *          (fail-closed); staleness or low-confidence Pyth data is
 *          treated as "Pyth unavailable" — the gate soft-skips.
 *
 *      No per-asset Pyth governance is added. Per-asset redundancy
 *      remains the existing Phase 7b.2 Tellor + API3 + DIA
 *      symbol-derived secondary quorum.
 *
 *      Pyth's full IPyth surface includes pull-update entrypoints
 *      (`updatePriceFeeds`, `parsePriceFeedUpdates`, etc.) that this
 *      interface omits — Vaipakam consumes Pyth in pure-read mode,
 *      relying on the published-by-relayers data the Pyth contract
 *      already holds. Other consumers on the same chain keep the
 *      feed fresh.
 */
interface IPyth {
    /// @dev Pyth's price snapshot. Consumers should validate
    ///      {publishTime} against a max-staleness budget and
    ///      {conf} against a max-confidence-fraction budget before
    ///      using {price}.
    struct Price {
        /// @dev Signed price in `expo`-scaled units. Negative
        ///      `expo` is the typical case (e.g. price = 1234500,
        ///      expo = -8 → $123,450 with 8 decimals like Chainlink).
        int64 price;
        /// @dev 95-percentile uncertainty in the same scale as
        ///      {price}. A high `conf / price` ratio signals a
        ///      thin-publisher window — Vaipakam's gate treats this
        ///      as "Pyth unavailable" so a temporarily-shaky reading
        ///      doesn't block protocol ops.
        uint64 conf;
        /// @dev Decimal exponent. Negative: `actual = price * 10^expo`.
        int32 expo;
        /// @dev Unix timestamp when this snapshot was published.
        uint256 publishTime;
    }

    /**
     * @notice Read the latest Pyth price for `id` without reverting
     *         on staleness. Vaipakam's gate handles staleness +
     *         confidence checks itself so a stale or low-confidence
     *         feed soft-skips rather than fail-closing the whole
     *         price view.
     * @dev    Returns the published snapshot regardless of age. The
     *         alternative `getPriceNoOlderThan(id, age)` reverts on
     *         stale; we prefer the explicit branch here so we can
     *         emit a single readable error path on any failure.
     * @param  id  Pyth's 32-byte feed identifier (e.g. ETH/USD).
     * @return     The latest snapshot.
     */
    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}
