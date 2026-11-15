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
import {PriceGuardReader} from "./PriceGuardReader.sol";

/**
 * @title  PriceGuard
 * @author Vaipakam Developer Team
 * @notice The one price source the Diamond and every user vault read (#3272;
 *         `docs/DesignsAndPlans/PriceGuardDesign.md`). It runs the whole
 *         pricing path the Diamond's oracle ran, unchanged:
 *         - the Chainlink primary, found through the chain's
 *           `VaipakamFeedRegistry`, with the ETH pivot;
 *         - the staleness, stable-peg and per-feed rules;
 *         - the L2 sequencer check;
 *         - the Pyth cross-check on the ETH anchor;
 *         - the soft 2-of-N secondary quorum (Tellor, API3, DIA).
 *         The Diamond finds it through the `ProtocolRegistry` pointer
 *         `RegistryKeys.PRICE_GUARD`, never from Diamond storage. A vault
 *         never reads a mutable registry (#3431): it holds the address in its
 *         own code (#3268). Either way no facet can choose the price a vault
 *         checks against.
 *
 * @dev    Rules this contract holds by itself, whatever its owner's own
 *         configuration says:
 *         - It is not upgradeable. A different rule set is a new guard,
 *           swapped in by the registry pointer under the registry's delay.
 *         - Its numeraire is fixed at construction: the Chainlink
 *           denominator its prices are quoted in, that numeraire's symbol for
 *           the secondary queries, and the predominant denominator (PAD) the
 *           industrial-fork pivot reads through. The ETH denominator is fixed
 *           too. The feeds behind them, and which token is the chain's WETH,
 *           stay replaceable under the delay.
 *         - The constructor's config is the only config that applies without
 *           waiting (owner decision 2026-11-09). A guard goes live only
 *           through the registry's delayed pointer swap, which the guardian
 *           can cancel, so that wait is its starting config's review window.
 *         - Every later change is the owner's proposal (the Timelock's),
 *           executable by anyone no sooner than the delay later, with one
 *           change pending per entry. Its waiting time is fixed when it is
 *           proposed. The owner or the guardian may cancel a pending change.
 *         - The delay is 7 to 14 days on a production chain, never shorter
 *           than the vault code delay (owner decision 2026-11-10): a price
 *           change can move value out of every vault, so it is visible at
 *           least as long as a vault code change. A testnet may set 0, as
 *           the feed registry allows. Raising the delay applies at once;
 *           lowering it waits the current delay.
 *         - One fast lever: the owner or the guardian (the Pauser Safe) may
 *           MUTE a secondary source at once (#3537). A muted source no
 *           longer approves a price, but it still refuses one it contradicts,
 *           so muting can only refuse more prices, never accept one the
 *           quorum refused. Removing a source's refusals too loosens the
 *           quorum, so it waits {SECONDARY_REMOVAL_DELAY} after it is
 *           proposed, visibly, and the owner or the guardian may cancel it.
 *           Re-enabling a muted or removed source waits the delay.
 *         - Every price setting is VERSIONED (#3437,
 *           `LoanSettingsSnapshotDesign.md`). Each executed change to one
 *           raises the guard's config {epoch} by one, and the old value is
 *           kept, so every price read can also be made "as of" a price
 *           version: the guard epoch together with the feed registry's own
 *           epoch. A loan opened at a version keeps reading that version.
 *           The stop levers (muting, removal, a rate source's mute) are not
 *           versioned: a stop reaches every version at once, and can only
 *           refuse more. A retired version is refused by the guard itself:
 *           the {priceFloor}, raised only through the delayed change path
 *           and only to the current version, answers no read below it.
 *         - A token that stands for a growing amount of another one (a
 *           staked form of a chain's native asset, a vault share) may be
 *           priced from its exchange rate (#3683,
 *           `RatePricedCollateralDesign.md`): the underlying's price, with
 *           every check it has, times the token's rate. The rate may not rise
 *           faster than its binding's daily bound, a fall past the binding's
 *           bound marks the price distrusted until the new level is
 *           confirmed under a fixed rule, and an optional market feed may
 *           only lower the result. Such a token is collateral only.
 *         - Its pricing path runs in a separate immutable contract, the
 *           {PriceGuardReader} named at construction (#3437; the split keeps
 *           both under the contract size limit). Every price read runs the
 *           reader's code over this guard's storage inside a static call, so
 *           a read can never write. The reader must carry this guard's
 *           numeraire identity, and the two share one storage layout
 *           ({PriceGuardState}).
 *         - Every write emits an event naming exactly what it changed.
 */
