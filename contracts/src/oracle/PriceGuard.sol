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
import {TestnetChains} from "../compliance/TestnetChains.sol";

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
 *         - Every write emits an event naming exactly what it changed.
 */
contract PriceGuard is Ownable2Step, IPriceGuard {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ─── Constants ───────────────────────────────────────────────────────

    /// @notice The shortest and longest delay a production chain may set.
    ///         The floor matches the vault code delay (`VaultBeacon`, 7 days
    ///         once #3421 lands), so no price setting reaches the vaults'
    ///         reads sooner than a vault code change could.
    uint64 public constant MIN_DELAY = 7 days;
    uint64 public constant MAX_DELAY = 14 days;

    /// @notice How long a proposed secondary removal waits (#3537). Fixed and
    ///         the same on every chain: removing a source's refusals is the
    ///         step that loosens the quorum, and 48 hours matches the
    ///         Timelock's unpause, so a wrong source can hold an asset's
    ///         pricing refused for at most that long.
    uint64 public constant SECONDARY_REMOVAL_DELAY = 48 hours;

    /// @notice A volatile feed's answer must be at most this old.
    uint256 public constant VOLATILE_STALENESS = 2 hours;
    /// @notice A stable feed's answer may be this old when it sits at a peg.
    uint256 public constant STABLE_STALENESS = 25 hours;
    /// @notice How far from a peg a stable answer may sit (3%).
    uint256 public constant PEG_TOLERANCE_BPS = 300;
    /// @notice The implicit USD $1 peg, at 8 decimals.
    int256 public constant USD_PEG_1E8 = 1e8;
    /// @notice How long after an L2 sequencer recovers before prices count.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;
    /// @notice A Tellor value is read only once it is this old (#665).
    uint256 public constant TELLOR_DISPUTE_BUFFER = 20 minutes;

    uint16 public constant SECONDARY_MAX_DEVIATION_BPS_MIN = 100;
    uint16 public constant SECONDARY_MAX_DEVIATION_BPS_MAX = 2000;
    uint40 public constant SECONDARY_MAX_STALENESS_MIN = 60;
    /// @dev 29h: DIA and API3 publish some pairs on a 24h heartbeat.
    uint40 public constant SECONDARY_MAX_STALENESS_MAX = 29 hours;
    uint16 public constant PYTH_MAX_DEVIATION_BPS_MIN = 100;
    uint16 public constant PYTH_MAX_DEVIATION_BPS_MAX = 2000;
    uint16 public constant PYTH_CONFIDENCE_MAX_BPS_MIN = 50;
    uint16 public constant PYTH_CONFIDENCE_MAX_BPS_MAX = 500;
    uint64 public constant PYTH_MAX_STALENESS_MIN = 60;
    uint64 public constant PYTH_MAX_STALENESS_MAX = 3600;

    /// @notice The most stable-peg references the peg check walks.
    uint256 public constant MAX_STABLE_REFS = 16;
    /// @notice The longest stable-reference symbol (an ISO 4217 or metal ticker).
    uint256 public constant MAX_STABLE_SYMBOL_LEN = 10;

    uint256 private constant BPS = 10_000;

    // ─── Types ───────────────────────────────────────────────────────────

    /// @notice The entries a change can name. `subject` is zero for a
    ///         single entry, and names the feed, asset, source or symbol for
    ///         a keyed one. `value` is an address, a number or a word,
    ///         left-padded into 32 bytes.
    enum Kind {
        FeedRegistry, //            the chain's VaipakamFeedRegistry
        Weth, //                    the chain's WETH, priced from the ETH anchor (0: none)
        EthNumeraireFeed, //        ETH/<numeraire>
        EthPadFeed, //              ETH/<PAD> (0: the ETH/<numeraire> feed)
        PadNumeraireRateFeed, //    PAD/<numeraire> (0: derived through ETH)
        SequencerFeed, //           L2 sequencer uptime (0: an L1, no check)
        PythOracle, //              (0: the cross-check is off)
        PythFeedId, //              Pyth ETH/<numeraire> id (0: off)
        PythMaxStaleness, //        seconds
        PythMaxDeviationBps,
        PythConfidenceMaxBps,
        SecondarySource, //         subject = Source; value = the source contract (0: none)
        SecondaryMaxDeviationBps,
        SecondaryMaxStaleness, //   seconds
        FeedMaxStaleness, //        subject = feed; seconds (0: no override)
        FeedMinAnswer, //           subject = feed; int256 in the feed's decimals (<= 0: no floor)
        StableRef, //               subject = symbol; value = reference feed (0: removed)
        AssetDirectFeed, //         subject = asset; asset/<numeraire> feed (0: none). Industrial pivot only.
        SecondaryEnabled, //        subject = Source; value 1 re-enables (disabling is instant)
        Delay //                    a lowered delay
    }

    /// @notice The secondary sources the quorum consults.
    enum Source {
        Tellor,
        Api3,
        Dia
    }

    /// @notice One config entry: what it is, which one, and its new value.
    struct Change {
        Kind kind;
        bytes32 subject;
        bytes32 value;
    }

    /// @notice The numeraire identity, fixed at construction.
    struct Identity {
        /// @dev The Chainlink denominator prices are quoted in (USD on retail).
        address numeraireDenominator;
        /// @dev Lower-case ASCII, left-aligned (`"usd"`). Builds the secondary queries.
        bytes32 numeraireSymbol;
        /// @dev The predominant denominator; zero or the numeraire itself means
        ///      no pivot (retail).
        address padDenominator;
        /// @dev The Chainlink ETH denominator, for the asset/ETH fallback.
        address ethDenominator;
    }

    /// @dev A proposed value. `executableAt` 0 means nothing is pending.
    struct Pending {
        bytes32 value;
        uint64 executableAt;
    }

    enum SecondaryStatus {
        Unavailable,
        Agree,
        Disagree
    }

    /// @notice How a secondary source takes part in the quorum (#3537).
    ///         `Counted`: its agreement accepts a price and its disagreement
    ///         refuses one. `Muted`: its agreement no longer counts, its
    ///         disagreement still refuses. `Removed`: it is not asked.
    enum SecondaryState {
        Counted,
        Muted,
        Removed
    }

    // ─── Immutable identity ──────────────────────────────────────────────

    address public immutable NUMERAIRE_DENOMINATOR;
    bytes32 public immutable NUMERAIRE_SYMBOL;
    /// @notice The denominator asset prices are read in before any pivot.
    ///         Equal to {NUMERAIRE_DENOMINATOR} on retail.
    address public immutable PAD_DENOMINATOR;
    address public immutable ETH_DENOMINATOR;
    /// @notice True when this chain may set a delay below {MIN_DELAY}.
    bool public immutable TESTNET;

    // ─── Config ──────────────────────────────────────────────────────────

    address public feedRegistry;
    /// @notice The chain's WETH, priced from the ETH anchor feed. The
    ///         Diamond's liquidity probe also routes over it.
    /// @dev    It must be the chain's canonical bridged WETH9, never the
    ///         wrapped native token where native gas is not ETH (WBNB on BNB
    ///         Chain, WPOL on Polygon PoS): the guard prices it from the ETH
    ///         feed without touching it, so a wrong token is mispriced as
    ///         ETH. Nothing on-chain says which token is WETH9; the chain's
    ///         official bridge registry is the source, and the launch
    ///         readiness check compares this entry with the declared one.
    address public weth;
    address public ethNumeraireFeed;
    address public ethPadFeed;
    address public padNumeraireRateFeed;
    address public sequencerFeed;
    address public pythOracle;
    bytes32 public pythFeedId;
    uint64 public pythMaxStaleness;
    uint16 public pythMaxDeviationBps;
    uint16 public pythConfidenceMaxBps;
    uint16 public secondaryMaxDeviationBps;
    uint40 public secondaryMaxStaleness;
    /// @notice The source contract per {Source}.
    mapping(Source => address) public secondarySource;
    /// @notice How each source takes part in the quorum (#3537).
    mapping(Source => SecondaryState) public secondaryState;
    /// @notice When a proposed removal of the source may execute; 0 = none.
    mapping(Source => uint64) public secondaryRemovalAt;
    mapping(address feed => uint40) public feedMaxStaleness;
    mapping(address feed => int256) public feedMinAnswer;
    mapping(address asset => address) public assetDirectFeed;
    mapping(bytes32 symbol => address) public stableRefFeed;
    EnumerableSet.Bytes32Set private _stableRefSymbols;

    address public guardian;
    uint64 public delay;
    mapping(bytes32 id => Pending) private _pending;

    // ─── Events ──────────────────────────────────────────────────────────

    event ConfigSet(Kind indexed kind, bytes32 indexed subject, bytes32 value);
    event ChangeProposed(Kind indexed kind, bytes32 indexed subject, bytes32 value, uint256 executableAt);
    event ChangeCancelled(Kind indexed kind, bytes32 indexed subject, address indexed by);
    event SecondaryMuted(Source indexed source, address indexed by);
    event SecondaryRemovalProposed(Source indexed source, address indexed by, uint256 executableAt);
    event SecondaryRemovalCancelled(Source indexed source, address indexed by);
    event SecondaryRemoved(Source indexed source);
    event DelaySet(uint256 oldDelay, uint256 newDelay);
    event GuardianSet(address indexed previous, address indexed next);

    // ─── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotOwnerOrGuardian(address caller);
    error RenounceDisabled();
    error DelayOutOfRange(uint256 requested, uint256 min, uint256 max);
    error ChangePending(Kind kind, bytes32 subject);
    error NothingPending(Kind kind, bytes32 subject);
    error NotReady(Kind kind, bytes32 subject, uint256 executableAt);
    error InvalidChange(Kind kind, bytes32 subject, bytes32 value);
    error NotAContract(Kind kind, address value);
    error TooManyStableRefs(uint256 max);
    error InvalidNumeraireSymbol(bytes32 symbol);
    error SecondaryAlreadyRemoved(Source source);
    error SecondaryRemovalPending(Source source, uint256 executableAt);
    error NoSecondaryRemovalPending(Source source);
    error SecondaryRemovalNotReady(Source source, uint256 executableAt);

    // ─── Construction ────────────────────────────────────────────────────

    /// @param owner_    The chain's admin (the Timelock takes it at handover).
    /// @param guardian_ The Pauser Safe (the admin until the handover moves it).
    /// @param id        The numeraire identity, fixed for life.
    /// @param delay_    The starting delay, within the chain's bounds.
    /// @param initial   The starting config, applied through the same checks
    ///                  as an executed change. Unnamed knobs take their
    ///                  defaults; unnamed feeds and sources start unset.
    constructor(
        address owner_,
        address guardian_,
        Identity memory id,
        uint64 delay_,
        Change[] memory initial
    ) Ownable(owner_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        if (id.numeraireDenominator == address(0) || id.ethDenominator == address(0)) revert ZeroAddress();
        if (!_isLowerSymbol(id.numeraireSymbol)) revert InvalidNumeraireSymbol(id.numeraireSymbol);
        NUMERAIRE_DENOMINATOR = id.numeraireDenominator;
        NUMERAIRE_SYMBOL = id.numeraireSymbol;
        PAD_DENOMINATOR = id.padDenominator == address(0) ? id.numeraireDenominator : id.padDenominator;
        ETH_DENOMINATOR = id.ethDenominator;
        TESTNET = TestnetChains.isTestnet(block.chainid);
        _checkDelay(delay_);
        delay = delay_;
        guardian = guardian_;
        emit GuardianSet(address(0), guardian_);
        emit DelaySet(0, delay_);

        _apply(Kind.PythMaxStaleness, bytes32(0), bytes32(uint256(300)));
        _apply(Kind.PythMaxDeviationBps, bytes32(0), bytes32(uint256(500)));
        _apply(Kind.PythConfidenceMaxBps, bytes32(0), bytes32(uint256(100)));
        _apply(Kind.SecondaryMaxDeviationBps, bytes32(0), bytes32(uint256(500)));
        _apply(Kind.SecondaryMaxStaleness, bytes32(0), bytes32(uint256(3600)));
        for (uint256 i; i < initial.length; ++i) {
            if (initial[i].kind == Kind.Delay || initial[i].kind == Kind.SecondaryEnabled) {
                revert InvalidChange(initial[i].kind, initial[i].subject, initial[i].value);
            }
            _apply(initial[i].kind, initial[i].subject, initial[i].value);
        }
    }

    // ─── Price reads ─────────────────────────────────────────────────────

    /// @inheritdoc IPriceGuard
    function getAssetPrice(address asset) public view returns (uint256 price, uint8 decimals) {
        (price, decimals) = _primaryPrice(asset);
        // #2419: a composed price can floor to zero from positive feeds.
        if (price == 0) revert ZeroPrice(asset);
        _enforceSecondaryQuorum(asset, price, decimals);
    }

    /// @inheritdoc IPriceGuard
    /// @dev A divergence is recognised by its own selector at its own encoded
    ///      length. Only the quorum raises {OraclePriceDivergence} and only
    ///      the Pyth gate raises {OracleCrossCheckDivergence}; every secondary
    ///      source and Pyth are read in their own try/catch, so their revert
    ///      data never reaches here. A primary Chainlink feed's or the
    ///      sequencer feed's revert data does: those are the owner's own
    ///      delayed config, not an outside source. The self-call takes 63/64 of the gas
    ///      left, so a caller cannot starve it into a false `Unavailable` and
    ///      still afford its own work.
    function getAssetPriceStatus(address asset)
        public
        view
        returns (PriceStatus status, uint256 price, uint8 decimals)
    {
        try this.getAssetPrice(asset) returns (uint256 p, uint8 d) {
            return (PriceStatus.Priced, p, d);
        } catch (bytes memory reason) {
            if (reason.length >= 4) {
                bytes4 sel = bytes4(reason);
                if (
                    (sel == OraclePriceDivergence.selector && reason.length == 4)
                        || (sel == OracleCrossCheckDivergence.selector && reason.length == 4 + 4 * 32)
                ) return (PriceStatus.Divergent, 0, 0);
            }
            return (PriceStatus.Unavailable, 0, 0);
        }
    }

    /// @inheritdoc IPriceGuard
    function tryGetAssetPrice(address asset) external view returns (bool ok, uint256 price, uint8 decimals) {
        PriceStatus status;
        (status, price, decimals) = getAssetPriceStatus(asset);
        ok = status == PriceStatus.Priced;
    }

    /// @inheritdoc IPriceGuard
    function countLiveSecondaryOracleFeeds(address asset)
        external
        view
        returns (uint8 agreeing, uint8 disagreeing)
    {
        (uint256 primary, uint8 dec) = _primaryPrice(asset);
        bytes32 symbol = _secondarySymbol(asset);
        if (symbol == bytes32(0)) return (0, 0);
        SecondaryStatus[3] memory statuses = _secondaryStatuses(symbol, primary, dec);
        for (uint256 i; i < 3; ++i) {
            if (statuses[i] == SecondaryStatus.Agree) agreeing++;
            else if (statuses[i] == SecondaryStatus.Disagree) disagreeing++;
        }
    }

    /// @inheritdoc IPriceGuard
    function sequencerHealthy() external view returns (bool) {
        address feed = sequencerFeed;
        if (feed == address(0)) return true;
        try AggregatorV3Interface(feed).latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer == 0 && startedAt != 0 && startedAt <= block.timestamp
                && block.timestamp - startedAt >= SEQUENCER_GRACE_PERIOD;
        } catch {
            return false;
        }
    }

    /// @inheritdoc IPriceGuard
    function sequencerOutageWindow() external view returns (uint256 downAt, uint256 windowEnd) {
        address feed = sequencerFeed;
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

    /// @inheritdoc IPriceGuard
    function readFeed(address feed, bool allowStablePeg)
        external
        view
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
        if (!_freshEnough(feed, answer, age, dec, allowStablePeg)) return (false, 0, 0);
        // safe: `answer` > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, uint256(answer), dec);
    }

    // ─── Config reads ────────────────────────────────────────────────────

    /// @notice The ETH anchor the PAD price reads WETH and the ETH pivot from:
    ///         the ETH/PAD feed, or the ETH/<numeraire> feed when none is set.
    function ethAnchorFeed() public view returns (address) {
        address a = ethPadFeed;
        return a == address(0) ? ethNumeraireFeed : a;
    }

    /// @notice Whether prices are read in the numeraire directly (retail).
    function padIsNumeraire() public view returns (bool) {
        return PAD_DENOMINATOR == NUMERAIRE_DENOMINATOR;
    }

    /// @notice Every stable-peg reference symbol, in no particular order.
    function stableRefSymbols() external view returns (bytes32[] memory) {
        return _stableRefSymbols.values();
    }

    /// @notice The pending change to (`kind`, `subject`); `executableAt` 0 = none.
    function pendingChange(Kind kind, bytes32 subject) external view returns (bytes32 value, uint256 executableAt) {
        Pending storage p = _pending[_id(kind, subject)];
        return (p.value, p.executableAt);
    }

    // ─── Config writes ───────────────────────────────────────────────────

    /// @notice Propose a change, executable by anyone once `delay` has passed.
    ///         It is checked now and again when it is executed.
    function proposeChange(Kind kind, bytes32 subject, bytes32 value) external onlyOwner {
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

    /// @notice Apply a pending change whose delay has passed. Anyone may call.
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
        } else {
            _apply(kind, subject, value);
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
        _cancelReEnable(source);
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
        _cancelReEnable(source);
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

    /// @dev Drop a pending re-enable of `source`, even one already due.
    function _cancelReEnable(Source source) private {
        bytes32 subject = bytes32(uint256(uint8(source)));
        bytes32 key = _id(Kind.SecondaryEnabled, subject);
        if (_pending[key].executableAt != 0) {
            delete _pending[key];
            emit ChangeCancelled(Kind.SecondaryEnabled, subject, msg.sender);
        }
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

    // ─── Config internals ────────────────────────────────────────────────

    function _id(Kind kind, bytes32 subject) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, subject));
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
            || kind == Kind.StableRef || kind == Kind.AssetDirectFeed || kind == Kind.SecondaryEnabled;
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

    /// @dev Validate and write one entry, and say so.
    function _apply(Kind kind, bytes32 subject, bytes32 value) private {
        _validate(kind, subject, value);
        address a = address(uint160(uint256(value)));
        if (kind == Kind.FeedRegistry) feedRegistry = a;
        else if (kind == Kind.Weth) weth = a;
        else if (kind == Kind.EthNumeraireFeed) ethNumeraireFeed = a;
        else if (kind == Kind.EthPadFeed) ethPadFeed = a;
        else if (kind == Kind.PadNumeraireRateFeed) padNumeraireRateFeed = a;
        else if (kind == Kind.SequencerFeed) sequencerFeed = a;
        else if (kind == Kind.PythOracle) pythOracle = a;
        else if (kind == Kind.PythFeedId) pythFeedId = value;
        else if (kind == Kind.PythMaxStaleness) pythMaxStaleness = uint64(uint256(value));
        else if (kind == Kind.PythMaxDeviationBps) pythMaxDeviationBps = uint16(uint256(value));
        else if (kind == Kind.PythConfidenceMaxBps) pythConfidenceMaxBps = uint16(uint256(value));
        else if (kind == Kind.SecondarySource) secondarySource[Source(uint8(uint256(subject)))] = a;
        else if (kind == Kind.SecondaryMaxDeviationBps) secondaryMaxDeviationBps = uint16(uint256(value));
        else if (kind == Kind.SecondaryMaxStaleness) secondaryMaxStaleness = uint40(uint256(value));
        else if (kind == Kind.FeedMaxStaleness) feedMaxStaleness[_addr(subject)] = uint40(uint256(value));
        else if (kind == Kind.FeedMinAnswer) feedMinAnswer[_addr(subject)] = int256(uint256(value));
        else if (kind == Kind.AssetDirectFeed) assetDirectFeed[_addr(subject)] = a;
        else if (kind == Kind.SecondaryEnabled) _reEnable(Source(uint8(uint256(subject))));
        else if (kind == Kind.StableRef) _setStableRef(subject, a);
        emit ConfigSet(kind, subject, value);
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

    function _setStableRef(bytes32 symbol, address feed) private {
        stableRefFeed[symbol] = feed;
        if (feed == address(0)) {
            _stableRefSymbols.remove(symbol);
        } else if (_stableRefSymbols.add(symbol) && _stableRefSymbols.length() > MAX_STABLE_REFS) {
            revert TooManyStableRefs(MAX_STABLE_REFS);
        }
    }

    function _addr(bytes32 word) private pure returns (address) {
        return address(uint160(uint256(word)));
    }

    // ─── Primary price ───────────────────────────────────────────────────

    /// @dev The Chainlink primary, quoted in the numeraire.
    ///      - Retail (PAD is the numeraire): the asset/numeraire feed from the
    ///        registry, else asset/ETH × ETH/numeraire. WETH reads the ETH
    ///        anchor directly.
    ///      - Industrial (PAD differs): an asset's direct asset/<numeraire>
    ///        feed when one is set, else its PAD price × PAD/<numeraire>.
    function _primaryPrice(address asset) private view returns (uint256 price, uint8 decimals) {
        _requireSequencerHealthy();
        if (padIsNumeraire()) return _padPrice(asset);

        address direct = assetDirectFeed[asset];
        if (direct != address(0)) return _readStrict(direct, true);
        (uint256 padPrice, uint8 padDec) = _padPrice(asset);
        (uint256 fx, uint8 fxDec) = _padNumeraireRate();
        return _composePrice(padPrice, padDec, fx, fxDec);
    }

    /// @dev The asset's price in PAD units.
    function _padPrice(address asset) private view returns (uint256 price, uint8 decimals) {
        address anchor = ethAnchorFeed();
        if (asset != address(0) && asset == weth) {
            if (anchor == address(0)) revert NoPriceFeed();
            (uint256 p, uint8 d) = _readStrict(anchor, false);
            _validatePythCrossCheck(p, d);
            return (p, d);
        }

        address registry = feedRegistry;
        if (registry != address(0)) {
            address feed = _registryFeed(registry, asset, PAD_DENOMINATOR);
            if (feed != address(0)) return _readStrict(feed, true);

            if (anchor != address(0)) {
                address ethQuoted = _registryFeed(registry, asset, ETH_DENOMINATOR);
                if (ethQuoted != address(0)) {
                    (uint256 perEth, uint8 perEthDec) = _readStrict(ethQuoted, false);
                    (uint256 ethPad, uint8 ethDec) = _readStrict(anchor, false);
                    _validatePythCrossCheck(ethPad, ethDec);
                    return _composePrice(perEth, perEthDec, ethPad, ethDec);
                }
            }
        }
        revert NoPriceFeed();
    }

    /// @dev PAD/<numeraire>: the direct feed when set, else ETH/<numeraire> ÷
    ///      ETH/PAD at the finer of the two precisions.
    function _padNumeraireRate() private view returns (uint256 rate, uint8 decimals) {
        address direct = padNumeraireRateFeed;
        if (direct != address(0)) return _readStrict(direct, true);
        address numerFeed = ethNumeraireFeed;
        address padFeed = ethPadFeed;
        if (numerFeed == address(0) || padFeed == address(0)) revert PadNumeraireRateUnavailable();
        (uint256 ethNumer, uint8 numerDec) = _readStrict(numerFeed, false);
        (uint256 ethPad, uint8 padDec) = _readStrict(padFeed, false);
        _validatePythCrossCheck(ethPad, padDec);
        uint8 outDec = numerDec > padDec ? numerDec : padDec;
        uint256 numerScaled = _rescale(ethNumer, numerDec, outDec);
        uint256 padScaled = _rescale(ethPad, padDec, outDec);
        if (padScaled == 0) revert PadNumeraireRateUnavailable();
        rate = (numerScaled * (10 ** outDec)) / padScaled;
        decimals = outDec;
    }

    /// @dev The registry's feed for (`base`, `quote`); zero when none or the
    ///      read fails. The registry is the chain's own VaipakamFeedRegistry
    ///      (#2880), which answers Chainlink's `getFeed` shape on every chain.
    // slither-disable-next-line chainlink-feed-registry
    function _registryFeed(address registry, address base, address quote) private view returns (address) {
        if (quote == address(0)) return address(0);
        try FeedRegistryInterface(registry).getFeed(base, quote) returns (AggregatorV2V3Interface f) {
            return address(f);
        } catch {
            return address(0);
        }
    }

    /// @dev A Chainlink read that reverts {StalePriceData} unless the
    ///      answer passes {_freshEnough}.
    function _readStrict(address feed, bool allowStablePeg) private view returns (uint256 price, uint8 decimals) {
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
        if (!_freshEnough(feed, answer, age, dec, allowStablePeg)) revert StalePriceData();
        // safe: `answer` > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (uint256(answer), dec);
    }

    /// @dev The ONE freshness rule for a Chainlink answer. A volatile feed
    ///      must be at most {VOLATILE_STALENESS} old; a stable one may be up
    ///      to {STABLE_STALENESS} old only when its answer sits at a peg. A
    ///      per-feed override only adds bounds: a shorter staleness budget
    ///      and a floor on the answer (#2742).
    function _freshEnough(address feed, int256 answer, uint256 age, uint8 dec, bool allowStablePeg)
        private
        view
        returns (bool)
    {
        int256 floor = feedMinAnswer[feed];
        if (floor > 0 && answer < floor) return false;
        uint40 maxAge = feedMaxStaleness[feed];
        if (maxAge > 0 && age > maxAge) return false;
        if (age > STABLE_STALENESS) return false;
        if (age > VOLATILE_STALENESS) {
            if (!allowStablePeg) return false;
            if (!_answerWithinAnyPeg(answer, dec)) return false;
        }
        return true;
    }

    /// @dev An 8-decimal answer within {PEG_TOLERANCE_BPS} of $1 or of a
    ///      registered fiat or commodity reference.
    function _answerWithinAnyPeg(int256 answer, uint8 dec) private view returns (bool) {
        if (dec != 8) return false;
        if (_withinPeg(answer, USD_PEG_1E8)) return true;
        uint256 n = _stableRefSymbols.length();
        for (uint256 i; i < n; ++i) {
            (bool ok, int256 ref) = _readRefPeg(stableRefFeed[_stableRefSymbols.at(i)]);
            if (ok && _withinPeg(answer, ref)) return true;
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

    function _requireSequencerHealthy() private view {
        address feed = sequencerFeed;
        if (feed == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = AggregatorV3Interface(feed).latestRoundData();
        // A start time in the future is a broken feed, read as down rather
        // than left to underflow.
        if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) revert SequencerDown();
        if (block.timestamp - startedAt < SEQUENCER_GRACE_PERIOD) revert SequencerGracePeriod();
    }

    // ─── Pyth cross-check ────────────────────────────────────────────────

    /// @dev Cross-check an ETH-anchor reading against Pyth. Soft-skips when
    ///      the gate is off, Pyth fails, or its snapshot is non-positive,
    ///      stale or low-confidence; reverts {OracleCrossCheckDivergence} on a
    ///      deviation beyond tolerance.
    // The publishTime and confidence gates sit below the snapshot copy;
    // both are load-bearing and tested.
    // slither-disable-start pyth-unchecked-publishtime
    // slither-disable-start pyth-unchecked-confidence
    function _validatePythCrossCheck(uint256 chainlinkPrice, uint8 chainlinkDecimals) private view {
        address pyth = pythOracle;
        bytes32 feedId = pythFeedId;
        if (pyth == address(0) || feedId == bytes32(0)) return;
        IPyth.Price memory snap;
        try IPyth(pyth).getPriceUnsafe(feedId) returns (IPyth.Price memory p) {
            snap = p;
        } catch {
            return;
        }
        if (snap.price <= 0) return;
        if (block.timestamp > snap.publishTime + pythMaxStaleness) return;
        uint256 pythScaled = _pythPriceToScale(uint256(uint64(snap.price)), snap.expo, chainlinkDecimals);
        if (pythScaled == 0) return;
        uint256 confBps = (uint256(snap.conf) * BPS) / uint256(uint64(snap.price));
        if (confBps > pythConfidenceMaxBps) return;
        uint256 absDelta = chainlinkPrice > pythScaled ? chainlinkPrice - pythScaled : pythScaled - chainlinkPrice;
        uint256 deviationBps = (absDelta * BPS) / chainlinkPrice;
        uint256 maxDev = pythMaxDeviationBps;
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

    // ─── Secondary quorum (soft 2-of-N) ──────────────────────────────────

    /// @dev Every secondary unavailable: accept the primary alone. Any one
    ///      counted source agreeing: accept. Some disagreeing and none
    ///      agreeing: revert {OraclePriceDivergence}.
    function _enforceSecondaryQuorum(address asset, uint256 primary, uint8 dec) private view {
        bytes32 symbol = _secondarySymbol(asset);
        if (symbol == bytes32(0)) return;
        SecondaryStatus[3] memory st = _secondaryStatuses(symbol, primary, dec);
        if (st[0] == SecondaryStatus.Agree || st[1] == SecondaryStatus.Agree || st[2] == SecondaryStatus.Agree) return;
        if (st[0] == SecondaryStatus.Disagree || st[1] == SecondaryStatus.Disagree || st[2] == SecondaryStatus.Disagree) {
            revert OraclePriceDivergence();
        }
    }

    /// @dev The one reading of every source as the quorum counts it, in
    ///      {Source} order: a removed source is not asked, and a muted
    ///      source's agreement reads as no data while its disagreement stands.
    function _secondaryStatuses(bytes32 symbol, uint256 primary, uint8 dec)
        private
        view
        returns (SecondaryStatus[3] memory st)
    {
        st[0] = _asCounted(Source.Tellor, _checkTellor(symbol, primary, dec));
        st[1] = _asCounted(Source.Api3, _checkApi3(symbol, primary, dec));
        st[2] = _asCounted(Source.Dia, _checkDia(symbol, primary, dec));
    }

    function _asCounted(Source source, SecondaryStatus status) private view returns (SecondaryStatus) {
        if (status == SecondaryStatus.Agree && secondaryState[source] == SecondaryState.Muted) {
            return SecondaryStatus.Unavailable;
        }
        return status;
    }

    /// @dev The source contract a probe may ask, or zero when it is unset or
    ///      removed.
    function _liveSource(Source source) private view returns (address) {
        if (secondaryState[source] == SecondaryState.Removed) return address(0);
        return secondarySource[source];
    }

    /// @dev Tellor SpotPrice: the newest value reported at least
    ///      {TELLOR_DISPUTE_BUFFER} ago (#665), 18 decimals.
    function _checkTellor(bytes32 symbol, uint256 primary, uint8 dec) private view returns (SecondaryStatus) {
        address oracle = _liveSource(Source.Tellor);
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
        if (block.timestamp - reportedAt > secondaryMaxStaleness) return SecondaryStatus.Unavailable;
        uint256 at18 = abi.decode(raw, (uint256));
        if (at18 == 0) return SecondaryStatus.Unavailable;
        return _classify(primary, _rescale(at18, 18, dec));
    }

    /// @dev API3 dAPI `<SYMBOL>/<NUMERAIRE>`, 18 decimals.
    function _checkApi3(bytes32 symbol, uint256 primary, uint8 dec) private view returns (SecondaryStatus) {
        address server = _liveSource(Source.Api3);
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
        if (block.timestamp - reportedAt > secondaryMaxStaleness) return SecondaryStatus.Unavailable;
        // safe: `value` > 0 was checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return _classify(primary, _rescale(uint256(int256(value)), 18, dec));
    }

    /// @dev DIA key `<SYMBOL>/<NUMERAIRE>`, 8 decimals.
    function _checkDia(bytes32 symbol, uint256 primary, uint8 dec) private view returns (SecondaryStatus) {
        address oracle = _liveSource(Source.Dia);
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
        if (block.timestamp - uint256(reportedAt) > secondaryMaxStaleness) return SecondaryStatus.Unavailable;
        return _classify(primary, _rescale(uint256(value), 8, dec));
    }

    /// @dev Agree within the secondary tolerance; a secondary that scales to
    ///      zero is no data.
    function _classify(uint256 primary, uint256 secondary) private view returns (SecondaryStatus) {
        if (secondary == 0) return SecondaryStatus.Unavailable;
        uint256 diff = primary > secondary ? primary - secondary : secondary - primary;
        if ((diff * BPS) / primary > secondaryMaxDeviationBps) return SecondaryStatus.Disagree;
        return SecondaryStatus.Agree;
    }

    /// @dev #2745: the asset's price identity is the base symbol of its
    ///      registered pair, never the token's own `symbol()`. Looked up
    ///      under the quotes the primary tries, in its order. WETH is ETH.
    ///      Zero (every secondary Unavailable) when no pair is registered.
    function _secondarySymbol(address asset) private view returns (bytes32) {
        if (asset != address(0) && asset == weth) return bytes32("ETH");
        address registry = feedRegistry;
        if (registry == address(0)) return bytes32(0);
        bytes32 symbol = _pairBase(registry, asset, PAD_DENOMINATOR);
        if (symbol == bytes32(0)) symbol = _pairBase(registry, asset, ETH_DENOMINATOR);
        return symbol;
    }

    /// @dev One `pairBase` read; a failure or a reply that is not one word is zero.
    function _pairBase(address registry, address base, address quote) private view returns (bytes32 symbol) {
        (bool ok, bytes memory ret) =
            registry.staticcall(abi.encodeCall(IFeedRegistryPairBase.pairBase, (base, quote)));
        if (ok && ret.length == 32) symbol = abi.decode(ret, (bytes32));
    }

    function _numeraireUpper() private view returns (string memory) {
        return _toUpper(_wordToString(NUMERAIRE_SYMBOL));
    }

    // ─── Pure helpers ────────────────────────────────────────────────────

    /// @dev A non-empty, left-aligned run of lower-case ASCII letters.
    function _isLowerSymbol(bytes32 word) private pure returns (bool) {
        uint256 len;
        while (len < 32 && word[len] != 0) {
            uint8 c = uint8(word[len]);
            if (c < 0x61 || c > 0x7A) return false;
            ++len;
        }
        for (uint256 i = len; i < 32; ++i) {
            if (word[i] != 0) return false;
        }
        return len > 0;
    }

    /// @dev A left-aligned word as a string, up to its first zero byte.
    function _wordToString(bytes32 word) private pure returns (string memory) {
        uint256 len;
        while (len < 32 && word[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = word[i];
        return string(out);
    }

    function _toLower(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) b[i] = bytes1(c + 32);
        }
        return string(b);
    }

    function _toUpper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x61 && c <= 0x7A) b[i] = bytes1(c - 32);
        }
        return string(b);
    }

    /// @dev The product of two prices at the finer of their scales, divided
    ///      once at full width. Rounds down.
    function _composePrice(uint256 a, uint8 aDec, uint256 b, uint8 bDec)
        private
        pure
        returns (uint256 price, uint8 decimals)
    {
        (uint8 lo, uint8 hi) = aDec < bDec ? (aDec, bDec) : (bDec, aDec);
        price = Math.mulDiv(a, b, 10 ** uint256(lo));
        decimals = hi;
    }

    function _rescale(uint256 value, uint8 fromDec, uint8 toDec) private pure returns (uint256) {
        if (fromDec == toDec) return value;
        if (fromDec < toDec) return value * (10 ** uint256(toDec - fromDec));
        return value / (10 ** uint256(fromDec - toDec));
    }
}
