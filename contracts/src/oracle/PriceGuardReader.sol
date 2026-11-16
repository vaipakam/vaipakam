// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import {AggregatorV2V3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV2V3Interface.sol";
import {FeedRegistryInterface} from "@vaipakam-vendor/chainlink/FeedRegistryInterface.sol";
import {IFeedRegistryPairBase} from "../interfaces/IFeedRegistryPairBase.sol";
import {ITellor} from "../interfaces/ITellor.sol";
import {IApi3ServerV1} from "../interfaces/IApi3ServerV1.sol";
import {IDIAOracleV2} from "../interfaces/IDIAOracleV2.sol";
import {IPyth} from "../interfaces/IPyth.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {IVersionedFeedRegistry} from "../interfaces/IVersionedFeedRegistry.sol";
import {IRateReader} from "../interfaces/IRateReader.sol";
import {TestnetChains} from "../compliance/TestnetChains.sol";
import {PriceGuardState} from "./PriceGuardState.sol";

/**
 * @title  PriceGuardReader
 * @author Vaipakam Developer Team
 * @notice The pricing path of a {PriceGuard} (#3437): the Chainlink primary
 *         with its pivots, the staleness, peg and sequencer rules, the Pyth
 *         cross-check, the secondary quorum and the rate-priced path
 *         (#3683), each readable at the newest price version or as of an
 *         earlier one. It was split out of the guard to keep both under the
 *         contract size limit.
 * @dev    It holds no state and no owner. Its guard runs this code over the
 *         guard's own storage, inside a static call, so a read can never
 *         write; the two share {PriceGuardState}'s layout. Called directly,
 *         every read refuses ({NotThroughGuard}): here there is no config to
 *         read, and an empty config must never look like an answer.
 */
