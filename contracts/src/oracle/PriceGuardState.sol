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

/**
 * @title  PriceGuardState
 * @author Vaipakam Developer Team
 * @notice The storage, types and shared reads of the {PriceGuard} and of the
 *         {PriceGuardReader} that runs its pricing path (#3437). The guard
 *         answers every price read by running the reader's code over the
 *         guard's own storage (a delegate call made inside a static call), so
 *         the two must see one layout: both inherit this contract, and
 *         neither declares a state variable of its own.
 * @dev    The guard places `Ownable2Step` AFTER this contract in its bases, so
 *         the ownership slots follow every slot declared here and the reader,
 *         which has no owner, sees the same layout.
 */
abstract contract PriceGuardState is IPriceGuard {
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

    /// @notice The most a rate binding may let the accepted rate grow in a
    ///         day (#3683): 1%. A staked asset's rate grows by a few
    ///         hundredths of a percent a day; the bound need only admit
    ///         honest growth.
    uint16 public constant RATE_MAX_RISE_BPS_PER_DAY = 100;
    /// @notice The bounds on a binding's distrust threshold (one fall).
    uint16 public constant RATE_MAX_FALL_BPS_MIN = 10;
    uint16 public constant RATE_MAX_FALL_BPS_MAX = 2000;
    /// @notice How long a fallen rate is observed before it may be confirmed.
    uint64 public constant RATE_OBSERVATION_DEFAULT = 6 hours;
    uint64 public constant RATE_OBSERVATION_MIN = 1 hours;
    uint64 public constant RATE_OBSERVATION_MAX = 48 hours;
    /// @notice How far past its stated heartbeat a rate feed may be read.
    uint256 public constant RATE_FEED_GRACE = 1 hours;
    /// @notice The gas a rate reader is given; one that needs more is read
    ///         as not answering.
    uint256 public constant RATE_READ_GAS = 200_000;

    uint256 internal constant BPS = 10_000;


    // ─── Types ───────────────────────────────────────────────────────────

    /// @notice The entries a change can name. `subject` is zero for a
    ///         single entry, and names the feed, asset, source or symbol for
    ///         a keyed one. `value` is an address, a number or a word,
    ///         left-padded into 32 bytes. Every kind up to {AssetDirectFeed},
    ///         and {RateBinding}, is a PRICE setting: executing a change to
    ///         one raises the {epoch} (#3437). The others are levers and
    ///         timings that no price read is made at.
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
        Delay, //                   a lowered delay
        RateBinding, //             subject = token; value = a binding's hash ({proposeRateBinding}; 0: none)
        RateObservation, //         seconds a fallen rate is observed before it may be confirmed
        RateSourceEnabled, //       subject = token; value 1 unmutes its rate source (muting is instant)
        PriceFloor //               value = guard epoch << 64 | registry epoch: the current version
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

    /// @notice How a token is priced from its exchange rate (#3683). Set as a
    ///         whole, by hash, so a binding never applies half-changed.
    struct RateBinding {
        /// @dev The token the rate converts into, itself priced by a feed.
        address underlying;
        /// @dev The rate feed, or the token-rate reader ({IRateReader}).
        address source;
        /// @dev Whether `source` is a reader rather than a feed.
        bool sourceIsReader;
        /// @dev A rate feed's heartbeat, as its registry entry states it.
        uint32 rateHeartbeat;
        /// @dev The token's own market feed in the numeraire; zero for none.
        address marketFeed;
        /// @dev The market feed's heartbeat, as its registry entry states it.
        uint32 marketHeartbeat;
        /// @dev The most the accepted rate may grow in a day.
        uint16 maxRiseBpsPerDay;
        /// @dev The single fall that marks the price distrusted.
        uint16 maxFallBps;
    }

    /// @notice What the guard has measured of a binding's rate (#3683). Not a
    ///         setting: one record per token and binding, shared by every
    ///         version that names that binding. Rates are 1e18-scaled.
    struct RateState {
        /// @dev The last accepted rate, and when it was recorded.
        uint128 accepted;
        uint64 at;
        /// @dev Non-zero exactly while the price is distrusted: set by a
        ///      recorded fall past the bound, it is when the current
        ///      observation began. A confirm clears it.
        uint64 observedSince;
        /// @dev While distrusted: the lowest rate reported since the fall.
        uint128 lowest;
        /// @dev While distrusted: the accepted rate before the fall.
        uint128 preFall;
    }

    /// @notice An earlier value of a price setting (#3437): it held from
    ///         `sinceEpoch` up to, not including, `untilEpoch`.
    struct Past {
        uint64 sinceEpoch;
        uint64 untilEpoch;
        bytes32 value;
    }

    /// @dev A price version as a read is made at. `latest` reads the live
    ///      settings and the registry's live bindings, which is the newest
    ///      version without asking the registry for its epoch.
    struct Ver {
        uint64 g;
        uint64 r;
        bool latest;
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

    /// @notice The guard's config epoch (#3437): 1 at construction, raised by
    ///         one for every executed change to a price setting.
    uint64 public epoch;

    /// @dev Every price setting, by `_id(kind, subject)`: its live value, the
    ///      epoch it was set in, and the values it had before.
    ///      The chain's WETH (`Kind.Weth`) must be the chain's canonical
    ///      bridged WETH9, never the wrapped native token where native gas is
    ///      not ETH (WBNB on BNB Chain, WPOL on Polygon PoS): the guard
    ///      prices it from the ETH feed without touching it, so a wrong token
    ///      is mispriced as ETH. Nothing on-chain says which token is WETH9;
    ///      the chain's official bridge registry is the source, and the
    ///      launch readiness check compares this entry with the declared one.
    mapping(bytes32 id => bytes32) internal _cfg;
    mapping(bytes32 id => uint64) internal _cfgSince;
    mapping(bytes32 id => Past[]) internal _cfgHistory;

    /// @notice How each source takes part in the quorum (#3537). A stop, so
    ///         not versioned: it reaches every version at once.
    mapping(Source => SecondaryState) public secondaryState;
    /// @notice When a proposed removal of the source may execute; 0 = none.
    mapping(Source => uint64) public secondaryRemovalAt;
    /// @dev Every stable-peg symbol ever registered (at most
    ///      {MAX_STABLE_REFS}); its feed at a version is the setting.
    EnumerableSet.Bytes32Set internal _stableRefSymbols;

    /// @dev Rate bindings by hash, as {proposeRateBinding} registered them.
    mapping(bytes32 hash => RateBinding) internal _rateBinding;
    /// @dev The measured rate of each token under each binding.
    mapping(address token => mapping(bytes32 hash => RateState)) internal _rate;
    /// @dev How many live bindings name a token as their underlying.
    mapping(address token => uint256) internal _underlyingRefs;
    /// @notice A token whose rate source is muted (#3683): its price is
    ///         distrusted at every version. Muting is instant; unmuting waits
    ///         the delay.
    mapping(address token => bool) public rateMuted;
    /// @notice How long a fallen rate must be observed before it may be
    ///         confirmed.
    uint64 public rateObservation;

    /// @dev The lowest version still answered; see {priceFloor}.
    uint64 internal _floorGuardEpoch;
    address internal _floorRegistry;
    uint64 internal _floorRegistryEpoch;

    address public guardian;
    uint64 public delay;
    mapping(bytes32 id => Pending) internal _pending;

    // ─── Events ──────────────────────────────────────────────────────────

    event ConfigSet(Kind indexed kind, bytes32 indexed subject, bytes32 value);
    /// @notice A price setting changed, so the config epoch rose (#3437).
    event EpochAdvanced(uint64 indexed epoch);
    event ChangeProposed(Kind indexed kind, bytes32 indexed subject, bytes32 value, uint256 executableAt);
    event ChangeCancelled(Kind indexed kind, bytes32 indexed subject, address indexed by);
    event SecondaryMuted(Source indexed source, address indexed by);
    event SecondaryRemovalProposed(Source indexed source, address indexed by, uint256 executableAt);
    event SecondaryRemovalCancelled(Source indexed source, address indexed by);
    event SecondaryRemoved(Source indexed source);
    event DelaySet(uint256 oldDelay, uint256 newDelay);
    event GuardianSet(address indexed previous, address indexed next);
    /// @notice The floor rose: no read below this version is answered.
    event PriceFloorRaised(uint64 guardEpoch, address indexed registry, uint64 registryEpoch);
    /// @notice A floor change came due after the current version had moved
    ///         on, so it lapsed unapplied; a new proposal is needed.
    event PriceFloorLapsed(uint64 guardEpoch, uint64 registryEpoch);
    /// @notice A rate binding was registered under `hash` (#3683).
    event RateBindingRegistered(bytes32 indexed hash, address indexed token, RateBinding binding);
    /// @notice A token's rate was recorded: `reported` by its source,
    ///         `accepted` after the rise bound.
    event RateRecorded(address indexed token, bytes32 indexed hash, uint256 reported, uint256 accepted);
    /// @notice A fall past the bound: the price is distrusted from now.
    event RateDistrusted(address indexed token, bytes32 indexed hash, uint256 preFall, uint256 reported);
    /// @notice A reading while distrusted; the observation restarts at
    ///         `observedSince` when the reading broke the rule.
    event RateObserved(address indexed token, bytes32 indexed hash, uint256 reported, uint256 lowest, uint256 observedSince);
    /// @notice A distrusted rate was confirmed at `accepted`, which no one chose.
    event RateConfirmed(address indexed token, bytes32 indexed hash, uint256 accepted, address indexed by);
    event RateSourceMuted(address indexed token, address indexed by);

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
    error UnknownRateBinding(address token, bytes32 hash);
    error RateNotDistrusted(address token, bytes32 hash);
    error RateStillMoving(address token, bytes32 hash, uint256 reported);
    error RateObservationNotOver(address token, bytes32 hash, uint256 confirmableAt);
    error RateReadOutOfGas();

    // ─── Construction ────────────────────────────────────────────────────

    /// @param id The numeraire identity, fixed for life.
    constructor(Identity memory id) {
        if (id.numeraireDenominator == address(0) || id.ethDenominator == address(0)) revert ZeroAddress();
        if (!_isLowerSymbol(id.numeraireSymbol)) revert InvalidNumeraireSymbol(id.numeraireSymbol);
        NUMERAIRE_DENOMINATOR = id.numeraireDenominator;
        NUMERAIRE_SYMBOL = id.numeraireSymbol;
        PAD_DENOMINATOR = id.padDenominator == address(0) ? id.numeraireDenominator : id.padDenominator;
        ETH_DENOMINATOR = id.ethDenominator;
        TESTNET = TestnetChains.isTestnet(block.chainid);
    }

    /// @inheritdoc IPriceGuard
    function priceVersion() public view returns (uint64 guardEpoch, uint64 registryEpoch) {
        guardEpoch = epoch;
        address registry = feedRegistry();
        if (registry != address(0)) registryEpoch = IVersionedFeedRegistry(registry).epoch();
    }

    /// @inheritdoc IPriceGuard
    function priceFloor() external view returns (uint64 guardEpoch, address registry, uint64 registryEpoch) {
        return (_floorGuardEpoch, _floorRegistry, _floorRegistryEpoch);
    }

    /// @inheritdoc IPriceGuard
    function isRatePriced(address asset) external view returns (bool) {
        return _cfg[_id(Kind.RateBinding, _w(asset))] != bytes32(0);
    }

    /// @inheritdoc IPriceGuard
    function feedRegistry() public view returns (address) {
        return _addr(_cfg[_id(Kind.FeedRegistry, 0)]);
    }

    /// @inheritdoc IPriceGuard
    function weth() public view returns (address) {
        return _addr(_cfg[_id(Kind.Weth, 0)]);
    }

    /// @inheritdoc IPriceGuard
    function ethNumeraireFeed() external view returns (address) {
        return _addr(_cfg[_id(Kind.EthNumeraireFeed, 0)]);
    }

    /// @inheritdoc IPriceGuard
    function sequencerFeed() public view returns (address) {
        return _addr(_cfg[_id(Kind.SequencerFeed, 0)]);
    }

    /// @notice Whether prices are read in the numeraire directly (retail).
    function padIsNumeraire() public view returns (bool) {
        return PAD_DENOMINATOR == NUMERAIRE_DENOMINATOR;
    }

    function _id(Kind kind, bytes32 subject) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, subject));
    }

    function _latest() internal pure returns (Ver memory v) {
        v.latest = true;
    }

    /// @dev A price version a read may be made at: it exists on this guard
    ///      and its registry, and is not below the floor. The floor's
    ///      registry epoch binds only versions on that same registry: a
    ///      version on a registry swapped in later is newer by construction.
    function _version(uint64 g, uint64 r) internal view returns (Ver memory v) {
        if (g == 0 || g > epoch) revert UnknownPriceVersion(g, r);
        address registry = _addr(_valueAt(_id(Kind.FeedRegistry, 0), g));
        if (registry == address(0) ? r != 0 : (r == 0 || r > IVersionedFeedRegistry(registry).epoch())) {
            revert UnknownPriceVersion(g, r);
        }
        if (g < _floorGuardEpoch || (registry == _floorRegistry && r < _floorRegistryEpoch)) {
            revert PriceVersionRetired(g, r);
        }
        v.g = g;
        v.r = r;
    }

    /// @dev The value a setting had at epoch `at`: the live value when it was
    ///      set at or before `at`, else the kept value that covered `at`,
    ///      else zero (not set then). History is short and in epoch order.
    function _valueAt(bytes32 id, uint64 at) internal view returns (bytes32) {
        if (at >= _cfgSince[id]) return _cfg[id];
        Past[] storage h = _cfgHistory[id];
        for (uint256 i = h.length; i > 0; --i) {
            Past storage p = h[i - 1];
            if (at >= p.untilEpoch) return bytes32(0);
            if (at >= p.sinceEpoch) return p.value;
        }
        return bytes32(0);
    }

    /// @dev A setting at the read's version. The newest version reads the
    ///      live slot, as fast as before versioning.
    function _c(Kind kind, bytes32 subject, Ver memory v) internal view returns (bytes32) {
        bytes32 id = _id(kind, subject);
        return v.latest ? _cfg[id] : _valueAt(id, v.g);
    }

    function _ca(Kind kind, bytes32 subject, Ver memory v) internal view returns (address) {
        return _addr(_c(kind, subject, v));
    }

    function _ethAnchorFeed(Ver memory v) internal view returns (address) {
        address a = _ca(Kind.EthPadFeed, 0, v);
        return a == address(0) ? _ca(Kind.EthNumeraireFeed, 0, v) : a;
    }

    function _addr(bytes32 word) internal pure returns (address) {
        return address(uint160(uint256(word)));
    }

    function _w(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev `accepted` grown at `riseBpsPerDay` over the time since `at`,
    ///      counted as at most one day.
    function _rateCap(uint256 accepted, uint64 at, uint16 riseBpsPerDay) internal view returns (uint256) {
        uint256 dt = block.timestamp - at;
        if (dt > 1 days) dt = 1 days;
        return accepted + Math.mulDiv(accepted, uint256(riseBpsPerDay) * dt, BPS * 1 days);
    }

    function _fellPast(uint256 reported, uint256 from, uint16 maxFallBps) internal pure returns (bool) {
        return reported * BPS < from * (BPS - maxFallBps);
    }

    /// @dev The source's rate, or {StalePriceData} when it has none.
    function _requireRate(address token, RateBinding memory b) internal view returns (uint256 rate) {
        bool ok;
        (ok, rate) = _reportedRate(token, b);
        if (!ok) revert StalePriceData();
    }

    /// @dev What the rate source reports, 1e18-scaled, never reverting except
    ///      for too little gas: a reader is called with a fixed budget, so a
    ///      caller cannot starve it into "no rate" and still afford its own
    ///      work. A rate feed's answer must be no older than its heartbeat
    ///      plus {RATE_FEED_GRACE}.
    function _reportedRate(address token, RateBinding memory b) internal view returns (bool ok, uint256 rate) {
        if (b.sourceIsReader) {
            if (gasleft() < RATE_READ_GAS + RATE_READ_GAS / 63 + 10_000) revert RateReadOutOfGas();
            (bool success, bytes memory ret) =
                b.source.staticcall{gas: RATE_READ_GAS}(abi.encodeCall(IRateReader.rate, (token, b.underlying)));
            if (!success || ret.length != 32) return (false, 0);
            rate = abi.decode(ret, (uint256));
        } else {
            uint256 answer;
            uint8 dec;
            (ok, answer, dec) = _readWithin(b.source, b.rateHeartbeat);
            if (!ok) return (false, 0);
            rate = _rescale(answer, dec, 18);
        }
        ok = rate != 0 && rate <= type(uint128).max;
    }

    /// @dev A Chainlink answer no older than `heartbeat` plus
    ///      {RATE_FEED_GRACE}, never reverting.
    function _readWithin(address feed, uint32 heartbeat) internal view returns (bool ok, uint256 answer, uint8 dec) {
        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId, int256 a, uint256, uint256 u, uint80 answeredInRound
        ) {
            if (a <= 0 || u == 0 || u > block.timestamp || roundId != answeredInRound) return (false, 0, 0);
            if (block.timestamp - u > uint256(heartbeat) + RATE_FEED_GRACE) return (false, 0, 0);
            // forge-lint: disable-next-line(unsafe-typecast)
            answer = uint256(a);
        } catch {
            return (false, 0, 0);
        }
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            if (d > 36) return (false, 0, 0);
            return (true, answer, d);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev A non-empty, left-aligned run of lower-case ASCII letters.
    function _isLowerSymbol(bytes32 word) internal pure returns (bool) {
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
    function _wordToString(bytes32 word) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && word[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) out[i] = word[i];
        return string(out);
    }

    function _toLower(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) b[i] = bytes1(c + 32);
        }
        return string(b);
    }

    function _toUpper(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 0x61 && c <= 0x7A) b[i] = bytes1(c - 32);
        }
        return string(b);
    }

    /// @dev The product of two prices at the finer of their scales, divided
    ///      once at full width. Rounds down.
    function _composePrice(uint256 a, uint8 aDec, uint256 b, uint8 bDec) internal
        pure
        returns (uint256 price, uint8 decimals)
    {
        (uint8 lo, uint8 hi) = aDec < bDec ? (aDec, bDec) : (bDec, aDec);
        price = Math.mulDiv(a, b, 10 ** uint256(lo));
        decimals = hi;
    }

    function _rescale(uint256 value, uint8 fromDec, uint8 toDec) internal pure returns (uint256) {
        if (fromDec == toDec) return value;
        if (fromDec < toDec) return value * (10 ** uint256(toDec - fromDec));
        return value / (10 ** uint256(fromDec - toDec));
    }
}
