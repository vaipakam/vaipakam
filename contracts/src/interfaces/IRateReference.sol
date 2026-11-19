// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IRateReference
 * @author Vaipakam Developer Team
 * @notice The standalone rate reference (#3337 part 1, #3713): per lending
 *         asset, an annual variable borrowing rate taken from three or more
 *         outside lending markets, the running index built from it, hourly
 *         and daily checkpoints, the averaged reads and the term average.
 *         `RateReferenceDesign.md` and `TermAverageAndLinkGuardsDesign.md`.
 * @dev    Every rate this interface returns is a SIMPLE annual rate,
 *         1e18-scaled (1e18 = 100% a year), over a 365-day year. A rate in
 *         basis points converts by `bps * 1e14`.
 *
 *         The index of a series is the running total of
 *         `reference (1e18-scaled annual rate) x seconds`. The average over
 *         any period is `delta index / delta seconds`, and the interest on a
 *         principal over a period is
 *         `principal * delta index / (1e18 * 365 days)`, both exact in
 *         integers: no figure is rounded before the final division.
 */
interface IRateReference {
    // ─── Types ───────────────────────────────────────────────────────────

    /// @notice One outside market bound to an asset: the reader that reads
    ///         that kind of market, the market, and the market's own
    ///         identifier for the asset (zero where it needs none).
    struct Source {
        address reader;
        address market;
        bytes32 marketAssetId;
    }

    /// @notice One series' fixed configuration. Nothing in it changes after
    ///         the series opens; a different value is a new series.
    /// @param sources        Three to five outside markets.
    /// @param interval       The update interval, in seconds.
    /// @param minSpacing     The shortest gap between two updates that
    ///                       changes anything, in seconds.
    /// @param stepBpsPerHour The most the reference may move per hour, in
    ///                       basis points of annual rate, counted over at
    ///                       most one interval.
    /// @param toleranceBps   How close, in basis points of annual rate, a
    ///                       reading must be to the median to agree with it.
    /// @param ceilingBps     The highest reference the series accepts, in
    ///                       basis points of annual rate (the protocol's
    ///                       maximum interest rate when the series opens).
    struct SeriesConfig {
        Source[] sources;
        uint32 interval;
        uint32 minSpacing;
        uint16 stepBpsPerHour;
        uint16 toleranceBps;
        uint16 ceilingBps;
    }

    /// @notice Where a series is in its life.
    enum SeriesState {
        None,
        Pending,
        Live,
        Cancelled
    }

    /// @notice What an update decided for one series.
    enum Outcome {
        Accepted,
        HeldMuted,
        HeldFewReadings,
        HeldNoAgreement
    }

    /// @notice One source's state at an update.
    enum ReadState {
        Live,
        Muted,
        Failed
    }

    /// @notice Why an averaged read is unavailable (`Ok` when it is).
    enum AvgReason {
        Ok,
        NoSeries,
        Stale,
        NoCheckpoint,
        TooMuchHeld
    }

    /// @notice The "market unusual" state of an asset's reference (#3713,
    ///         design section 5). `NotKnown` when the 24-hour or the 30-day
    ///         average is unavailable.
    enum Unusual {
        NotKnown,
        Calm,
        Unusual
    }

    /// @notice What a maker's rate limit is linked to (#3635 A, #3713).
    enum LinkKind {
        None,
        Reference,
        TermAverage
    }

    /// @notice Why a linked rate cannot be used now (`None` when it can).
    enum LinkRefusal {
        None,
        ReferenceUnavailable,
        ReferenceUnusual
    }

    /// @notice A series' measured state.
    struct Series {
        address asset;
        SeriesState state;
        bool holding;
        uint32 prev;
        uint32 openLoans;
        uint64 openedAt;
        uint64 lastUpdate;
        uint64 holdingSince;
        uint128 referenceRate;
        uint64 held;
        uint256 index;
        // The previous newest series' index and held time when this one
        // opened, so a long window may continue into it (#3713 section 4).
        uint256 prevIndexAtOpen;
        uint64 prevHeldAtOpen;
        uint64 lastHour;
        uint64 lastDay;
    }

    /// @notice A checkpoint: the index and held time at `at`, and the key
    ///         (hour or day number) of the checkpoint before it.
    struct Checkpoint {
        uint256 index;
        uint64 held;
        uint64 at;
        uint64 prev;
    }

    /// @notice What {status} reports for an asset's newest series.
    struct Status {
        uint32 seriesId;
        uint256 referenceRate;
        uint256 index;
        uint256 held;
        uint64 lastUpdate;
        bool holding;
        uint64 holdingSince;
        bool stale;
        Unusual unusual;
    }

    /// @notice The term average and how it was formed.
    struct TermAverage {
        bool available;
        uint256 rate1e18;
        uint256 average24h;
        uint256 averageLong;
        uint256 longWindow;
        uint16 weightBps;
    }

    /// @notice A fixed rate's place against the warning band (#3713
    ///         section 6.4). `outside` is false whenever the term average is
    ///         unavailable: no average, no band.
    struct Band {
        bool available;
        uint256 termAverage1e18;
        bool outside;
        bool above;
        uint256 distanceBps;
    }

    /// @notice The platform settings, read for new loans and limits only.
    struct Settings {
        uint8 stalenessIntervals;
        uint8 maxLiveSeries;
        uint32 shortWindow;
        uint32 mediumWindow;
        uint32 longWindow;
        uint16 unusualDistanceBps;
        uint16 bandAboveBps;
        uint16 bandBelowBps;
        uint16 bandMinDistanceBps;
        uint16[5] weightsBps;
    }

    /// @notice The entries a delayed change can name.
    enum Kind {
        Delay,
        StalenessIntervals,
        ShortWindow,
        MediumWindow,
        LongWindow,
        UnusualDistanceBps,
        WeightTable,
        BandAboveBps,
        BandBelowBps,
        BandMinDistanceBps,
        MaxLiveSeries,
        OpenSeries,
        Unmute
    }

    // ─── Events ──────────────────────────────────────────────────────────

    /// @notice One series was updated: every source's reading and state
    ///         (a failed or muted source reads 0), what the quorum decided,
    ///         the median it formed (0 when it formed none), the reference now
    ///         in force, whether the step limit or the ceiling cut it, and the
    ///         index and held time after the update.
    event SeriesUpdated(
        address indexed asset,
        uint32 indexed seriesId,
        uint256[] readings,
        ReadState[] states,
        Outcome outcome,
        uint256 median,
        uint256 referenceRate,
        bool stepLimited,
        bool ceilingApplied,
        uint256 index,
        uint256 held
    );
    /// @notice A series' hourly checkpoint was written.
    event HourCheckpointed(uint32 indexed seriesId, uint256 indexed hour, uint256 index, uint256 held);
    /// @notice A series' daily checkpoint was written.
    event DayCheckpointed(uint32 indexed seriesId, uint256 indexed day, uint256 index, uint256 held);
    /// @notice A series was proposed, with its whole configuration and the
    ///         first reference measured now.
    event SeriesProposed(address indexed asset, uint32 indexed seriesId, SeriesConfig config, uint256 referenceRate, uint64 executableAt);
    /// @notice A proposed series became the asset's newest; `prev` is the
    ///         series it replaces as newest (0 for an asset's first).
    event SeriesOpened(address indexed asset, uint32 indexed seriesId, uint32 prev);
    /// @notice A proposed series was cancelled before it opened.
    event SeriesCancelled(address indexed asset, uint32 indexed seriesId);
    /// @notice A series is no longer written: it is not the newest and has
    ///         no open loans.
    event SeriesRetired(address indexed asset, uint32 indexed seriesId);
    /// @notice The Diamond moved a series' open-loan count.
    event SeriesLoanCount(uint32 indexed seriesId, uint32 openLoans);
    /// @notice A source was muted (at once) or unmuted (after the delay).
    event SourceMuted(address indexed asset, bytes32 indexed sourceKey, address by);
    event SourceUnmuted(address indexed asset, bytes32 indexed sourceKey);
    event ChangeProposed(Kind indexed kind, bytes32 indexed subject, bytes32 value, uint64 executableAt);
    event ChangeExecuted(Kind indexed kind, bytes32 indexed subject, bytes32 value);
    event ChangeCancelled(Kind indexed kind, bytes32 indexed subject, address by);
    event GuardianSet(address previous, address next);
    event DelaySet(uint64 previous, uint64 next);

    // ─── Reads ───────────────────────────────────────────────────────────

    /// @notice The average reference of `asset`'s newest series over the
    ///         last `window` seconds, and whether it is available.
    function averaged(address asset, uint256 window)
        external
        view
        returns (bool available, uint256 rate1e18, AvgReason reason);

    /// @notice The term average for a loan of `termDays` (#3713 section 6.2).
    function termAverage(address asset, uint256 termDays) external view returns (TermAverage memory);

    /// @notice The rate a link of `kind` produces for a loan of `termDays`
    ///         now, before the maker's margin, or why it cannot be used.
    ///         The window follows the term (24 hours up to 30 days, 7 days up
    ///         to 365, 30 days beyond); a term over 30 days waits while the
    ///         reference is unusual or its state is not known.
    function linkedRate(address asset, uint256 termDays, LinkKind kind)
        external
        view
        returns (uint256 rate1e18, LinkRefusal refusal);

    /// @notice Where a fixed rate of `rateBps` for `termDays` sits against
    ///         the warning band.
    function band(address asset, uint256 termDays, uint256 rateBps) external view returns (Band memory);

    /// @notice The state of `asset`'s newest series.
    function status(address asset) external view returns (Status memory);

    /// @notice `asset`'s newest series id; 0 when it has no reference.
    function newestSeries(address asset) external view returns (uint32);

    // ─── The Diamond's two entries (part 2 calls them) ───────────────────

    /// @notice Count a floating loan opened on `asset`'s newest series and
    ///         return that series. The Diamond only.
    function noteLoanOpened(address asset) external returns (uint32 seriesId);

    /// @notice Count a floating loan on `seriesId` closed. The Diamond only.
    function noteLoanClosed(uint32 seriesId) external;
}