contract PriceGuardReader is PriceGuardState {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @dev This contract's own address, to refuse a direct read.
    address private immutable SELF;

    /// @notice A read was made on the reader itself, not through its guard.
    error NotThroughGuard();

    modifier throughGuard() {
        if (address(this) == SELF) revert NotThroughGuard();
        _;
    }

    /// @param id The numeraire identity of the guard this reader serves.
    constructor(Identity memory id) PriceGuardState(id) {
        SELF = address(this);
    }

    /// @notice The identity this reader was built for. Its guard refuses to
    ///         be built on a reader whose identity is not its own.
    function identity() external view returns (Identity memory id, bool testnet) {
        id = Identity({
            numeraireDenominator: NUMERAIRE_DENOMINATOR,
            numeraireSymbol: NUMERAIRE_SYMBOL,
            padDenominator: PAD_DENOMINATOR,
            ethDenominator: ETH_DENOMINATOR
        });
        testnet = TESTNET;
    }

    /// @inheritdoc IPriceGuard
    function getAssetPrice(address asset) public view throughGuard returns (uint256 price, uint8 decimals) {
        return _price(asset, _latest());
    }

    /// @inheritdoc IPriceGuard
    function getAssetPriceAt(address asset, uint64 guardEpoch, uint64 registryEpoch)
        public
        view throughGuard
        returns (uint256 price, uint8 decimals)
    {
        return _price(asset, _version(guardEpoch, registryEpoch));
    }

    /// @inheritdoc IPriceGuard
    /// @dev A divergence is recognised by its own selector at its own encoded
    ///      length. Only the quorum raises {OraclePriceDivergence}, only the
    ///      Pyth gate raises {OracleCrossCheckDivergence} and only the rate
    ///      path raises {RatePriceDistrusted}; every secondary source, Pyth
    ///      and a rate reader are read in their own guarded calls, so their
    ///      revert data never reaches here. A primary Chainlink feed's or the
    ///      sequencer feed's revert data does: those are the owner's own
    ///      delayed config, not an outside source. The self-call takes 63/64
    ///      of the gas left, so a caller cannot starve it into a false
    ///      `Unavailable` and still afford its own work; a rate read that
    ///      finds too little gas is passed on as {RateReadOutOfGas}.
    function getAssetPriceStatus(address asset)
        public
        view throughGuard
        returns (PriceStatus status, uint256 price, uint8 decimals)
    {
        try this.getAssetPrice(asset) returns (uint256 p, uint8 d) {
            return (PriceStatus.Priced, p, d);
        } catch (bytes memory reason) {
            return (_statusOf(reason), 0, 0);
        }
    }

    /// @inheritdoc IPriceGuard
    /// @dev The version is checked before the read, outside the try, so an
    ///      unknown or retired version reverts rather than reading as a
    ///      missing price.
    function getAssetPriceStatusAt(address asset, uint64 guardEpoch, uint64 registryEpoch)
        public
        view throughGuard
        returns (PriceStatus status, uint256 price, uint8 decimals)
    {
        _version(guardEpoch, registryEpoch);
        try this.getAssetPriceAt(asset, guardEpoch, registryEpoch) returns (uint256 p, uint8 d) {
            return (PriceStatus.Priced, p, d);
        } catch (bytes memory reason) {
            return (_statusOf(reason), 0, 0);
        }
    }

    /// @inheritdoc IPriceGuard
    function tryGetAssetPrice(address asset) external view throughGuard returns (bool ok, uint256 price, uint8 decimals) {
        PriceStatus status;
        (status, price, decimals) = getAssetPriceStatus(asset);
        ok = status == PriceStatus.Priced;
    }

    /// @inheritdoc IPriceGuard
    function tryGetAssetPriceAt(address asset, uint64 guardEpoch, uint64 registryEpoch)
        external
        view throughGuard
        returns (bool ok, uint256 price, uint8 decimals)
    {
        PriceStatus status;
        (status, price, decimals) = getAssetPriceStatusAt(asset, guardEpoch, registryEpoch);
        ok = status == PriceStatus.Priced;
    }

    /// @inheritdoc IPriceGuard
    /// @dev A rate-priced token has no quorum of its own: its count is its
    ///      underlying's.
    function countLiveSecondaryOracleFeeds(address asset)
        external
        view throughGuard
        returns (uint8 agreeing, uint8 disagreeing)
    {
        Ver memory v = _latest();
        bytes32 h = _c(Kind.RateBinding, _w(asset), v);
        if (h != bytes32(0)) asset = _rateBinding[h].underlying;
        (uint256 primary, uint8 dec) = _primaryPrice(asset, v);
        bytes32 symbol = _secondarySymbol(asset, v);
        if (symbol == bytes32(0)) return (0, 0);
        SecondaryStatus[3] memory statuses = _secondaryStatuses(symbol, primary, dec, v);
        for (uint256 i; i < 3; ++i) {
            if (statuses[i] == SecondaryStatus.Agree) agreeing++;
            else if (statuses[i] == SecondaryStatus.Disagree) disagreeing++;
        }
    }

    /// @inheritdoc IPriceGuard
    function sequencerHealthy() external view throughGuard returns (bool) {
        address feed = sequencerFeed();
        if (feed == address(0)) return true;
        try AggregatorV3Interface(feed).latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer == 0 && startedAt != 0 && startedAt <= block.timestamp
                && block.timestamp - startedAt >= SEQUENCER_GRACE_PERIOD;
        } catch {
            return false;
        }
    }

    /// @inheritdoc IPriceGuard
    function sequencerOutageWindow() external view throughGuard returns (uint256 downAt, uint256 windowEnd) {
        return _outageWindow(sequencerFeed());
    }

    /// @inheritdoc IPriceGuard
    function sequencerOutageWindowAt(uint64 guardEpoch) external view throughGuard returns (uint256 downAt, uint256 windowEnd) {
        if (guardEpoch == 0 || guardEpoch > epoch) revert UnknownPriceVersion(guardEpoch, 0);
        if (guardEpoch < _floorGuardEpoch) revert PriceVersionRetired(guardEpoch, 0);
        return _outageWindow(_addr(_valueAt(_id(Kind.SequencerFeed, 0), guardEpoch)));
    }

    /// @inheritdoc IPriceGuard
    function readFeed(address feed, bool allowStablePeg)
        external
        view throughGuard
        returns (bool ok, uint256 price, uint8 decimals)
    {
        if (feed == address(0)) return (false, 0, 0);
        int256 answer;
        uint256 updatedAt;
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId, int256 a, uint256, uint256 u, uint80 answeredInRound
        ) {
            if (a <= 0 || u == 0 || u > block.timestamp || roundId != answeredInRound) return (false, 0, 0);
            answer = a;
            updatedAt = u;
        } catch {
            return (false, 0, 0);
        }
        uint256 age = block.timestamp - updatedAt;
        if (age > STABLE_STALENESS) return (false, 0, 0);
        uint8 dec;
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            dec = d;
        } catch {
            return (false, 0, 0);
        }
        if (!_freshEnough(feed, answer, age, dec, allowStablePeg, _latest())) return (false, 0, 0);
        // safe: `answer` > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, uint256(answer), dec);
    }

    /// @dev The status a refused read means. A rate read starved of gas is
    ///      passed on rather than read as a missing price.
    function _statusOf(bytes memory reason) private pure returns (PriceStatus) {
        if (reason.length >= 4) {
            bytes4 sel = bytes4(reason);
            if (sel == RateReadOutOfGas.selector) {
                assembly ("memory-safe") {
                    revert(add(reason, 32), mload(reason))
                }
            }
            if (
                (sel == OraclePriceDivergence.selector && reason.length == 4)
                    || (sel == OracleCrossCheckDivergence.selector && reason.length == 4 + 4 * 32)
                    || (sel == RatePriceDistrusted.selector && reason.length == 4 + 32)
            ) return PriceStatus.Divergent;
        }
        return PriceStatus.Unavailable;
    }

    /// @dev The asset's numeraire price at version `v`: from its exchange
    ///      rate when it has a rate binding, else the Chainlink primary
    ///      under the secondary quorum.
    function _price(address asset, Ver memory v) private view returns (uint256 price, uint8 decimals) {
        bytes32 h = _c(Kind.RateBinding, _w(asset), v);
        if (h != bytes32(0)) {
            (price, decimals) = _ratePrice(asset, h, v);
        } else {
            (price, decimals) = _primaryPrice(asset, v);
            // #2419: a composed price can floor to zero from positive feeds.
            if (price == 0) revert ZeroPrice(asset);
            _enforceSecondaryQuorum(asset, price, decimals, v);
        }
        if (price == 0) revert ZeroPrice(asset);
    }

    /// @dev The underlying's price, with every check it has, times the
    ///      accepted rate; then the lower of that and the token's market
    ///      price when the binding names a market feed.
    function _ratePrice(address token, bytes32 hash, Ver memory v)
        private
        view
        returns (uint256 price, uint8 decimals)
    {
        RateBinding memory b = _rateBinding[hash];
        uint256 rate = _acceptedRate(token, hash, b, _requireRate(token, b));
        (uint256 up, uint8 ud) = _primaryPrice(b.underlying, v);
        if (up == 0) revert ZeroPrice(b.underlying);
        _enforceSecondaryQuorum(b.underlying, up, ud, v);
        price = Math.mulDiv(up, rate, 1e18);
        decimals = ud;
        if (b.marketFeed != address(0)) {
            (bool ok, uint256 mp, uint8 md) = _readWithin(b.marketFeed, b.marketHeartbeat);
            if (!ok) revert StalePriceData();
            uint8 dec = md > ud ? md : ud;
            uint256 fromRate = _rescale(price, ud, dec);
            uint256 fromMarket = _rescale(mp, md, dec);
            price = fromRate < fromMarket ? fromRate : fromMarket;
            decimals = dec;
        }
    }

    /// @dev The rate a read uses: refused as distrusted while the source is
    ///      muted, while a recorded fall is unconfirmed, or when the source
    ///      now reports a fall past the bound; else the lower of the
    ///      reported rate and the accepted one grown by the daily bound.
    function _acceptedRate(address token, bytes32 hash, RateBinding memory b, uint256 reported)
        private
        view
        returns (uint256)
    {
        RateState storage st = _rate[token][hash];
        uint256 accepted = st.accepted;
        if (rateMuted[token] || st.observedSince != 0 || st.at == 0 || _fellPast(reported, accepted, b.maxFallBps)) {
            revert RatePriceDistrusted(token);
        }
        uint256 cap = _rateCap(accepted, st.at, b.maxRiseBpsPerDay);
        return reported < cap ? reported : cap;
    }

    /// @dev The latest outage of the sequencer behind `feed`; see
    ///      {sequencerOutageWindow}.
    function _outageWindow(address feed) private view returns (uint256 downAt, uint256 windowEnd) {
        if (feed == address(0)) return (0, 0);
        uint80 roundId;
        int256 answer;
        uint256 startedAt;
        try AggregatorV3Interface(feed).latestRoundData() returns (uint80 r, int256 a, uint256 st, uint256, uint80) {
            (roundId, answer, startedAt) = (r, a, st);
        } catch {
            return (block.timestamp, block.timestamp + SEQUENCER_GRACE_PERIOD);
        }
        // A missing or future start is a broken feed: read as down from now.
        if (startedAt == 0 || startedAt > block.timestamp) {
            return (block.timestamp, block.timestamp + SEQUENCER_GRACE_PERIOD);
        }
        if (answer != 0) return (startedAt, block.timestamp + SEQUENCER_GRACE_PERIOD);
        // Up since `startedAt`: the outage began at the previous round, when
        // that round is readable and was a down round; otherwise unknown,
        // and only the recovery grace counts.
        downAt = startedAt;
        windowEnd = startedAt + SEQUENCER_GRACE_PERIOD;
        if (roundId == 0) return (downAt, windowEnd);
        try AggregatorV3Interface(feed).getRoundData(roundId - 1) returns (uint80, int256 pa, uint256 pst, uint256, uint80) {
            if (pa != 0 && pst != 0 && pst <= startedAt) downAt = pst;
        } catch {}
    }

    /// @dev The Chainlink primary, quoted in the numeraire.
    ///      - Retail (PAD is the numeraire): the asset/numeraire feed from the
    ///        registry, else asset/ETH × ETH/numeraire. WETH reads the ETH
    ///        anchor directly.
    ///      - Industrial (PAD differs): an asset's direct asset/<numeraire>
    ///        feed when one is set, else its PAD price × PAD/<numeraire>.
    function _primaryPrice(address asset, Ver memory v) private view returns (uint256 price, uint8 decimals) {
        _requireSequencerHealthy(v);
        if (padIsNumeraire()) return _padPrice(asset, v);

        address direct = _ca(Kind.AssetDirectFeed, _w(asset), v);
        if (direct != address(0)) return _readStrict(direct, true, v);
        (uint256 padPrice, uint8 padDec) = _padPrice(asset, v);
        (uint256 fx, uint8 fxDec) = _padNumeraireRate(v);
        return _composePrice(padPrice, padDec, fx, fxDec);
    }

    /// @dev The asset's price in PAD units.
    function _padPrice(address asset, Ver memory v) private view returns (uint256 price, uint8 decimals) {
        address anchor = _ethAnchorFeed(v);
        if (asset != address(0) && asset == _ca(Kind.Weth, 0, v)) {
            if (anchor == address(0)) revert NoPriceFeed();
            (uint256 p, uint8 d) = _readStrict(anchor, false, v);
            _validatePythCrossCheck(p, d, v);
            return (p, d);
        }

        address registry = _ca(Kind.FeedRegistry, 0, v);
        if (registry != address(0)) {
            address feed = _registryFeed(registry, asset, PAD_DENOMINATOR, v);
            if (feed != address(0)) return _readStrict(feed, true, v);

            if (anchor != address(0)) {
                address ethQuoted = _registryFeed(registry, asset, ETH_DENOMINATOR, v);
                if (ethQuoted != address(0)) {
                    (uint256 perEth, uint8 perEthDec) = _readStrict(ethQuoted, false, v);
                    (uint256 ethPad, uint8 ethDec) = _readStrict(anchor, false, v);
                    _validatePythCrossCheck(ethPad, ethDec, v);
                    return _composePrice(perEth, perEthDec, ethPad, ethDec);
                }
            }
        }
        revert NoPriceFeed();
    }

    /// @dev PAD/<numeraire>: the direct feed when set, else ETH/<numeraire> ÷
    ///      ETH/PAD at the finer of the two precisions.
    function _padNumeraireRate(Ver memory v) private view returns (uint256 rate, uint8 decimals) {
        address direct = _ca(Kind.PadNumeraireRateFeed, 0, v);
        if (direct != address(0)) return _readStrict(direct, true, v);
        address numerFeed = _ca(Kind.EthNumeraireFeed, 0, v);
        address padFeed = _ca(Kind.EthPadFeed, 0, v);
        if (numerFeed == address(0) || padFeed == address(0)) revert PadNumeraireRateUnavailable();
        (uint256 ethNumer, uint8 numerDec) = _readStrict(numerFeed, false, v);
        (uint256 ethPad, uint8 padDec) = _readStrict(padFeed, false, v);
        _validatePythCrossCheck(ethPad, padDec, v);
        uint8 outDec = numerDec > padDec ? numerDec : padDec;
        uint256 numerScaled = _rescale(ethNumer, numerDec, outDec);
        uint256 padScaled = _rescale(ethPad, padDec, outDec);
        if (padScaled == 0) revert PadNumeraireRateUnavailable();
        rate = (numerScaled * (10 ** outDec)) / padScaled;
        decimals = outDec;
    }

    /// @dev The registry's feed for (`base`, `quote`) at the read's version;
    ///      zero when none or the read fails. The registry is the chain's own
    ///      VaipakamFeedRegistry (#2880), which answers Chainlink's `getFeed`
    ///      shape on every chain; the newest version asks exactly that.
    // slither-disable-next-line chainlink-feed-registry
    function _registryFeed(address registry, address base, address quote, Ver memory v)
        private
        view
        returns (address)
    {
        if (quote == address(0)) return address(0);
        if (v.latest) {
            try FeedRegistryInterface(registry).getFeed(base, quote) returns (AggregatorV2V3Interface f) {
                return address(f);
            } catch {
                return address(0);
            }
        }
        try IVersionedFeedRegistry(registry).getFeedAt(base, quote, v.r) returns (address f) {
            return f;
        } catch {
            return address(0);
        }
    }

    /// @dev A Chainlink read that reverts {StalePriceData} unless the
    ///      answer passes {_freshEnough}.
    function _readStrict(address feed, bool allowStablePeg, Ver memory v)
        private
        view
        returns (uint256 price, uint8 decimals)
    {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || roundId != answeredInRound) {
            revert StalePriceData();
        }
        uint256 age = block.timestamp - updatedAt;
        // The outer bound before `decimals()`, so a stale feed reports itself
        // as stale rather than tripping on an odd `decimals()` reply.
        if (age > STABLE_STALENESS) revert StalePriceData();
        uint8 dec = AggregatorV3Interface(feed).decimals();
        if (!_freshEnough(feed, answer, age, dec, allowStablePeg, v)) revert StalePriceData();
        // safe: `answer` > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(answer), dec);
    }

    /// @dev The ONE freshness rule for a Chainlink answer. A volatile feed
    ///      must be at most {VOLATILE_STALENESS} old; a stable one may be up
    ///      to {STABLE_STALENESS} old only when its answer sits at a peg. A
    ///      per-feed override only adds bounds: a shorter staleness budget
    ///      and a floor on the answer (#2742).
    function _freshEnough(address feed, int256 answer, uint256 age, uint8 dec, bool allowStablePeg, Ver memory v)
        private
        view
        returns (bool)
    {
        int256 floor = int256(uint256(_c(Kind.FeedMinAnswer, _w(feed), v)));
        if (floor > 0 && answer < floor) return false;
        uint256 maxAge = uint256(_c(Kind.FeedMaxStaleness, _w(feed), v));
        if (maxAge > 0 && age > maxAge) return false;
        if (age > STABLE_STALENESS) return false;
        if (age > VOLATILE_STALENESS) {
            if (!allowStablePeg) return false;
            if (!_answerWithinAnyPeg(answer, dec, v)) return false;
        }
        return true;
    }

    /// @dev An 8-decimal answer within {PEG_TOLERANCE_BPS} of $1 or of a
    ///      registered fiat or commodity reference.
    function _answerWithinAnyPeg(int256 answer, uint8 dec, Ver memory v) private view returns (bool) {
        if (dec != 8) return false;
        if (_withinPeg(answer, USD_PEG_1E8)) return true;
        uint256 n = _stableRefSymbols.length();
        for (uint256 i; i < n; ++i) {
            address ref = _ca(Kind.StableRef, _stableRefSymbols.at(i), v);
            if (ref == address(0)) continue;
            (bool ok, int256 peg) = _readRefPeg(ref);
            if (ok && _withinPeg(answer, peg)) return true;
        }
        return false;
    }

    /// @dev A peg reference (EUR/USD, XAU/USD...): fresh within the stable
    ///      ceiling and 8 decimals, never reverting.
    function _readRefPeg(address feed) private view returns (bool ok, int256 answer) {
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId, int256 a, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (a <= 0 || updatedAt == 0 || updatedAt > block.timestamp || roundId != answeredInRound) return (false, 0);
            if (block.timestamp - updatedAt > STABLE_STALENESS) return (false, 0);
            answer = a;
        } catch {
            return (false, 0);
        }
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            if (d != 8) return (false, 0);
        } catch {
            return (false, 0);
        }
        return (true, answer);
    }

    function _withinPeg(int256 answer, int256 peg) private pure returns (bool) {
        if (peg <= 0) return false;
        int256 diff = answer > peg ? answer - peg : peg - answer;
        // safe: `peg` > 0 and `diff` >= 0.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(diff) * BPS) / uint256(peg) <= PEG_TOLERANCE_BPS;
    }

    function _requireSequencerHealthy(Ver memory v) private view {
        address feed = _ca(Kind.SequencerFeed, 0, v);
        if (feed == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = AggregatorV3Interface(feed).latestRoundData();
        // A start time in the future is a broken feed, read as down rather
        // than left to underflow.
        if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) revert SequencerDown();
        if (block.timestamp - startedAt < SEQUENCER_GRACE_PERIOD) revert SequencerGracePeriod();
    }

    /// @dev Cross-check an ETH-anchor reading against Pyth. Soft-skips when
    ///      the gate is off, Pyth fails, or its snapshot is non-positive,
    ///      stale or low-confidence; reverts {OracleCrossCheckDivergence} on a
    ///      deviation beyond tolerance.
    // The publishTime and confidence gates sit below the snapshot copy;
    // both are load-bearing and tested.
    // slither-disable-start pyth-unchecked-publishtime
    // slither-disable-start pyth-unchecked-confidence
    function _validatePythCrossCheck(uint256 chainlinkPrice, uint8 chainlinkDecimals, Ver memory v) private view {
        address pyth = _ca(Kind.PythOracle, 0, v);
        bytes32 feedId = _c(Kind.PythFeedId, 0, v);
        if (pyth == address(0) || feedId == bytes32(0)) return;
        IPyth.Price memory snap;
        try IPyth(pyth).getPriceUnsafe(feedId) returns (IPyth.Price memory p) {
            snap = p;
        } catch {
            return;
        }
        if (snap.price <= 0) return;
        if (block.timestamp > snap.publishTime + uint256(_c(Kind.PythMaxStaleness, 0, v))) return;
        uint256 pythScaled = _pythPriceToScale(uint256(uint64(snap.price)), snap.expo, chainlinkDecimals);
        if (pythScaled == 0) return;
        uint256 confBps = (uint256(snap.conf) * BPS) / uint256(uint64(snap.price));
        if (confBps > uint256(_c(Kind.PythConfidenceMaxBps, 0, v))) return;
        uint256 absDelta = chainlinkPrice > pythScaled ? chainlinkPrice - pythScaled : pythScaled - chainlinkPrice;
        uint256 deviationBps = (absDelta * BPS) / chainlinkPrice;
        uint256 maxDev = uint256(_c(Kind.PythMaxDeviationBps, 0, v));
        if (deviationBps > maxDev) {
            revert OracleCrossCheckDivergence(chainlinkPrice, pythScaled, deviationBps, maxDev);
        }
    }
    // slither-disable-end pyth-unchecked-confidence
    // slither-disable-end pyth-unchecked-publishtime

    /// @dev Pyth's (price, expo) in `targetDecimals`; 0 (treated as no data)
    ///      when the scale step exceeds 30 decimals either way.
    function _pythPriceToScale(uint256 magnitude, int32 expo, uint8 targetDecimals) private pure returns (uint256) {
        int256 net = int256(uint256(targetDecimals)) + int256(expo);
        if (net >= 0) {
            if (net > 30) return 0;
            // forge-lint: disable-next-line(unsafe-typecast)
            return magnitude * (10 ** uint256(net));
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 down = uint256(-net);
        if (down > 30) return 0;
        return magnitude / (10 ** down);
    }

    /// @dev Every secondary unavailable: accept the primary alone. Any one
    ///      counted source agreeing: accept. Some disagreeing and none
    ///      agreeing: revert {OraclePriceDivergence}.
    function _enforceSecondaryQuorum(address asset, uint256 primary, uint8 dec, Ver memory v) private view {
        bytes32 symbol = _secondarySymbol(asset, v);
        if (symbol == bytes32(0)) return;
        SecondaryStatus[3] memory st = _secondaryStatuses(symbol, primary, dec, v);
        if (st[0] == SecondaryStatus.Agree || st[1] == SecondaryStatus.Agree || st[2] == SecondaryStatus.Agree) return;
        if (st[0] == SecondaryStatus.Disagree || st[1] == SecondaryStatus.Disagree || st[2] == SecondaryStatus.Disagree) {
            revert OraclePriceDivergence();
        }
    }

    /// @dev The one reading of every source as the quorum counts it, in
    ///      {Source} order: a removed source is not asked, and a muted
    ///      source's agreement reads as no data while its disagreement stands.
    function _secondaryStatuses(bytes32 symbol, uint256 primary, uint8 dec, Ver memory v)
        private
        view
        returns (SecondaryStatus[3] memory st)
    {
        st[0] = _asCounted(Source.Tellor, _checkTellor(symbol, primary, dec, v));
        st[1] = _asCounted(Source.Api3, _checkApi3(symbol, primary, dec, v));
        st[2] = _asCounted(Source.Dia, _checkDia(symbol, primary, dec, v));
    }

    function _asCounted(Source source, SecondaryStatus status) private view returns (SecondaryStatus) {
        if (status == SecondaryStatus.Agree && secondaryState[source] == SecondaryState.Muted) {
            return SecondaryStatus.Unavailable;
        }
        return status;
    }

    /// @dev The source contract a probe may ask, or zero when it is unset or
    ///      removed.
    function _liveSource(Source source, Ver memory v) private view returns (address) {
        if (secondaryState[source] == SecondaryState.Removed) return address(0);
        return _ca(Kind.SecondarySource, bytes32(uint256(uint8(source))), v);
    }

    /// @dev Tellor SpotPrice: the newest value reported at least
    ///      {TELLOR_DISPUTE_BUFFER} ago (#665), 18 decimals.
    function _checkTellor(bytes32 symbol, uint256 primary, uint8 dec, Ver memory v)
        private
        view
        returns (SecondaryStatus)
    {
        address oracle = _liveSource(Source.Tellor, v);
        if (oracle == address(0)) return SecondaryStatus.Unavailable;
        if (block.timestamp <= TELLOR_DISPUTE_BUFFER) return SecondaryStatus.Unavailable;
        bytes32 queryId = keccak256(
            abi.encode("SpotPrice", abi.encode(_toLower(_wordToString(symbol)), _wordToString(NUMERAIRE_SYMBOL)))
        );
        bytes memory raw;
        uint256 reportedAt;
        try ITellor(oracle).getDataBefore(queryId, block.timestamp - TELLOR_DISPUTE_BUFFER) returns (
            bytes memory v, uint256 t
        ) {
            raw = v;
            reportedAt = t;
        } catch {
            return SecondaryStatus.Unavailable;
        }
        if (reportedAt == 0 || raw.length < 32) return SecondaryStatus.Unavailable;
        if (block.timestamp - reportedAt > uint256(_c(Kind.SecondaryMaxStaleness, 0, v))) return SecondaryStatus.Unavailable;
        uint256 at18 = abi.decode(raw, (uint256));
        if (at18 == 0) return SecondaryStatus.Unavailable;
        return _classify(primary, _rescale(at18, 18, dec), v);
    }

    /// @dev API3 dAPI `<SYMBOL>/<NUMERAIRE>`, 18 decimals.
    function _checkApi3(bytes32 symbol, uint256 primary, uint8 dec, Ver memory v)
        private
        view
        returns (SecondaryStatus)
    {
        address server = _liveSource(Source.Api3, v);
        if (server == address(0)) return SecondaryStatus.Unavailable;
        bytes memory packed = abi.encodePacked(_toUpper(_wordToString(symbol)), "/", _numeraireUpper());
        if (packed.length > 32) return SecondaryStatus.Unavailable;
        bytes32 dapiName;
        for (uint256 i; i < packed.length; ++i) {
            dapiName |= bytes32(packed[i]) >> (i * 8);
        }
        int224 value;
        uint32 reportedAt;
        try IApi3ServerV1(server).readDataFeedWithDapiNameHash(keccak256(abi.encodePacked(dapiName))) returns (
            int224 v, uint32 t
        ) {
            value = v;
            reportedAt = t;
        } catch {
            return SecondaryStatus.Unavailable;
        }
        if (value <= 0 || reportedAt == 0) return SecondaryStatus.Unavailable;
        if (block.timestamp - reportedAt > uint256(_c(Kind.SecondaryMaxStaleness, 0, v))) return SecondaryStatus.Unavailable;
        // safe: `value` > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return _classify(primary, _rescale(uint256(int256(value)), 18, dec), v);
    }

    /// @dev DIA key `<SYMBOL>/<NUMERAIRE>`, 8 decimals.
    function _checkDia(bytes32 symbol, uint256 primary, uint8 dec, Ver memory v)
        private
        view
        returns (SecondaryStatus)
    {
        address oracle = _liveSource(Source.Dia, v);
        if (oracle == address(0)) return SecondaryStatus.Unavailable;
        string memory key = string(abi.encodePacked(_toUpper(_wordToString(symbol)), "/", _numeraireUpper()));
        uint128 value;
        uint128 reportedAt;
        try IDIAOracleV2(oracle).getValue(key) returns (uint128 v, uint128 t) {
            value = v;
            reportedAt = t;
        } catch {
            return SecondaryStatus.Unavailable;
        }
        if (value == 0 || reportedAt == 0) return SecondaryStatus.Unavailable;
        if (block.timestamp - uint256(reportedAt) > uint256(_c(Kind.SecondaryMaxStaleness, 0, v))) return SecondaryStatus.Unavailable;
        return _classify(primary, _rescale(uint256(value), 8, dec), v);
    }

    /// @dev Agree within the secondary tolerance; a secondary that scales to
    ///      zero is no data.
    function _classify(uint256 primary, uint256 secondary, Ver memory v) private view returns (SecondaryStatus) {
        if (secondary == 0) return SecondaryStatus.Unavailable;
        uint256 diff = primary > secondary ? primary - secondary : secondary - primary;
        if ((diff * BPS) / primary > uint256(_c(Kind.SecondaryMaxDeviationBps, 0, v))) return SecondaryStatus.Disagree;
        return SecondaryStatus.Agree;
    }

    /// @dev #2745: the asset's price identity is the base symbol of its
    ///      registered pair, never the token's own `symbol()`. Looked up
    ///      under the quotes the primary tries, in its order. WETH is ETH.
    ///      Zero (every secondary Unavailable) when no pair is registered.
    function _secondarySymbol(address asset, Ver memory v) private view returns (bytes32) {
        if (asset != address(0) && asset == _ca(Kind.Weth, 0, v)) return bytes32("ETH");
        address registry = _ca(Kind.FeedRegistry, 0, v);
        if (registry == address(0)) return bytes32(0);
        bytes32 symbol = _pairBase(registry, asset, PAD_DENOMINATOR, v);
        if (symbol == bytes32(0)) symbol = _pairBase(registry, asset, ETH_DENOMINATOR, v);
        return symbol;
    }

    /// @dev One `pairBase` read at the read's version; a failure or a reply
    ///      that is not one word is zero.
    function _pairBase(address registry, address base, address quote, Ver memory v)
        private
        view
        returns (bytes32 symbol)
    {
        bytes memory call = v.latest
            ? abi.encodeCall(IFeedRegistryPairBase.pairBase, (base, quote))
            : abi.encodeCall(IVersionedFeedRegistry.pairBaseAt, (base, quote, v.r));
        (bool ok, bytes memory ret) = registry.staticcall(call);
        if (ok && ret.length == 32) symbol = abi.decode(ret, (bytes32));
    }

    function _numeraireUpper() private view returns (string memory) {
        return _toUpper(_wordToString(NUMERAIRE_SYMBOL));
    }
}
