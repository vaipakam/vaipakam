// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRateReference} from "../../interfaces/IRateReference.sol";
import {IRateSourceReader} from "../../interfaces/IRateSourceReader.sol";
import {TestnetChains} from "../../compliance/TestnetChains.sol";

/**
 * @title  RateReference
 * @author Vaipakam Developer Team
 * @notice The one rate reference (#3337 part 1, #3713;
 *         `RateReferenceDesign.md`, `TermAverageAndLinkGuardsDesign.md`):
 *         per lending asset, an annual variable borrowing rate taken from
 *         three to five outside lending markets, the index built from it, its
 *         hourly and daily checkpoints, the averaged reads, the "market
 *         unusual" state, the term average and the warning band. It opens no
 *         loan and moves no funds. The Diamond finds it through the protocol
 *         registry's `RATE_REFERENCE` pointer (`LibRateReference`).
 *
 * @dev    Rules this contract holds by itself:
 *         - It is not upgradeable. A different rule set is a new contract,
 *           swapped in by the registry pointer under the registry's delay.
 *         - **Series.** A series is one immutable configuration of an asset
 *           (its sources, update interval, minimum spacing, step limit,
 *           agreement tolerance and ceiling) with its own reference, index,
 *           held time and checkpoints. A change of any of them opens a new
 *           series by a delayed change; an open loan reads only the series it
 *           opened on, so no configuration change ever alters what it accrues
 *           (#3437). The newest series is the asset's reference.
 *         - **The quorum.** An update reads every source of the series. While
 *           any of them is muted the reference holds. Otherwise a new
 *           reference needs three or more readings whose median has at least
 *           two readings (the median's own counted) within the tolerance;
 *           else it holds. Two readings are never enough.
 *         - **Bounded movement.** An accepted figure is cut to the ceiling,
 *           then to the step limit for the time since the last update
 *           counted as at most one interval, so many updates in a row move
 *           the reference no further than waiting would.
 *         - **Accrual order.** Each update first adds the reference that was
 *           in force times the seconds since the last update, and only then
 *           stores the new one, so a reading never prices time before it.
 *         - **Held time.** While the reference holds, held time grows with
 *           the index; seconds beyond one interval between two updates count
 *           as held whatever the quorum said, since nobody observed them.
 *         - **Starting a series.** The first reference is measured when the
 *           series is proposed and is updated under the step limit through
 *           the delay; the index starts at zero when it opens. A reading
 *           pushed in the executing transaction gains nothing.
 *         - **Changes.** Every change is the owner's (the Timelock's)
 *           proposal, executable by anyone once the delay has passed, one
 *           pending per entry. The owner or the guardian may cancel one. The
 *           delay is 7 to 14 days on a production chain; a testnet may set 0.
 *         - **One fast lever, stop-only.** The owner or the guardian may MUTE
 *           a source at once: every series that lists it holds until it is
 *           unmuted, which waits the delay. A mute never makes a reading
 *           acceptable nor moves a figure.
 *         - **The update is open to anyone.** Nothing breaks if it is late:
 *           interest accrues at the held figure and the averaged reads report
 *           themselves unavailable. No reward is paid here (design section 8).
 */