contract PriceGuard is PriceGuardState, Ownable2Step {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice The contract whose code answers every price read (#3437).
    address public immutable READER;

    /// @notice The reader is not a {PriceGuardReader} built for this guard's
    ///         identity.
    error ReaderMismatch(address reader);
    /// @notice {readThroughReader} is the guard's own entry.
    error NotSelf();

    // ─── Construction ────────────────────────────────────────────────────

    /// @param owner_    The chain's admin (the Timelock takes it at handover).
    /// @param guardian_ The Pauser Safe (the admin until the handover moves it).
    /// @param id        The numeraire identity, fixed for life.
    /// @param delay_    The starting delay, within the chain's bounds.
    /// @param initial   The starting price config, applied as epoch 1 through
    ///                  the same checks as an executed change. Unnamed knobs
    ///                  take their defaults; unnamed feeds and sources start
    ///                  unset. Rate bindings, levers and the floor are refused
    ///                  here: they come later, through the delay.
    /// @param reader_   The {PriceGuardReader} built for this identity.
    constructor(
        address owner_,
        address guardian_,
        Identity memory id,
        uint64 delay_,
        Change[] memory initial,
        address reader_
    ) PriceGuardState(id) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        _requireReader(reader_);
        READER = reader_;
        _checkDelay(delay_);
        delay = delay_;
        guardian = guardian_;
        epoch = 1;
        rateObservation = RATE_OBSERVATION_DEFAULT;
        emit GuardianSet(address(0), guardian_);
        emit DelaySet(0, delay_);
        emit EpochAdvanced(1);

        _apply(Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(300)), 1);
        _apply(Kind.PythMaxDeviationBps, bytes32(0), bytes32(uint256(500)), 1);
        _apply(Kind.PythConfidenceMaxBps, bytes32(0), bytes32(uint256(100)), 1);
        _apply(Kind.SecondaryMaxDeviationBps, bytes32(0), bytes32(uint256(500)), 1);
        _apply(Kind.SecondaryMaxStaleness, bytes32(0), bytes32(uint256(3600)), 1);
        for (uint256 i; i < initial.length; ++i) {
            if (!_isPriceSetting(initial[i].kind) || initial[i].kind == Kind.RateBinding) {
                revert InvalidChange(initial[i].kind, initial[i].subject, initial[i].value);
            }
            _apply(initial[i].kind, initial[i].subject, initial[i].value, 1);
        }
    }


    /// @dev The reader must carry exactly this guard's identity: a reader
    ///      built for another numeraire would price in it.
    function _requireReader(address reader_) private view {
        if (reader_.code.length == 0) revert ReaderMismatch(reader_);
        (Identity memory r, bool testnet) = PriceGuardReader(reader_).identity();
        if (
            r.numeraireDenominator != NUMERAIRE_DENOMINATOR || r.numeraireSymbol != NUMERAIRE_SYMBOL
                || r.padDenominator != PAD_DENOMINATOR || r.ethDenominator != ETH_DENOMINATOR || testnet != TESTNET
        ) revert ReaderMismatch(reader_);
    }

    // ─── Price reads, answered by the reader ─────────────────────────────

    /// @inheritdoc IPriceGuard
    function getAssetPrice(address) external view returns (uint256 price, uint8 decimals) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function getAssetPriceAt(address, uint64, uint64) external view returns (uint256 price, uint8 decimals) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function getAssetPriceStatus(address)
        external
        view
        returns (PriceStatus status, uint256 price, uint8 decimals)
    {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function getAssetPriceStatusAt(address, uint64, uint64)
        external
        view
        returns (PriceStatus status, uint256 price, uint8 decimals)
    {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function tryGetAssetPrice(address) external view returns (bool ok, uint256 price, uint8 decimals) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function tryGetAssetPriceAt(address, uint64, uint64)
        external
        view
        returns (bool ok, uint256 price, uint8 decimals)
    {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function countLiveSecondaryOracleFeeds(address) external view returns (uint8 agreeing, uint8 disagreeing) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function sequencerHealthy() external view returns (bool healthy) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function sequencerOutageWindow() external view returns (uint256 downAt, uint256 windowEnd) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function sequencerOutageWindowAt(uint64) external view returns (uint256 downAt, uint256 windowEnd) {
        _forward();
    }

    /// @inheritdoc IPriceGuard
    function readFeed(address, bool) external view returns (bool ok, uint256 price, uint8 decimals) {
        _forward();
    }

    /// @notice The guard's own entry for its reads: runs the reader's code on
    ///         `data` over this guard's storage. Only the guard may call it,
    ///         and it does so only inside a static call ({_forward}), so the
    ///         reader's code can never write here.
    function readThroughReader(bytes calldata data) external {
        if (msg.sender != address(this)) revert NotSelf();
        (bool ok, bytes memory ret) = READER.delegatecall(data);
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(ret, 32), mload(ret)) }
            return(add(ret, 32), mload(ret))
        }
    }

    /// @dev Answer the current call from the reader, returning or reverting
    ///      with exactly what it did. Reads `ret`, a bytes array this
    ///      function holds, only within its length.
    function _forward() private view {
        (bool ok, bytes memory ret) = address(this).staticcall(abi.encodeCall(this.readThroughReader, (msg.data)));
        assembly ("memory-safe") {
            if iszero(ok) { revert(add(ret, 32), mload(ret)) }
            return(add(ret, 32), mload(ret))
        }
    }

    // ─── Version and config reads ────────────────────────────────────────

    /// @notice The live value of a setting, as its {Kind} encodes it.
    function config(Kind kind, bytes32 subject) external view returns (bytes32) {
        return _cfg[_id(kind, subject)];
    }

    /// @notice The value a price setting had at guard epoch `at` (#3437).
    function configAt(Kind kind, bytes32 subject, uint64 at) external view returns (bytes32) {
        if (at == 0 || at > epoch) revert UnknownPriceVersion(at, 0);
        return _valueAt(_id(kind, subject), at);
    }

    // Named reads of the live settings, for consoles and scripts that read
    // one setting by name. Each is {config} for one {Kind}.

    function ethPadFeed() external view returns (address) {
        return _addr(_cfg[_id(Kind.EthPadFeed, 0)]);
    }

    function padNumeraireRateFeed() external view returns (address) {
        return _addr(_cfg[_id(Kind.PadNumeraireRateFeed, 0)]);
    }

    function pythOracle() external view returns (address) {
        return _addr(_cfg[_id(Kind.PythOracle, 0)]);
    }

    function pythFeedId() external view returns (bytes32) {
        return _cfg[_id(Kind.PythFeedId, 0)];
    }

    function pythMaxStaleness() external view returns (uint64) {
        return uint64(uint256(_cfg[_id(Kind.PythMaxStaleness, 0)]));
    }

    function pythMaxDeviationBps() external view returns (uint16) {
        return uint16(uint256(_cfg[_id(Kind.PythMaxDeviationBps, 0)]));
    }

    function pythConfidenceMaxBps() external view returns (uint16) {
        return uint16(uint256(_cfg[_id(Kind.PythConfidenceMaxBps, 0)]));
    }

    function secondaryMaxDeviationBps() external view returns (uint16) {
        return uint16(uint256(_cfg[_id(Kind.SecondaryMaxDeviationBps, 0)]));
    }

    function secondaryMaxStaleness() external view returns (uint40) {
        return uint40(uint256(_cfg[_id(Kind.SecondaryMaxStaleness, 0)]));
    }

    function secondarySource(Source source) external view returns (address) {
        return _addr(_cfg[_id(Kind.SecondarySource, bytes32(uint256(uint8(source))))]);
    }

    function feedMaxStaleness(address feed) external view returns (uint40) {
        return uint40(uint256(_cfg[_id(Kind.FeedMaxStaleness, _w(feed))]));
    }

    function feedMinAnswer(address feed) external view returns (int256) {
        return int256(uint256(_cfg[_id(Kind.FeedMinAnswer, _w(feed))]));
    }

    function assetDirectFeed(address asset) external view returns (address) {
        return _addr(_cfg[_id(Kind.AssetDirectFeed, _w(asset))]);
    }

    function stableRefFeed(bytes32 symbol) external view returns (address) {
        return _addr(_cfg[_id(Kind.StableRef, symbol)]);
    }

    /// @notice The ETH anchor the PAD price reads WETH and the ETH pivot from:
    ///         the ETH/PAD feed, or the ETH/<numeraire> feed when none is set.
    function ethAnchorFeed() external view returns (address) {
        return _ethAnchorFeed(_latest());
    }

    /// @notice Every stable-peg reference symbol with a live feed, in no
    ///         particular order.
    function stableRefSymbols() external view returns (bytes32[] memory out) {
        bytes32[] memory all = _stableRefSymbols.values();
        uint256 n;
        out = new bytes32[](all.length);
        for (uint256 i; i < all.length; ++i) {
            if (_cfg[_id(Kind.StableRef, all[i])] != bytes32(0)) out[n++] = all[i];
        }
        assembly ("memory-safe") {
            mstore(out, n)
        }
    }

    /// @notice A rate binding registered by {proposeRateBinding}.
    function rateBindingOf(bytes32 hash) external view returns (RateBinding memory) {
        return _rateBinding[hash];
    }

    /// @notice What the guard has measured of `token`'s rate under binding
    ///         `hash` (#3683).
    function rateStateOf(address token, bytes32 hash) external view returns (RateState memory) {
        return _rate[token][hash];
    }

    /// @notice The pending change to (`kind`, `subject`); `executableAt` 0 = none.
    function pendingChange(Kind kind, bytes32 subject) external view returns (bytes32 value, uint256 executableAt) {
        Pending storage p = _pending[_id(kind, subject)];
        return (p.value, p.executableAt);
    }

    /// @notice Propose a change, executable by anyone once `delay` has passed.
    ///         It is checked now and again when it is executed.
    ///         A rate binding is set through {proposeRateBinding}; here it
    ///         may only be removed (value zero).
    function proposeChange(Kind kind, bytes32 subject, bytes32 value) external onlyOwner {
        if (kind == Kind.RateBinding && value != bytes32(0)) revert InvalidChange(kind, subject, value);
        _propose(kind, subject, value);
    }

    /// @notice Register a rate binding for `token` and propose it (#3683).
    ///         The binding is stored under its hash, which is the value the
    ///         proposed change carries, so it applies whole or not at all.
    ///         The rate the source reports now is the binding's first
    ///         accepted rate: from here to execution it is recorded under the
    ///         daily bound like any other, so a rate pushed up when the change
    ///         executes gains nothing.
    /// @return hash The binding's hash.
    function proposeRateBinding(address token, RateBinding calldata binding) external onlyOwner returns (bytes32 hash) {
        hash = keccak256(abi.encode(binding));
        _rateBinding[hash] = binding;
        emit RateBindingRegistered(hash, token, binding);
        _propose(Kind.RateBinding, _w(token), hash);
        RateState storage st = _rate[token][hash];
        if (st.at == 0) {
            uint256 reported = _requireRate(token, binding);
            // safe: `_requireRate` refuses a rate above uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            st.accepted = uint128(reported);
            st.at = uint64(block.timestamp);
            emit RateRecorded(token, hash, reported, reported);
        }
    }

    /// @notice Apply a pending change whose delay has passed. Anyone may call.
    ///         A change to a price setting raises the {epoch}. A floor change
    ///         that comes due after the current version moved on lapses: it
    ///         is dropped unapplied, and says so.
    function executeChange(Kind kind, bytes32 subject) external {
        Pending storage p = _pending[_id(kind, subject)];
        uint64 at = p.executableAt;
        if (at == 0) revert NothingPending(kind, subject);
        if (block.timestamp < at) revert NotReady(kind, subject, at);
        bytes32 value = p.value;
        delete _pending[_id(kind, subject)];
        if (kind == Kind.Delay) {
            uint64 d = uint64(uint256(value));
            emit DelaySet(delay, d);
            delay = d;
        } else if (kind == Kind.PriceFloor) {
            _raiseFloor(value);
        } else {
            uint64 e = epoch;
            if (_isPriceSetting(kind)) {
                e = ++epoch;
                emit EpochAdvanced(e);
            }
            _apply(kind, subject, value, e);
        }
    }

    /// @notice Cancel a pending change. The owner or the guardian; a cancel
    ///         only ever refuses a change.
    function cancelChange(Kind kind, bytes32 subject) external onlyOwnerOrGuardian {
        bytes32 key = _id(kind, subject);
        if (_pending[key].executableAt == 0) revert NothingPending(kind, subject);
        delete _pending[key];
        emit ChangeCancelled(kind, subject, msg.sender);
    }

    /// @notice Mute a secondary source at once (#3537): its agreement stops
    ///         counting, its disagreement still refuses. Stop-only: a muted
    ///         source can only refuse more prices, never accept one the
    ///         quorum refused. It also cancels a pending re-enable of that
    ///         source, even one already due, so a re-enable approved before
    ///         this stop cannot undo it; the way back is a new proposal that
    ///         waits the full delay. Muting a removed source changes nothing.
    function muteSecondary(Source source) external onlyOwnerOrGuardian {
        _cancelPending(Kind.SecondaryEnabled, bytes32(uint256(uint8(source))));
        if (secondaryState[source] != SecondaryState.Counted) return;
        secondaryState[source] = SecondaryState.Muted;
        emit SecondaryMuted(source, msg.sender);
    }

    /// @notice Propose removing a secondary source from the quorum (#3537).
    ///         The source is muted at once; its refusals stop counting only
    ///         when the removal executes, {SECONDARY_REMOVAL_DELAY} later.
    ///         This is the lever for a source that is broken rather than
    ///         wrong in the price's favour: while it waits, an asset that
    ///         source contradicts stays refused.
    function proposeSecondaryRemoval(Source source) external onlyOwnerOrGuardian {
        if (secondaryState[source] == SecondaryState.Removed) revert SecondaryAlreadyRemoved(source);
        uint64 pendingAt = secondaryRemovalAt[source];
        if (pendingAt != 0) revert SecondaryRemovalPending(source, pendingAt);
        _cancelPending(Kind.SecondaryEnabled, bytes32(uint256(uint8(source))));
        if (secondaryState[source] == SecondaryState.Counted) {
            secondaryState[source] = SecondaryState.Muted;
            emit SecondaryMuted(source, msg.sender);
        }
        uint64 at = uint64(block.timestamp) + SECONDARY_REMOVAL_DELAY;
        secondaryRemovalAt[source] = at;
        emit SecondaryRemovalProposed(source, msg.sender, at);
    }

    /// @notice Cancel a proposed removal. The owner or the guardian; a cancel
    ///         keeps the source's refusals and leaves it muted.
    function cancelSecondaryRemoval(Source source) external onlyOwnerOrGuardian {
        if (secondaryRemovalAt[source] == 0) revert NoSecondaryRemovalPending(source);
        delete secondaryRemovalAt[source];
        emit SecondaryRemovalCancelled(source, msg.sender);
    }

    /// @notice Execute a proposed removal once it has waited. Anyone may call.
    function executeSecondaryRemoval(Source source) external {
        uint64 at = secondaryRemovalAt[source];
        if (at == 0) revert NoSecondaryRemovalPending(source);
        if (block.timestamp < at) revert SecondaryRemovalNotReady(source, at);
        delete secondaryRemovalAt[source];
        secondaryState[source] = SecondaryState.Removed;
        emit SecondaryRemoved(source);
    }

    /// @notice Mute a token's rate source at once (#3683): its price reads as
    ///         distrusted at every version, which refuses close-outs rather
    ///         than moving them to the missing-price route. Stop-only. It
    ///         cancels a pending unmute, even one already due; unmuting is a
    ///         new proposal that waits the delay.
    function muteRateSource(address token) external onlyOwnerOrGuardian {
        _cancelPending(Kind.RateSourceEnabled, _w(token));
        if (rateMuted[token]) return;
        rateMuted[token] = true;
        emit RateSourceMuted(token, msg.sender);
    }

    /// @notice Record `token`'s rate under binding `hash` (#3683). Anyone may
    ///         call; the hourly checkpoint pass does, for every binding a
    ///         token has had, so a loan on an older binding keeps up too.
    ///         The accepted rate follows the source down at once, and up by at
    ///         most the binding's daily bound for the time since the last
    ///         record, counted as at most one day. A fall past the bound
    ///         marks the price distrusted and starts its observation; while
    ///         distrusted, each record keeps the lowest rate reported and
    ///         restarts the observation when a reading breaks the rule.
    function recordRate(address token, bytes32 hash) external {
        RateState storage st = _rate[token][hash];
        if (st.at == 0) revert UnknownRateBinding(token, hash);
        RateBinding memory b = _rateBinding[hash];
        uint256 reported = _requireRate(token, b);
        if (st.observedSince == 0) {
            uint256 accepted = st.accepted;
            // While the binding waits to execute, nothing is priced from it,
            // so a fall corrects the starting rate instead of marking a
            // price distrusted that no loan reads yet.
            if (!_rateBindingPending(token, hash) && _fellPast(reported, accepted, b.maxFallBps)) {
                st.observedSince = uint64(block.timestamp);
                st.preFall = uint128(accepted);
                st.lowest = uint128(reported);
                emit RateDistrusted(token, hash, accepted, reported);
                return;
            }
            uint256 cap = _rateCap(accepted, st.at, b.maxRiseBpsPerDay);
            accepted = reported < cap ? reported : cap;
            // safe: a reported rate above uint128 is refused by `_requireRate`.
            // forge-lint: disable-next-line(unsafe-typecast)
            st.accepted = uint128(accepted);
            st.at = uint64(block.timestamp);
            emit RateRecorded(token, hash, reported, accepted);
            return;
        }
        if (_fellPast(reported, st.lowest, b.maxFallBps) || reported > st.preFall) {
            st.observedSince = uint64(block.timestamp);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        if (reported < st.lowest) st.lowest = uint128(reported);
        emit RateObserved(token, hash, reported, st.lowest, st.observedSince);
    }

    /// @notice Confirm a distrusted rate (#3683). The owner or the guardian,
    ///         on one rule, choosing no number: allowed only once the rate
    ///         has been observed for {rateObservation} at or below the
    ///         pre-fall rate with no further fall past the bound, and the
    ///         rate it accepts is the lower of the lowest reported since the
    ///         fall and the rate reported now. From there the rate rises only
    ///         under the daily bound.
    function confirmRate(address token, bytes32 hash) external onlyOwnerOrGuardian {
        RateState storage st = _rate[token][hash];
        uint64 since = st.observedSince;
        if (since == 0) revert RateNotDistrusted(token, hash);
        RateBinding memory b = _rateBinding[hash];
        uint256 reported = _requireRate(token, b);
        if (_fellPast(reported, st.lowest, b.maxFallBps) || reported > st.preFall) {
            revert RateStillMoving(token, hash, reported);
        }
        uint256 confirmableAt = uint256(since) + rateObservation;
        if (block.timestamp < confirmableAt) revert RateObservationNotOver(token, hash, confirmableAt);
        uint256 level = reported < st.lowest ? reported : st.lowest;
        // forge-lint: disable-next-line(unsafe-typecast)
        st.accepted = uint128(level);
        st.at = uint64(block.timestamp);
        st.observedSince = 0;
        st.lowest = 0;
        st.preFall = 0;
        emit RateConfirmed(token, hash, level, msg.sender);
    }

    /// @notice Raise the delay at once: a longer wait only tightens. Changes
    ///         already pending keep their waiting time.
    function raiseDelay(uint64 newDelay) external onlyOwner {
        if (newDelay <= delay) revert DelayOutOfRange(newDelay, uint256(delay) + 1, MAX_DELAY);
        _checkDelay(newDelay);
        emit DelaySet(delay, newDelay);
        delay = newDelay;
    }

    /// @notice Set the guardian. Owner only: the owner is the Timelock, whose
    ///         own delay and canceller stand in front of this call.
    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, next);
        guardian = next;
    }

    /// @notice Disabled: a guard with no owner could never replace a feed.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        _;
    }

    function _propose(Kind kind, bytes32 subject, bytes32 value) private {
        Pending storage p = _pending[_id(kind, subject)];
        if (p.executableAt != 0) revert ChangePending(kind, subject);
        if (kind == Kind.Delay) {
            uint256 d = uint256(value);
            // One delay, so one pending lowering; a raise is instant.
            if (subject != bytes32(0) || d >= delay) revert InvalidChange(kind, subject, value);
            _checkDelay(uint64(d));
        } else {
            _validate(kind, subject, value);
        }
        uint64 at = uint64(block.timestamp) + delay;
        p.value = value;
        p.executableAt = at;
        emit ChangeProposed(kind, subject, value, at);
    }

    /// @dev Drop a pending change, even one already due.
    function _cancelPending(Kind kind, bytes32 subject) private {
        bytes32 key = _id(kind, subject);
        if (_pending[key].executableAt != 0) {
            delete _pending[key];
            emit ChangeCancelled(kind, subject, msg.sender);
        }
    }

    /// @dev Whether executing a change of `kind` changes what a price read
    ///      answers, and so raises the epoch.
    function _isPriceSetting(Kind kind) private pure returns (bool) {
        return kind <= Kind.AssetDirectFeed || kind == Kind.RateBinding;
    }

    function _checkDelay(uint64 d) private view {
        uint64 min = TESTNET ? 0 : MIN_DELAY;
        if (d < min || d > MAX_DELAY) revert DelayOutOfRange(d, min, MAX_DELAY);
    }

    /// @dev The one validation of a change, run at proposal and at execution
    ///      (a contract may lose its code in between only by self-destruct,
    ///      which no longer clears code; the second run guards a stale proposal).
    function _validate(Kind kind, bytes32 subject, bytes32 value) private view {
        uint256 v = uint256(value);
        if (kind == Kind.Delay) revert InvalidChange(kind, subject, value);
        bool keyed = kind == Kind.SecondarySource || kind == Kind.FeedMaxStaleness || kind == Kind.FeedMinAnswer
            || kind == Kind.StableRef || kind == Kind.AssetDirectFeed || kind == Kind.SecondaryEnabled
            || kind == Kind.RateBinding || kind == Kind.RateSourceEnabled;
        if (!keyed && subject != bytes32(0)) revert InvalidChange(kind, subject, value);

        if (kind == Kind.PythFeedId) return;
        if (kind == Kind.FeedMinAnswer) {
            _requireAddress(kind, subject, value, subject, false);
            return;
        }
        if (kind == Kind.PythMaxStaleness) return _range(kind, subject, value, PYTH_MAX_STALENESS_MIN, PYTH_MAX_STALENESS_MAX);
        if (kind == Kind.PythMaxDeviationBps) {
            return _range(kind, subject, value, PYTH_MAX_DEVIATION_BPS_MIN, PYTH_MAX_DEVIATION_BPS_MAX);
        }
        if (kind == Kind.PythConfidenceMaxBps) {
            return _range(kind, subject, value, PYTH_CONFIDENCE_MAX_BPS_MIN, PYTH_CONFIDENCE_MAX_BPS_MAX);
        }
        if (kind == Kind.SecondaryMaxDeviationBps) {
            return _range(kind, subject, value, SECONDARY_MAX_DEVIATION_BPS_MIN, SECONDARY_MAX_DEVIATION_BPS_MAX);
        }
        if (kind == Kind.SecondaryMaxStaleness) {
            return _range(kind, subject, value, SECONDARY_MAX_STALENESS_MIN, SECONDARY_MAX_STALENESS_MAX);
        }
        if (kind == Kind.RateObservation) {
            return _range(kind, subject, value, RATE_OBSERVATION_MIN, RATE_OBSERVATION_MAX);
        }
        if (kind == Kind.FeedMaxStaleness) {
            _requireAddress(kind, subject, value, subject, false);
            // 0 removes the override; a set override may only be tighter
            // than the stable ceiling, which always applies on top.
            if (v > STABLE_STALENESS) revert InvalidChange(kind, subject, value);
            return;
        }
        if (kind == Kind.SecondaryEnabled) {
            if (uint256(subject) > uint256(type(Source).max) || v != 1) revert InvalidChange(kind, subject, value);
            return;
        }
        if (kind == Kind.RateSourceEnabled) {
            if (uint256(subject) > type(uint160).max || v != 1) revert InvalidChange(kind, subject, value);
            return;
        }
        if (kind == Kind.PriceFloor) {
            // Only the current version, and only upwards (#3437).
            (uint64 g, uint64 r) = priceVersion();
            if (v != (uint256(g) << 64 | r) || (g == _floorGuardEpoch && r == _floorRegistryEpoch)) {
                revert InvalidChange(kind, subject, value);
            }
            return;
        }
        if (kind == Kind.RateBinding) return _validateRateBinding(subject, value);

        // Every remaining kind sets an address.
        if (v > type(uint160).max) revert InvalidChange(kind, subject, value);
        if (kind == Kind.FeedRegistry || kind == Kind.EthNumeraireFeed) {
            // Load-bearing: without either, nothing is priced.
            _requireAddress(kind, subject, value, value, false);
        } else if (kind == Kind.SecondarySource) {
            if (uint256(subject) > uint256(type(Source).max)) revert InvalidChange(kind, subject, value);
            _requireAddress(kind, subject, value, value, true);
        } else if (kind == Kind.StableRef) {
            uint256 len;
            while (len < 32 && subject[len] != 0) ++len;
            if (len == 0 || len > MAX_STABLE_SYMBOL_LEN) revert InvalidChange(kind, subject, value);
            _requireAddress(kind, subject, value, value, true);
        } else if (kind == Kind.AssetDirectFeed) {
            // Only the industrial pivot reads it; on retail it would be dead config.
            if (padIsNumeraire()) revert InvalidChange(kind, subject, value);
            if (uint256(subject) > type(uint160).max || subject == bytes32(0)) {
                revert InvalidChange(kind, subject, value);
            }
            _requireAddress(kind, subject, value, value, true);
        } else {
            // Weth, EthPadFeed, PadNumeraireRateFeed, SequencerFeed, PythOracle: 0 turns it off.
            _requireAddress(kind, subject, value, value, true);
        }
    }

    /// @dev A binding for the token `subject` (#3683): the token is a
    ///      contract that is neither WETH nor any live binding's underlying;
    ///      the underlying is a different contract that is not itself
    ///      rate-priced; the bounds are in range; the rate source answers
    ///      now; and a rate feed and a market feed are each the one the feed
    ///      registry holds for the pair, with its heartbeat. Zero removes the
    ///      binding.
    function _validateRateBinding(bytes32 subject, bytes32 value) private view {
        Kind kind = Kind.RateBinding;
        _requireAddress(kind, subject, value, subject, false);
        address token = _addr(subject);
        if (value == bytes32(0)) return;
        RateBinding memory b = _rateBinding[value];
        address under = b.underlying;
        if (
            under == address(0) || under == token || token == weth() || _underlyingRefs[token] != 0
                || _cfg[_id(kind, _w(under))] != bytes32(0) || b.maxRiseBpsPerDay == 0
                || b.maxRiseBpsPerDay > RATE_MAX_RISE_BPS_PER_DAY || b.maxFallBps < RATE_MAX_FALL_BPS_MIN
                || b.maxFallBps > RATE_MAX_FALL_BPS_MAX
        ) revert InvalidChange(kind, subject, value);
        _requireAddress(kind, subject, value, _w(under), false);
        _requireAddress(kind, subject, value, _w(b.source), false);
        address registry = feedRegistry();
        if (!b.sourceIsReader) {
            IVersionedFeedRegistry.Entry memory re = IVersionedFeedRegistry(registry).rateEntry(token, under);
            if (re.feed != b.source || re.heartbeat != b.rateHeartbeat) revert InvalidChange(kind, subject, value);
        }
        if (b.marketFeed != address(0)) {
            IVersionedFeedRegistry.Entry memory me = IVersionedFeedRegistry(registry).entry(token, NUMERAIRE_DENOMINATOR);
            if (me.feed != b.marketFeed || me.heartbeat != b.marketHeartbeat) revert InvalidChange(kind, subject, value);
        }
        (bool ok,) = _reportedRate(token, b);
        if (!ok) revert InvalidChange(kind, subject, value);
    }

    function _range(Kind kind, bytes32 subject, bytes32 value, uint256 lo, uint256 hi) private pure {
        uint256 v = uint256(value);
        if (v < lo || v > hi) revert InvalidChange(kind, subject, value);
    }

    /// @dev `word` (the change's value, or its subject for a keyed entry)
    ///      must name a contract, or be zero where `zeroAllowed`. A refusal
    ///      names the change as proposed.
    function _requireAddress(Kind kind, bytes32 subject, bytes32 value, bytes32 word, bool zeroAllowed)
        private
        view
    {
        if (uint256(word) > type(uint160).max) revert InvalidChange(kind, subject, value);
        address a = address(uint160(uint256(word)));
        if (a == address(0)) {
            if (!zeroAllowed) revert InvalidChange(kind, subject, value);
            return;
        }
        if (a.code.length == 0) revert NotAContract(kind, a);
    }

    /// @dev Validate and write one entry at epoch `at`, keeping the value it
    ///      replaces for reads at earlier epochs, and say so.
    function _apply(Kind kind, bytes32 subject, bytes32 value, uint64 at) private {
        _validate(kind, subject, value);
        if (kind == Kind.SecondaryEnabled) {
            _reEnable(Source(uint8(uint256(subject))));
        } else if (kind == Kind.RateSourceEnabled) {
            rateMuted[_addr(subject)] = false;
        } else if (kind == Kind.RateObservation) {
            rateObservation = uint64(uint256(value));
        } else {
            if (kind == Kind.RateBinding) _bindRate(_addr(subject), value);
            else if (kind == Kind.StableRef && value != bytes32(0)) _noteStableRef(subject);
            bytes32 id = _id(kind, subject);
            uint64 since = _cfgSince[id];
            if (since != 0 && since != at) {
                _cfgHistory[id].push(Past({sinceEpoch: since, untilEpoch: at, value: _cfg[id]}));
            }
            _cfg[id] = value;
            _cfgSince[id] = at;
        }
        emit ConfigSet(kind, subject, value);
    }

    /// @dev Raise the floor to the version `value` names, if it is still the
    ///      current one; otherwise the change lapses.
    function _raiseFloor(bytes32 value) private {
        uint64 g = uint64(uint256(value) >> 64);
        uint64 r = uint64(uint256(value));
        (uint64 cg, uint64 cr) = priceVersion();
        if (g != cg || r != cr) {
            emit PriceFloorLapsed(g, r);
            return;
        }
        address registry = feedRegistry();
        _floorGuardEpoch = g;
        _floorRegistry = registry;
        _floorRegistryEpoch = r;
        emit PriceFloorRaised(g, registry, r);
    }

    /// @dev Move `token` onto binding `hash` (zero: none). The underlying
    ///      counts are kept so no token is both rate-priced and a live
    ///      underlying. The binding's rate has been recorded since it was
    ///      proposed ({proposeRateBinding}), and execution records it once
    ///      more under the daily bound.
    function _bindRate(address token, bytes32 hash) private {
        bytes32 old = _cfg[_id(Kind.RateBinding, _w(token))];
        if (old != bytes32(0)) --_underlyingRefs[_rateBinding[old].underlying];
        if (hash == bytes32(0)) return;
        ++_underlyingRefs[_rateBinding[hash].underlying];
        // Execution records the rate too, so a binding left unrecorded
        // through its delay still starts no higher than the daily bound
        // allows. A distrusted record keeps its observation.
        RateState storage st = _rate[token][hash];
        if (st.observedSince != 0) return;
        uint256 reported = _requireRate(token, _rateBinding[hash]);
        RateBinding storage b = _rateBinding[hash];
        uint256 accepted = reported;
        if (st.at != 0) {
            uint256 cap = _rateCap(st.accepted, st.at, b.maxRiseBpsPerDay);
            if (cap < accepted) accepted = cap;
        }
        // safe: `_requireRate` refuses a rate above uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        st.accepted = uint128(accepted);
        st.at = uint64(block.timestamp);
        emit RateRecorded(token, hash, reported, accepted);
    }

    /// @dev Whether `hash` is `token`'s pending binding and not yet its live one.
    function _rateBindingPending(address token, bytes32 hash) private view returns (bool) {
        bytes32 key = _id(Kind.RateBinding, _w(token));
        Pending storage p = _pending[key];
        return p.executableAt != 0 && p.value == hash && _cfg[key] != hash;
    }

    /// @dev A re-enable counts the source again and drops any removal still
    ///      waiting, which the re-enable outranks: both were the owner's or
    ///      the guardian's call, and this one waited the longer delay.
    function _reEnable(Source source) private {
        secondaryState[source] = SecondaryState.Counted;
        if (secondaryRemovalAt[source] != 0) {
            delete secondaryRemovalAt[source];
            emit SecondaryRemovalCancelled(source, msg.sender);
        }
    }

    /// @dev Note a newly registered stable-peg symbol. The set never shrinks,
    ///      so a read at an earlier version can still walk it.
    /// @dev Keep `symbol` among the symbols a peg read walks. At most
    ///      {MAX_STABLE_REFS} are kept, so a read stays bounded. A removed
    ///      symbol stays while any answered version may still read its feed,
    ///      and is dropped to make room once its removal is at or below the
    ///      floor (#3437): every version still answered then reads it as
    ///      removed.
    function _noteStableRef(bytes32 symbol) private {
        if (_stableRefSymbols.contains(symbol)) return;
        if (_stableRefSymbols.length() >= MAX_STABLE_REFS) {
            bytes32[] memory all = _stableRefSymbols.values();
            for (uint256 i; i < all.length; ++i) {
                bytes32 id = _id(Kind.StableRef, all[i]);
                if (_cfg[id] == bytes32(0) && _cfgSince[id] <= _floorGuardEpoch) _stableRefSymbols.remove(all[i]);
            }
            if (_stableRefSymbols.length() >= MAX_STABLE_REFS) revert TooManyStableRefs(MAX_STABLE_REFS);
        }
        _stableRefSymbols.add(symbol);
    }
}
