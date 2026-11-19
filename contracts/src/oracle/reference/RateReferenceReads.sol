// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRateReference} from "../../interfaces/IRateReference.sol";
import {IRateReferenceReads} from "../../interfaces/IRateReferenceReads.sol";

/**
 * @title  RateReferenceReads
 * @author Vaipakam Developer Team
 * @notice The read side of the rate reference (#3713): the term average, the
 *         window a market-linked limit reads, the linked rate and the warning
 *         band, built only from the reference's averaged reads, its unusual
 *         state and its settings. Holds no state and writes nothing.
 * @dev    Split off {RateReference} so the cap and floor levels fit beside
 *         the series (#3337 part 2, levels ruling 6: the read side moves,
 *         never the levels). The reference deploys it in its constructor and
 *         keeps its address as `READS`, so there is one deployment and one
 *         registry pointer.
 */
contract RateReferenceReads is IRateReferenceReads {
    /// @inheritdoc IRateReferenceReads
    IRateReference public immutable override REFERENCE;

    /// @notice The term average's long half, and the longest window.
    uint256 public constant LONG_TERM_WINDOW = 90 days;
    /// @notice The 24-hour average.
    uint256 public constant DAY_WINDOW = 24 hours;
    /// @notice The month average.
    uint256 public constant MONTH_WINDOW = 30 days;
    /// @dev Rows of the term-average weight table.
    uint256 private constant ROWS = 5;
    /// @dev 1 basis point of annual rate at the 1e18 scale.
    uint256 private constant BPS = 1e14;

    constructor(IRateReference reference_) {
        REFERENCE = reference_;
    }

    /// @notice The weight on the 24-hour average for a term of `termDays`:
    ///         the table's rows at 7, 30, 90, 180 and 365 days, straight
    ///         lines between them, the first row below 7 days and the last
    ///         beyond 365.
    function weightBps(uint256 termDays) public view override returns (uint16) {
        uint16[5] memory w = REFERENCE.settings().weightsBps;
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

    /// @inheritdoc IRateReferenceReads
    function termAverage(address asset, uint256 termDays) public view override returns (IRateReference.TermAverage memory ta) {
        ta.weightBps = weightBps(termDays);
        bool ok24;
        (ok24, ta.average24h,) = REFERENCE.averaged(asset, DAY_WINDOW);
        if (ta.weightBps == 10_000) {
            ta.available = ok24;
            ta.rate1e18 = ok24 ? ta.average24h : 0;
            return ta;
        }
        // The 90-day average, or the longest available of 60 and 30 days.
        uint256[3] memory windows = [LONG_TERM_WINDOW, 60 days, MONTH_WINDOW];
        for (uint256 i; i < 3; ++i) {
            (bool ok, uint256 a,) = REFERENCE.averaged(asset, windows[i]);
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
    function windowForTerm(uint256 termDays) public view override returns (uint256) {
        IRateReference.Settings memory st = REFERENCE.settings();
        if (termDays <= 30) return st.shortWindow;
        if (termDays <= 365) return st.mediumWindow;
        return st.longWindow;
    }

    /// @inheritdoc IRateReferenceReads
    function linkedRate(address asset, uint256 termDays, IRateReference.LinkKind kind)
        external
        view
        override
        returns (uint256 rate1e18, IRateReference.LinkRefusal refusal)
    {
        bool available;
        if (kind == IRateReference.LinkKind.Reference) {
            (available, rate1e18,) = REFERENCE.averaged(asset, windowForTerm(termDays));
        } else if (kind == IRateReference.LinkKind.TermAverage) {
            IRateReference.TermAverage memory ta = termAverage(asset, termDays);
            (available, rate1e18) = (ta.available, ta.rate1e18);
        }
        if (!available) return (0, IRateReference.LinkRefusal.ReferenceUnavailable);
        if (termDays > 30) {
            IRateReference.Unusual u = unusual(asset);
            if (u == IRateReference.Unusual.Unusual) return (0, IRateReference.LinkRefusal.ReferenceUnusual);
            if (u == IRateReference.Unusual.NotKnown) return (0, IRateReference.LinkRefusal.ReferenceUnavailable);
        }
        return (rate1e18, IRateReference.LinkRefusal.None);
    }

    /// @inheritdoc IRateReferenceReads
    function band(address asset, uint256 termDays, uint256 rateBps) external view override returns (IRateReference.Band memory b) {
        IRateReference.TermAverage memory ta = termAverage(asset, termDays);
        if (!ta.available) return b;
        b.available = true;
        b.termAverage1e18 = ta.rate1e18;
        uint256 r = rateBps * BPS;
        uint256 avg = ta.rate1e18;
        uint256 dist = r > avg ? r - avg : avg - r;
        IRateReference.Settings memory st = REFERENCE.settings();
        b.distanceBps = dist / BPS;
        if (dist < uint256(st.bandMinDistanceBps) * BPS) return b;
        if (r > avg && r * 10_000 > avg * st.bandAboveBps) {
            b.outside = true;
            b.above = true;
        } else if (r < avg && r * 10_000 < avg * st.bandBelowBps) {
            b.outside = true;
        }
    }

    /// @inheritdoc IRateReferenceReads
    function unusual(address asset) public view override returns (IRateReference.Unusual) {
        (bool ok24, uint256 a24,) = REFERENCE.averaged(asset, DAY_WINDOW);
        (bool ok30, uint256 a30,) = REFERENCE.averaged(asset, MONTH_WINDOW);
        if (!ok24 || !ok30) return IRateReference.Unusual.NotKnown;
        uint256 d = a24 > a30 ? a24 - a30 : a30 - a24;
        return d > uint256(REFERENCE.settings().unusualDistanceBps) * BPS
            ? IRateReference.Unusual.Unusual
            : IRateReference.Unusual.Calm;
    }

    /// @inheritdoc IRateReferenceReads
    /// @dev Built from the reference's getters: the series' index and held
    ///      time carried to now at the reference in force, as the next
    ///      update would.
    function status(address asset) external view override returns (IRateReference.Status memory st) {
        uint32 id = REFERENCE.newestSeries(asset);
        if (id == 0) return st;
        IRateReference.Series memory s = REFERENCE.seriesOf(id);
        uint256 interval = REFERENCE.configOf(id).interval;
        uint256 limit = uint256(REFERENCE.settings().stalenessIntervals) * interval;
        uint256 dt = block.timestamp - s.lastUpdate;
        uint256 heldNow = s.holding ? dt : (dt > interval ? dt - interval : 0);
        st.seriesId = id;
        st.referenceRate = s.referenceRate;
        st.index = s.index + uint256(s.referenceRate) * dt;
        st.held = uint256(s.held) + heldNow;
        st.lastUpdate = s.lastUpdate;
        st.holding = s.holding;
        st.holdingSince = s.holdingSince;
        st.stale = dt > limit || (s.holding && block.timestamp - s.holdingSince > limit);
        st.unusual = unusual(asset);
    }
}