contract RateReference is IRateReference, Ownable2Step {
    // ─── Constants ───────────────────────────────────────────────────────

    uint64 public constant MIN_DELAY = 7 days;
    uint64 public constant MAX_DELAY = 14 days;

    uint256 public constant MIN_SOURCES = 3;
    uint256 public constant MAX_SOURCES = 5;

    uint32 public constant INTERVAL_MIN = 15 minutes;
    uint32 public constant INTERVAL_MAX = 6 hours;
    uint32 public constant MIN_SPACING_MIN = 5 minutes;
    uint16 public constant STEP_BPS_MIN = 10;
    uint16 public constant STEP_BPS_MAX = 500;
    uint16 public constant TOLERANCE_BPS_MIN = 50;
    uint16 public constant TOLERANCE_BPS_MAX = 1000;
    /// @notice The protocol's maximum interest rate (100% a year).
    uint16 public constant CEILING_BPS_MAX = 10_000;

    /// @notice The 24-hour average, the "today" figure and the short half of
    ///         the term average.
    uint256 public constant DAY_WINDOW = 24 hours;
    /// @notice The windows the unusual state compares.
    uint256 public constant MONTH_WINDOW = 30 days;
    /// @notice The long half of the term average, and the longest window any
    ///         averaged read takes.
    uint256 public constant LONG_TERM_WINDOW = 90 days;
    /// @notice The shortest window an averaged read takes.
    uint256 public constant MIN_WINDOW = 1 hours;
    /// @notice A window longer than this may continue into the asset's
    ///         previous series; the short-window bound, so the 24-hour read
    ///         never does (#3713 section 4).
    uint256 public constant CONTINUE_ABOVE = 72 hours;

    /// @notice The term (days) of each row of the term-average weight table.
    uint256 private constant ROWS = 5;

    /// @notice How many empty hour or day slots a checkpoint search steps
    ///         back over before it gives up on that resolution.
    uint256 private constant SEARCH_SLOTS = 4;

    /// @notice The gas one source read is given: exactly this much.
    uint256 public constant SOURCE_READ_GAS = 150_000;
    /// @dev The cost of the call itself, beyond what the 63/64 rule passes on.
    uint256 private constant READ_OVERHEAD_GAS = 20_000;

    /// @notice 1 basis point of annual rate at the 1e18 scale.
    uint256 private constant BPS = 1e14;

    // ─── Identity ────────────────────────────────────────────────────────

    /// @notice The Diamond, the only caller of the loan-count entries.
    address public immutable DIAMOND;
    /// @notice True when this chain may set a delay below {MIN_DELAY}.
    bool public immutable TESTNET;

    // ─── State ───────────────────────────────────────────────────────────

    address public guardian;
    uint64 public delay;

    Settings private _settings;

    uint32 public seriesCount;
    mapping(uint32 => Series) private _series;
    mapping(uint32 => SeriesConfig) private _config;
    mapping(uint32 => mapping(uint256 => Checkpoint)) private _hourly;
    mapping(uint32 => mapping(uint256 => Checkpoint)) private _daily;

    /// @inheritdoc IRateReference
    mapping(address => uint32) public newestSeries;
    /// @notice The series of `asset` proposed and not yet opened (0 = none).
    mapping(address => uint32) public pendingSeries;
    /// @dev The series of an asset the update writes: the newest and every
    ///      older one with open loans. A pending series is written too, from
    ///      {pendingSeries}.
    mapping(address => uint32[]) private _live;

    /// @notice Whether a source of an asset is muted, by
    ///         {sourceKey}(asset, source).
    mapping(bytes32 => bool) public muted;
    /// @dev The asset a source key belongs to, for the unmute event.
    mapping(bytes32 => address) private _unmuteAsset;

    struct Pending {
        bytes32 value;
        uint64 executableAt;
    }

    mapping(bytes32 => Pending) private _pending;

    // ─── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotOwnerOrGuardian(address caller);
    error NotDiamond(address caller);
    error RenounceDisabled();
    error DelayOutOfRange(uint256 delay, uint256 min, uint256 max);
    error InvalidChange(Kind kind, bytes32 subject, bytes32 value);
    error ChangePending(Kind kind, bytes32 subject);
    error NothingPending(Kind kind, bytes32 subject);
    error NotReady(Kind kind, bytes32 subject, uint64 executableAt);
    error InvalidSeriesConfig(uint8 field);
    error SeriesPendingForAsset(address asset, uint32 seriesId);
    error TooManyLiveSeries(address asset, uint256 live, uint256 max);
    error NoStartingReference(address asset, Outcome outcome);
    error NoReference(address asset);
    error SeriesNotLive(uint32 seriesId);
    error NoOpenLoans(uint32 seriesId);
    error WindowOutOfRange(uint256 window);
    error UnknownSource(address asset, bytes32 sourceKey);
    /// @notice Too little gas was left to give a source read its whole
    ///         budget. Raise the transaction's gas limit; nothing was read.
    error UpdateOutOfGas();

    // ─── Construction ────────────────────────────────────────────────────

    /// @param owner_    The chain's admin (the Timelock takes it at handover).
    /// @param guardian_ The Pauser Safe.
    /// @param diamond_  The Diamond, the only caller of the loan counts.
    /// @param delay_    The starting delay, within the chain's bounds.
    constructor(address owner_, address guardian_, address diamond_, uint64 delay_) Ownable(owner_) {
        if (guardian_ == address(0) || diamond_ == address(0)) revert ZeroAddress();
        TESTNET = TestnetChains.isTestnet(block.chainid);
        DIAMOND = diamond_;
        _checkDelay(delay_);
        delay = delay_;
        guardian = guardian_;
        emit GuardianSet(address(0), guardian_);
        emit DelaySet(0, delay_);
        _settings = Settings({
            stalenessIntervals: 3,
            maxLiveSeries: 3,
            shortWindow: 24 hours,
            mediumWindow: 7 days,
            longWindow: 30 days,
            unusualDistanceBps: 500,
            bandAboveBps: 15_000,
            bandBelowBps: 5_000,
            bandMinDistanceBps: 200,
            weightsBps: [uint16(10_000), 7_500, 5_000, 2_500, 1_000]
        });
    }

    // ─── The update ──────────────────────────────────────────────────────

    /// @notice Update every series of `asset` that is written: the newest,
    ///         each older one with open loans, and a proposed one waiting to
    ///         open. Anyone may call. A series updated less than its minimum
    ///         spacing ago is left as it is.
    function update(address asset) external {
        uint32[] storage live = _live[asset];
        uint256 n = live.length;
        uint32 p = pendingSeries[asset];
        if (n == 0 && p == 0) revert NoReference(asset);
        for (uint256 i; i < n; ++i) {
            _updateSeries(live[i]);
        }
        if (p != 0) _updateSeries(p);
    }

    /// @dev One series: accrue the reference in force, read the quorum,
    ///      bound the new figure, store it, checkpoint.
    function _updateSeries(uint32 id) private {
        Series storage s = _series[id];
        SeriesConfig storage c = _config[id];
        uint256 dt = block.timestamp - s.lastUpdate;
        if (dt < c.minSpacing) return;
        bool live_ = s.state == SeriesState.Live;

        // 1. Accrue the reference that was in force (a pending series has no
        //    index yet).
        if (live_) {
            s.index += uint256(s.referenceRate) * dt;
            s.held += uint64(_heldOver(s.holding, dt, c.interval));
        }

        // 2. The quorum.
        (uint256[] memory readings, ReadState[] memory states, Outcome outcome, uint256 median) = _readQuorum(s.asset, c);

        // 3. Bound and store.
        bool stepLimited;
        bool ceilingApplied;
        if (outcome == Outcome.Accepted) {
            uint256 next = median;
            uint256 ceiling = uint256(c.ceilingBps) * BPS;
            if (next > ceiling) {
                next = ceiling;
                ceilingApplied = true;
            }
            uint256 counted = dt < c.interval ? dt : c.interval;
            uint256 maxStep = uint256(c.stepBpsPerHour) * BPS * counted / 1 hours;
            uint256 prev = s.referenceRate;
            if (next > prev + maxStep) {
                next = prev + maxStep;
                stepLimited = true;
            } else if (prev > next + maxStep) {
                next = prev - maxStep;
                stepLimited = true;
            }
            // safe: `next` is at most the ceiling, itself below 1e18.
            // forge-lint: disable-next-line(unsafe-typecast)
            s.referenceRate = uint128(next);
            s.holding = false;
            s.holdingSince = 0;
        } else if (!s.holding) {
            s.holding = true;
            s.holdingSince = uint64(block.timestamp);
        }
        s.lastUpdate = uint64(block.timestamp);

        emit SeriesUpdated(
            s.asset, id, readings, states, outcome, median, s.referenceRate, stepLimited, ceilingApplied, s.index, s.held
        );

        // 4. Checkpoints, for a series that has an index.
        if (live_) _checkpoint(id, s);
    }

    /// @dev Seconds of `dt` that count as held: all of them while holding,
    ///      else those beyond one interval.
    function _heldOver(bool holding, uint256 dt, uint256 interval) private pure returns (uint256) {
        if (holding) return dt;
        return dt > interval ? dt - interval : 0;
    }

    /// @dev Read every source; the outcome and the median (0 unless
    ///      accepted). A muted source holds the whole series.
    function _readQuorum(address asset, SeriesConfig storage c)
        private
        view
        returns (uint256[] memory readings, ReadState[] memory states, Outcome outcome, uint256 median)
    {
        uint256 n = c.sources.length;
        readings = new uint256[](n);
        states = new ReadState[](n);
        uint256[] memory ok = new uint256[](n);
        uint256 count;
        bool anyMuted;
        for (uint256 i; i < n; ++i) {
            Source storage src = c.sources[i];
            if (muted[sourceKey(asset, src)]) {
                states[i] = ReadState.Muted;
                anyMuted = true;
                continue;
            }
            (bool good, uint256 r) = _read(asset, src);
            if (!good) {
                states[i] = ReadState.Failed;
                continue;
            }
            readings[i] = r;
            ok[count++] = r;
        }
        if (anyMuted) return (readings, states, Outcome.HeldMuted, 0);
        if (count < MIN_SOURCES) return (readings, states, Outcome.HeldFewReadings, 0);
        _sort(ok, count);
        uint256 m = count % 2 == 1 ? ok[count / 2] : (ok[count / 2 - 1] + ok[count / 2]) / 2;
        uint256 tol = uint256(c.toleranceBps) * BPS;
        uint256 agreeing;
        for (uint256 i; i < count; ++i) {
            uint256 d = ok[i] > m ? ok[i] - m : m - ok[i];
            if (d <= tol) ++agreeing;
        }
        if (agreeing < 2) return (readings, states, Outcome.HeldNoAgreement, 0);
        return (readings, states, Outcome.Accepted, m);
    }

    /// @dev One source read; a revert or an absurd figure is a failed read.
    ///      Each read gets exactly {SOURCE_READ_GAS}, and the update refuses
    ///      to start a read it cannot give that much, so whoever sends an
    ///      update cannot starve a source into reading as failed and hold the
    ///      reference with a chosen gas limit (the #3504 rule, as the price
    ///      guard's reads keep it).
    function _read(address asset, Source storage src) private view returns (bool ok, uint256 rate1e18) {
        if (gasleft() < SOURCE_READ_GAS * 64 / 63 + READ_OVERHEAD_GAS) revert UpdateOutOfGas();
        try IRateSourceReader(src.reader).readRate{gas: SOURCE_READ_GAS}(asset, src.market, src.marketAssetId) returns (
            bool good, uint256 r
        ) {
            // A rate above 1000% a year is no market's honest answer.
            if (good && r <= 10e18) return (true, r);
        } catch {}
        return (false, 0);
    }

    /// @dev Insertion sort of the first `n` entries (n <= 5).
    function _sort(uint256[] memory a, uint256 n) private pure {
        for (uint256 i = 1; i < n; ++i) {
            uint256 v = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > v) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = v;
        }
    }

    /// @dev The first update in a UTC hour, and in a UTC day, records a
    ///      checkpoint that names the one before it.
    function _checkpoint(uint32 id, Series storage s) private {
        uint256 hour = block.timestamp / 1 hours;
        if (_hourly[id][hour].at == 0) {
            _hourly[id][hour] = Checkpoint({index: s.index, held: s.held, at: uint64(block.timestamp), prev: s.lastHour});
            s.lastHour = uint64(hour);
            emit HourCheckpointed(id, hour, s.index, s.held);
        }
        uint256 day = block.timestamp / 1 days;
        if (_daily[id][day].at == 0) {
            _daily[id][day] = Checkpoint({index: s.index, held: s.held, at: uint64(block.timestamp), prev: s.lastDay});
            s.lastDay = uint64(day);
            emit DayCheckpointed(id, day, s.index, s.held);
        }
    }

    // ─── Series ──────────────────────────────────────────────────────────

    /// @notice Propose a new series for `asset`: its first, or a new
    ///         configuration. The first reference is measured now and must
    ///         come from an agreeing quorum; from here to execution it is
    ///         updated under the step limit like any other. Refused while
    ///         another series of the asset is pending, and when opening it
    ///         would pass the bound on live series.
    /// @return id The proposed series.
    function proposeSeries(address asset, SeriesConfig calldata cfg) external onlyOwner returns (uint32 id) {
        if (asset == address(0)) revert ZeroAddress();
        if (pendingSeries[asset] != 0) revert SeriesPendingForAsset(asset, pendingSeries[asset]);
        _validateConfig(asset, cfg);
        _requireLiveRoom(asset);

        id = ++seriesCount;
        SeriesConfig storage c = _config[id];
        for (uint256 i; i < cfg.sources.length; ++i) {
            c.sources.push(cfg.sources[i]);
        }
        c.interval = cfg.interval;
        c.minSpacing = cfg.minSpacing;
        c.stepBpsPerHour = cfg.stepBpsPerHour;
        c.toleranceBps = cfg.toleranceBps;
        c.ceilingBps = cfg.ceilingBps;

        (,, Outcome outcome, uint256 median) = _readQuorum(asset, c);
        if (outcome != Outcome.Accepted) revert NoStartingReference(asset, outcome);
        uint256 ceiling = uint256(cfg.ceilingBps) * BPS;
        uint256 first = median > ceiling ? ceiling : median;

        Series storage s = _series[id];
        s.asset = asset;
        s.state = SeriesState.Pending;
        // safe: at most the ceiling, below 1e18.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.referenceRate = uint128(first);
        s.lastUpdate = uint64(block.timestamp);
        pendingSeries[asset] = id;

        uint64 at = _propose(Kind.OpenSeries, _w(asset), bytes32(uint256(id)));
        emit SeriesProposed(asset, id, cfg, first, at);
    }

    function _validateConfig(address asset, SeriesConfig calldata cfg) private view {
        uint256 n = cfg.sources.length;
        if (n < MIN_SOURCES || n > MAX_SOURCES) revert InvalidSeriesConfig(0);
        for (uint256 i; i < n; ++i) {
            Source calldata a = cfg.sources[i];
            if (a.reader.code.length == 0 || a.market == address(0)) revert InvalidSeriesConfig(1);
            bytes32 k = sourceKey(asset, a);
            for (uint256 j; j < i; ++j) {
                if (sourceKey(asset, cfg.sources[j]) == k) revert InvalidSeriesConfig(2);
            }
        }
        if (cfg.interval < INTERVAL_MIN || cfg.interval > INTERVAL_MAX) revert InvalidSeriesConfig(3);
        if (cfg.minSpacing < MIN_SPACING_MIN || cfg.minSpacing > cfg.interval) revert InvalidSeriesConfig(4);
        if (cfg.stepBpsPerHour < STEP_BPS_MIN || cfg.stepBpsPerHour > STEP_BPS_MAX) revert InvalidSeriesConfig(5);
        if (cfg.toleranceBps < TOLERANCE_BPS_MIN || cfg.toleranceBps > TOLERANCE_BPS_MAX) {
            revert InvalidSeriesConfig(6);
        }
        if (cfg.ceilingBps == 0 || cfg.ceilingBps > CEILING_BPS_MAX) revert InvalidSeriesConfig(7);
    }

    /// @dev Opening one more series must keep the asset within the bound:
    ///      every older series with open loans, plus the newest if it has
    ///      loans (it stays written), plus the new one.
    function _requireLiveRoom(address asset) private view {
        uint32[] storage live = _live[asset];
        uint256 keep;
        for (uint256 i; i < live.length; ++i) {
            if (_series[live[i]].openLoans != 0) ++keep;
        }
        uint256 max = _settings.maxLiveSeries;
        if (keep + 1 > max) revert TooManyLiveSeries(asset, keep + 1, max);
    }

    /// @dev Open a pending series: it becomes the asset's newest, its index
    ///      starts at zero, and the previous newest's index and held time
    ///      now are kept so a long window may continue into it.
    function _openSeries(address asset, uint32 id) private {
        if (pendingSeries[asset] != id) revert InvalidChange(Kind.OpenSeries, _w(asset), bytes32(uint256(id)));
        _requireLiveRoom(asset);
        Series storage s = _series[id];
        uint32 prev = newestSeries[asset];
        if (prev != 0) {
            Series storage p = _series[prev];
            (uint256 idx, uint256 held) = _accruedTo(p, _config[prev].interval, block.timestamp);
            s.prevIndexAtOpen = idx;
            // safe: held seconds since the previous series opened.
            // forge-lint: disable-next-line(unsafe-typecast)
            s.prevHeldAtOpen = uint64(held);
            s.prev = prev;
        }
        s.state = SeriesState.Live;
        s.openedAt = uint64(block.timestamp);
        s.lastUpdate = uint64(block.timestamp);
        pendingSeries[asset] = 0;
        newestSeries[asset] = id;
        _live[asset].push(id);
        _checkpoint(id, s);
        emit SeriesOpened(asset, id, prev);
        if (prev != 0 && _series[prev].openLoans == 0) _retire(asset, prev);
    }

    /// @dev Stop writing `id`: no longer the newest and no open loans.
    function _retire(address asset, uint32 id) private {
        uint32[] storage live = _live[asset];
        uint256 n = live.length;
        for (uint256 i; i < n; ++i) {
            if (live[i] == id) {
                live[i] = live[n - 1];
                live.pop();
                emit SeriesRetired(asset, id);
                return;
            }
        }
    }

    // ─── The Diamond's loan counts ───────────────────────────────────────

    /// @inheritdoc IRateReference
    function noteLoanOpened(address asset) external returns (uint32 id) {
        if (msg.sender != DIAMOND) revert NotDiamond(msg.sender);
        id = newestSeries[asset];
        if (id == 0) revert NoReference(asset);
        Series storage s = _series[id];
        uint32 n = ++s.openLoans;
        emit SeriesLoanCount(id, n);
    }

    /// @inheritdoc IRateReference
    function noteLoanClosed(uint32 id) external {
        if (msg.sender != DIAMOND) revert NotDiamond(msg.sender);
        Series storage s = _series[id];
        if (s.state != SeriesState.Live) revert SeriesNotLive(id);
        if (s.openLoans == 0) revert NoOpenLoans(id);
        uint32 n = --s.openLoans;
        emit SeriesLoanCount(id, n);
        if (n == 0 && newestSeries[s.asset] != id) _retire(s.asset, id);
    }

    // ─── Mutes ───────────────────────────────────────────────────────────

    /// @notice The key a source of `asset` is muted under.
    function sourceKey(address asset, Source memory src) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, src.reader, src.market, src.marketAssetId));
    }

    /// @notice Mute a source of `asset` at once: every series that lists it
    ///         holds. Stop-only. It also cancels a pending unmute of it, even
    ///         one already due; unmuting is a new proposal that waits the
    ///         delay.
    function mute(address asset, Source calldata src) external onlyOwnerOrGuardian {
        bytes32 k = sourceKey(asset, src);
        _cancelPending(Kind.Unmute, k);
        if (muted[k]) return;
        muted[k] = true;
        emit SourceMuted(asset, k, msg.sender);
    }

    /// @notice Propose unmuting a muted source of `asset`; it waits the delay.
    function proposeUnmute(address asset, Source calldata src) external onlyOwner {
        bytes32 k = sourceKey(asset, src);
        if (!muted[k]) revert UnknownSource(asset, k);
        _unmuteAsset[k] = asset;
        _propose(Kind.Unmute, k, bytes32(uint256(1)));
    }

    // ─── Delayed changes ─────────────────────────────────────────────────

    /// @notice The pending change to (`kind`, `subject`); `executableAt` 0 = none.
    function pendingChange(Kind kind, bytes32 subject) external view returns (bytes32 value, uint64 executableAt) {
        Pending storage p = _pending[_id(kind, subject)];
        return (p.value, p.executableAt);
    }

    /// @notice Propose a change of a platform setting or a lower delay. A
    ///         series opens through {proposeSeries}, an unmute through
    ///         {proposeUnmute}. Checked now and again at execution.
    function proposeChange(Kind kind, bytes32 value) external onlyOwner {
        if (kind == Kind.OpenSeries || kind == Kind.Unmute) revert InvalidChange(kind, bytes32(0), value);
        _propose(kind, bytes32(0), value);
    }

    /// @notice Apply a pending change whose delay has passed. Anyone may call.
    function executeChange(Kind kind, bytes32 subject) external {
        bytes32 key = _id(kind, subject);
        Pending storage p = _pending[key];
        uint64 at = p.executableAt;
        if (at == 0) revert NothingPending(kind, subject);
        if (block.timestamp < at) revert NotReady(kind, subject, at);
        bytes32 value = p.value;
        delete _pending[key];
        if (kind == Kind.OpenSeries) {
            // safe: a series id written by {proposeSeries}.
            // forge-lint: disable-next-line(unsafe-typecast)
            _openSeries(address(uint160(uint256(subject))), uint32(uint256(value)));
        } else if (kind == Kind.Unmute) {
            muted[subject] = false;
            emit SourceUnmuted(_unmuteAsset[subject], subject);
        } else if (kind == Kind.Delay) {
            uint64 d = uint64(uint256(value));
            emit DelaySet(delay, d);
            delay = d;
        } else {
            _validate(kind, value);
            _apply(kind, value);
        }
        emit ChangeExecuted(kind, subject, value);
    }

    /// @notice Cancel a pending change. The owner or the guardian; a cancel
    ///         only ever refuses a change. Cancelling a series' opening
    ///         cancels the series.
    function cancelChange(Kind kind, bytes32 subject) external onlyOwnerOrGuardian {
        bytes32 key = _id(kind, subject);
        if (_pending[key].executableAt == 0) revert NothingPending(kind, subject);
        if (kind == Kind.OpenSeries) {
            address asset = address(uint160(uint256(subject)));
            uint32 id = pendingSeries[asset];
            _series[id].state = SeriesState.Cancelled;
            pendingSeries[asset] = 0;
            emit SeriesCancelled(asset, id);
        }
        delete _pending[key];
        emit ChangeCancelled(kind, subject, msg.sender);
    }

    /// @notice Raise the delay at once: a longer wait only tightens.
    function raiseDelay(uint64 newDelay) external onlyOwner {
        if (newDelay <= delay) revert DelayOutOfRange(newDelay, uint256(delay) + 1, MAX_DELAY);
        _checkDelay(newDelay);
        emit DelaySet(delay, newDelay);
        delay = newDelay;
    }

    /// @notice Set the guardian. Owner only.
    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianSet(guardian, next);
        guardian = next;
    }

    /// @notice Disabled: with no owner no series could ever open again.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        _;
    }

    function _propose(Kind kind, bytes32 subject, bytes32 value) private returns (uint64 at) {
        bytes32 key = _id(kind, subject);
        Pending storage p = _pending[key];
        if (p.executableAt != 0) revert ChangePending(kind, subject);
        if (kind == Kind.Delay) {
            uint256 d = uint256(value);
            if (d >= delay) revert InvalidChange(kind, subject, value);
            _checkDelay(uint64(d));
        } else if (kind != Kind.OpenSeries && kind != Kind.Unmute) {
            _validate(kind, value);
        }
        at = uint64(block.timestamp) + delay;
        p.value = value;
        p.executableAt = at;
        emit ChangeProposed(kind, subject, value, at);
    }

    function _cancelPending(Kind kind, bytes32 subject) private {
        bytes32 key = _id(kind, subject);
        if (_pending[key].executableAt != 0) {
            delete _pending[key];
            emit ChangeCancelled(kind, subject, msg.sender);
        }
    }

    function _checkDelay(uint64 d) private view {
        uint64 min = TESTNET ? 0 : MIN_DELAY;
        if (d < min || d > MAX_DELAY) revert DelayOutOfRange(d, min, MAX_DELAY);
    }

    /// @dev The bounds of every platform setting (design section 7 and
    ///      #3713 sections 3, 5, 6).
    function _validate(Kind kind, bytes32 value) private pure {
        uint256 v = uint256(value);
        bool ok;
        if (kind == Kind.StalenessIntervals) ok = v >= 2 && v <= 12;
        else if (kind == Kind.MaxLiveSeries) ok = v >= 2 && v <= 4;
        else if (kind == Kind.ShortWindow) ok = v >= 12 hours && v <= CONTINUE_ABOVE;
        else if (kind == Kind.MediumWindow) ok = v >= 3 days && v <= 14 days;
        else if (kind == Kind.LongWindow) ok = v >= 14 days && v <= 60 days;
        else if (kind == Kind.UnusualDistanceBps) ok = v >= 200 && v <= 1500;
        else if (kind == Kind.BandAboveBps) ok = v >= 11_000 && v <= 30_000;
        else if (kind == Kind.BandBelowBps) ok = v >= 2_000 && v <= 9_000;
        else if (kind == Kind.BandMinDistanceBps) ok = v >= 50 && v <= 1_000;
        else if (kind == Kind.WeightTable) ok = _weightsValid(v);
        if (!ok) revert InvalidChange(kind, bytes32(0), value);
    }

    /// @dev Five 16-bit weights, row 0 in the low bits, each at most 100%
    ///      and never rising with the term; the first row (7 days) is 100%.
    function _weightsValid(uint256 v) private pure returns (bool) {
        if (v >> (16 * ROWS) != 0) return false;
        uint256 last = 10_000;
        for (uint256 i; i < ROWS; ++i) {
            uint256 w = (v >> (16 * i)) & 0xffff;
            if (w > last) return false;
            if (i == 0 && w != 10_000) return false;
            last = w;
        }
        return true;
    }

    function _apply(Kind kind, bytes32 value) private {
        uint256 v = uint256(value);
        Settings storage st = _settings;
        // safe: every value below is range-checked by `_validate`.
        // forge-lint: disable-start(unsafe-typecast)
        if (kind == Kind.StalenessIntervals) st.stalenessIntervals = uint8(v);
        else if (kind == Kind.MaxLiveSeries) st.maxLiveSeries = uint8(v);
        else if (kind == Kind.ShortWindow) st.shortWindow = uint32(v);
        else if (kind == Kind.MediumWindow) st.mediumWindow = uint32(v);
        else if (kind == Kind.LongWindow) st.longWindow = uint32(v);
        else if (kind == Kind.UnusualDistanceBps) st.unusualDistanceBps = uint16(v);
        else if (kind == Kind.BandAboveBps) st.bandAboveBps = uint16(v);
        else if (kind == Kind.BandBelowBps) st.bandBelowBps = uint16(v);
        else if (kind == Kind.BandMinDistanceBps) st.bandMinDistanceBps = uint16(v);
        else if (kind == Kind.WeightTable) {
            for (uint256 i; i < ROWS; ++i) {
                st.weightsBps[i] = uint16((v >> (16 * i)) & 0xffff);
            }
        }
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _id(Kind kind, bytes32 subject) private pure returns (bytes32) {
        return keccak256(abi.encode(kind, subject));
    }

    function _w(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // ─── Reads ───────────────────────────────────────────────────────────

    /// @dev A series' index and held time carried to `t` (at or after its
    ///      last update) at the reference in force, as the next update would.
    function _accruedTo(Series storage s, uint256 interval, uint256 t)
        private
        view
        returns (uint256 idx, uint256 held)
    {
        uint256 dt = t - s.lastUpdate;
        idx = s.index + uint256(s.referenceRate) * dt;
        held = uint256(s.held) + _heldOver(s.holding, dt, interval);
    }

    /// @dev The staleness limit of a series: the platform's count of its
    ///      own update intervals.
    function _staleAfter(uint32 id) private view returns (uint256) {
        return uint256(_settings.stalenessIntervals) * _config[id].interval;
    }

    /// @inheritdoc IRateReference
    function averaged(address asset, uint256 window)
        public
        view
        returns (bool available, uint256 rate1e18, AvgReason reason)
    {
        if (window < MIN_WINDOW || window > LONG_TERM_WINDOW) revert WindowOutOfRange(window);
        uint32 id = newestSeries[asset];
        if (id == 0) return (false, 0, AvgReason.NoSeries);
        Series storage s = _series[id];
        if (block.timestamp - s.lastUpdate > _staleAfter(id)) return (false, 0, AvgReason.Stale);
        if (block.timestamp <= window) return (false, 0, AvgReason.NoCheckpoint);
        uint256 t = block.timestamp - window;
        (uint256 idxNow, uint256 heldNow) = _accruedTo(s, _config[id].interval, block.timestamp);

        bool found;
        Checkpoint memory cp;
        uint256 dIdx;
        uint256 dHeld;
        if (s.openedAt <= t) {
            (found, cp) = _find(id, t);
            if (found) {
                dIdx = idxNow - cp.index;
                dHeld = heldNow - cp.held;
            }
        } else if (window > CONTINUE_ABOVE && s.prev != 0) {
            (found, cp) = _find(s.prev, t);
            if (found) {
                dIdx = s.prevIndexAtOpen - cp.index + idxNow;
                dHeld = uint256(s.prevHeldAtOpen) - cp.held + heldNow;
            }
        }
        if (!found) return (false, 0, AvgReason.NoCheckpoint);
        uint256 age = block.timestamp - cp.at;
        if (age > 2 * window) return (false, 0, AvgReason.NoCheckpoint);
        if (dHeld * 2 > window) return (false, 0, AvgReason.TooMuchHeld);
        return (true, dIdx / age, AvgReason.Ok);
    }

    /// @dev The newest checkpoint of series `id` at or before `t`: the hour
    ///      slot of `t` (or, if written after `t`, the one before it), else a
    ///      few earlier hour slots, else the same search by day. Bounded
    ///      reads; the caller refuses a find older than twice the window.
    function _find(uint32 id, uint256 t) private view returns (bool, Checkpoint memory) {
        (bool f, Checkpoint memory c) = _findIn(_hourly[id], t, t / 1 hours);
        if (f) return (true, c);
        return _findIn(_daily[id], t, t / 1 days);
    }

    function _findIn(mapping(uint256 => Checkpoint) storage book, uint256 t, uint256 slot)
        private
        view
        returns (bool, Checkpoint memory)
    {
        for (uint256 k; k < SEARCH_SLOTS && k <= slot; ++k) {
            Checkpoint memory c = book[slot - k];
            if (c.at == 0) continue;
            if (c.at <= t) return (true, c);
            // Written in t's own slot but after t: the one before it is
            // in an earlier slot, so at or before t.
            Checkpoint memory p = book[c.prev];
            if (p.at != 0 && p.at <= t) return (true, p);
            return (false, c);
        }
        Checkpoint memory none;
        return (false, none);
    }

    /// @notice The "market unusual" state of `asset`'s reference.
    function unusual(address asset) public view returns (Unusual) {
        (bool ok24, uint256 a24,) = averaged(asset, DAY_WINDOW);
        (bool ok30, uint256 a30,) = averaged(asset, MONTH_WINDOW);
        if (!ok24 || !ok30) return Unusual.NotKnown;
        uint256 d = a24 > a30 ? a24 - a30 : a30 - a24;
        return d > uint256(_settings.unusualDistanceBps) * BPS ? Unusual.Unusual : Unusual.Calm;
    }

    /// @notice The weight on the 24-hour average for a term of `termDays`:
    ///         the table's rows at 7, 30, 90, 180 and 365 days, straight
    ///         lines between them, the first row below 7 days and the last
    ///         beyond 365.
    function weightBps(uint256 termDays) public view returns (uint16) {
        uint16[5] memory w = _settings.weightsBps;
        uint16[5] memory d = [uint16(7), 30, 90, 180, 365];
        if (termDays <= d[0]) return w[0];
        for (uint256 i = 1; i < ROWS; ++i) {
            if (termDays <= d[i]) {
                uint256 span = d[i] - d[i - 1];
                uint256 into = termDays - d[i - 1];
                // Weights never rise with the term, so w[i-1] >= w[i].
                // safe: between two uint16 weights.
                // forge-lint: disable-next-line(unsafe-typecast)
                return uint16(w[i - 1] - (uint256(w[i - 1] - w[i]) * into) / span);
            }
        }
        return w[ROWS - 1];
    }

    /// @inheritdoc IRateReference
    function termAverage(address asset, uint256 termDays) public view returns (TermAverage memory ta) {
        ta.weightBps = weightBps(termDays);
        bool ok24;
        (ok24, ta.average24h,) = averaged(asset, DAY_WINDOW);
        if (ta.weightBps == 10_000) {
            ta.available = ok24;
            ta.rate1e18 = ok24 ? ta.average24h : 0;
            return ta;
        }
        // The 90-day average, or the longest available of 60 and 30 days.
        uint256[3] memory windows = [LONG_TERM_WINDOW, 60 days, MONTH_WINDOW];
        for (uint256 i; i < 3; ++i) {
            (bool ok, uint256 a,) = averaged(asset, windows[i]);
            if (ok) {
                ta.averageLong = a;
                ta.longWindow = windows[i];
                break;
            }
        }
        if (!ok24 || ta.longWindow == 0) return ta;
        ta.available = true;
        ta.rate1e18 = (uint256(ta.weightBps) * ta.average24h + (10_000 - uint256(ta.weightBps)) * ta.averageLong)
            / 10_000;
    }

    /// @notice The window a market-linked limit reads for a loan of
    ///         `termDays` (#3713 section 3).
    function windowForTerm(uint256 termDays) public view returns (uint256) {
        if (termDays <= 30) return _settings.shortWindow;
        if (termDays <= 365) return _settings.mediumWindow;
        return _settings.longWindow;
    }

    /// @inheritdoc IRateReference
    function linkedRate(address asset, uint256 termDays, LinkKind kind)
        external
        view
        returns (uint256 rate1e18, LinkRefusal refusal)
    {
        bool available;
        if (kind == LinkKind.Reference) {
            (available, rate1e18,) = averaged(asset, windowForTerm(termDays));
        } else if (kind == LinkKind.TermAverage) {
            TermAverage memory ta = termAverage(asset, termDays);
            (available, rate1e18) = (ta.available, ta.rate1e18);
        }
        if (!available) return (0, LinkRefusal.ReferenceUnavailable);
        if (termDays > 30) {
            Unusual u = unusual(asset);
            if (u == Unusual.Unusual) return (0, LinkRefusal.ReferenceUnusual);
            if (u == Unusual.NotKnown) return (0, LinkRefusal.ReferenceUnavailable);
        }
        return (rate1e18, LinkRefusal.None);
    }

    /// @inheritdoc IRateReference
    function band(address asset, uint256 termDays, uint256 rateBps) external view returns (Band memory b) {
        TermAverage memory ta = termAverage(asset, termDays);
        if (!ta.available) return b;
        b.available = true;
        b.termAverage1e18 = ta.rate1e18;
        uint256 r = rateBps * BPS;
        uint256 avg = ta.rate1e18;
        uint256 dist = r > avg ? r - avg : avg - r;
        b.distanceBps = dist / BPS;
        if (dist < uint256(_settings.bandMinDistanceBps) * BPS) return b;
        if (r > avg && r * 10_000 > avg * _settings.bandAboveBps) {
            b.outside = true;
            b.above = true;
        } else if (r < avg && r * 10_000 < avg * _settings.bandBelowBps) {
            b.outside = true;
        }
    }

    /// @inheritdoc IRateReference
    function status(address asset) external view returns (Status memory st) {
        uint32 id = newestSeries[asset];
        if (id == 0) return st;
        Series storage s = _series[id];
        (uint256 idx, uint256 held) = _accruedTo(s, _config[id].interval, block.timestamp);
        uint256 limit = _staleAfter(id);
        st.seriesId = id;
        st.referenceRate = s.referenceRate;
        st.index = idx;
        st.held = held;
        st.lastUpdate = s.lastUpdate;
        st.holding = s.holding;
        st.holdingSince = s.holdingSince;
        st.stale = block.timestamp - s.lastUpdate > limit || (s.holding && block.timestamp - s.holdingSince > limit);
        st.unusual = unusual(asset);
    }

    /// @notice A series' measured state.
    function seriesOf(uint32 id) external view returns (Series memory) {
        return _series[id];
    }

    /// @notice A series' fixed configuration.
    function configOf(uint32 id) external view returns (SeriesConfig memory) {
        return _config[id];
    }

    /// @notice The series of `asset` the update writes (a pending one aside).
    function liveSeries(address asset) external view returns (uint32[] memory) {
        return _live[asset];
    }

    /// @notice Series `id`'s checkpoint for UTC hour `hour` (`at` 0 = none).
    function hourCheckpoint(uint32 id, uint256 hour) external view returns (Checkpoint memory) {
        return _hourly[id][hour];
    }

    /// @notice Series `id`'s checkpoint for UTC day `day` (`at` 0 = none).
    function dayCheckpoint(uint32 id, uint256 day) external view returns (Checkpoint memory) {
        return _daily[id][day];
    }

    /// @notice The platform settings.
    function settings() external view returns (Settings memory) {
        return _settings;
    }

    /// @notice Each source of series `id` now: its reading and state, as the
    ///         next update would see it.
    function sourceReadings(uint32 id) external view returns (uint256[] memory readings, ReadState[] memory states) {
        (readings, states,,) = _readQuorum(_series[id].asset, _config[id]);
    }
}
