/**
 * Rate Desk executed-rate chart (#1130 phase 2), per the §5.3
 * thin-market honesty rules — every one of them load-bearing:
 *
 *  1. Candles exist only where fills exist. The series gets the
 *     buckets the indexer returns plus { time }-only WHITESPACE slots
 *     for the empty buckets between them — gaps render as visible
 *     gaps instead of compressing away, and nothing is interpolated
 *     (whitespace carries no price).
 *  2. Below SPARSE_FILLS_THRESHOLD fills in the loaded range the chart
 *     drops to a step-line + per-fill markers ("sparse tape") — OHLC
 *     shapes drawn from a handful of prints would be theatre.
 *  3. The crosshair tooltip always shows the bucket's fill count +
 *     total principal, never bare OHLC.
 *  4. The book's quoted mid is a DASHED, labelled price line — a
 *     resting quote, visually never blended with executed rates.
 *  5. No 24h %-change ticker: the header shows "last fill: X.XX% ·
 *     age" from the newest bucket close (or the tape's newest fill
 *     when fresher — the candle response is 60 s-cached).
 *
 * This module imports `lightweight-charts` STATICALLY and is itself
 * loaded via React.lazy from Desk.tsx (default export) — the library
 * lands in this component's own chunk, so users who never open /desk
 * never download it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { LoaderCircle } from 'lucide-react';
import { copy } from '../../content/copy';
import { useTheme, type ResolvedTheme } from '../../app/ThemeContext';
import { UnavailableState } from '../EmptyState';
import { useDeskCandles, type DeskPair } from '../../data/desk';
import type {
  CandleInterval,
  CandleRange,
  IndexedLoan,
} from '../../data/indexer';
import {
  INTERVAL_SECONDS,
  chartEmptyKind,
  fillPointsFromTape,
  isSparseTape,
  newestPrint,
  totalFills,
  whitespaceBucketTimes,
} from '../../lib/rateChart';
import {
  formatBpsAsPercent,
  formatDate,
  formatTimeAgo,
  formatTokenAmount,
} from '../../lib/format';

const INTERVALS: CandleInterval[] = ['1h', '4h', '1d'];
const RANGES: CandleRange[] = ['7d', '30d', '90d', 'all'];

/** Default view = 1d buckets × 30d range — the HONEST default for a
 *  thin market (§5.3). 1h × 7d would slice a handful of weekly fills
 *  into near-empty hourly buckets: maximal fake granularity, minimal
 *  signal. A month of daily buckets shows the prints that actually
 *  happened at the coarsest interval the endpoint offers, and the
 *  sparse-tape mode still takes over when even that is thin. Fixed
 *  (not liquidity-adaptive) so two users always see the same chart. */
const DEFAULT_INTERVAL: CandleInterval = '1d';
const DEFAULT_RANGE: CandleRange = '30d';

/** Chart palette per resolved theme. Values mirror
 *  src/styles/tokens.css (--ok / --danger / --brand / --text-* /
 *  --border) — copied rather than read live from getComputedStyle
 *  because the chart effect can run before ThemeProvider's effect
 *  stamps the new data-theme on <html> in the same commit. Keep in
 *  sync with tokens.css when the palette changes. */
const PALETTE: Record<
  ResolvedTheme,
  {
    text: string;
    grid: string;
    up: string;
    down: string;
    executed: string;
    marker: string;
    quotedMid: string;
  }
> = {
  light: {
    text: '#6b7280',
    grid: 'rgba(228, 231, 236, 0.6)',
    up: '#067647',
    down: '#b42318',
    executed: '#374151',
    marker: '#4f46e5',
    quotedMid: '#6b7280',
  },
  dark: {
    text: '#98a2b3',
    grid: 'rgba(41, 48, 61, 0.6)',
    up: '#47cd89',
    down: '#f97066',
    executed: '#cdd5df',
    marker: '#818cf8',
    quotedMid: '#98a2b3',
  },
};

export default function RateChart({
  pair,
  days,
  decimals,
  symbol,
  quotedMidBps,
  tape,
}: {
  pair: DeskPair | null;
  days: number;
  /** Lending-asset metadata — formats principalTotal per contract. */
  decimals: number | undefined;
  symbol: string | undefined;
  /** The CURRENT ladder mid (quoted, not executed) — computed once in
   *  the page from the live book and passed down, so the header stat
   *  and the overlay can never disagree. */
  quotedMidBps: number | null;
  /** The market's tape (Desk.tsx already holds it for the TapePanel —
   *  passed down, never re-fetched), newest first, tri-state per the
   *  app contract. Feeds three things: the "last fill" freshness
   *  backstop (the candle response is 60 s-cached), sparse mode's
   *  per-fill markers, and the never-filled vs empty-range copy split. */
  tape: IndexedLoan[] | null | undefined;
}) {
  const [interval, setInterval] = useState<CandleInterval>(DEFAULT_INTERVAL);
  const [range, setRange] = useState<CandleRange>(DEFAULT_RANGE);
  const { resolved } = useTheme();
  const candles = useDeskCandles(pair, days, interval, range);
  const text = copy.desk.chart;

  const buckets = candles.data;
  const sparse = useMemo(
    () => (Array.isArray(buckets) ? isSparseTape(buckets) : false),
    [buckets],
  );
  const tapeNewest = useMemo(
    () =>
      Array.isArray(tape) && tape.length > 0
        ? { rateBps: tape[0].interestRateBps, at: tape[0].startAt }
        : null,
    [tape],
  );
  const lastPrint = useMemo(
    () => newestPrint(Array.isArray(buckets) ? buckets : [], tapeNewest),
    [buckets, tapeNewest],
  );
  /** Sparse mode's per-fill points from the tape (Codex #1139 round-1
   *  P2): with < 10 fills in range those fills are by definition the
   *  market's newest, so the tape rows cover them — one marker per
   *  actual print instead of one per bucket (which collapses
   *  same-bucket fills into a single point at the bucket close).
   *  `null` = tape unavailable or provably not covering the folded
   *  fills → the effect falls back to bucket markers. */
  const fillPoints = useMemo(
    () =>
      sparse && Array.isArray(buckets) && Array.isArray(tape)
        ? fillPointsFromTape(buckets, tape, INTERVAL_SECONDS[interval])
        : null,
    [sparse, buckets, tape, interval],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !Array.isArray(buckets) || buckets.length === 0) return;

    const colors = PALETTE[resolved];
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: colors.text,
        attributionLogo: false, // we render the visible text credit below
        fontSize: 11,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: interval !== '1d',
        secondsVisible: false,
      },
      localization: {
        priceFormatter: (p: number) => `${p.toFixed(2)}%`,
      },
    });

    // Rates plot in percent (bps / 100) so the axis reads like the
    // rest of the desk.
    const priceFormat = {
      type: 'custom' as const,
      formatter: (p: number) => `${p.toFixed(2)}%`,
      minMove: 0.01,
    };

    let series: ISeriesApi<'Line'> | ISeriesApi<'Candlestick'>;
    if (sparse) {
      // §5.3 rule 2 — step-line + markers, two data sources:
      //
      //  - Tape-backed (fillPoints ≠ null): one point per ACTUAL fill
      //    at its exact time (Codex #1139 round-1 P2 — bucket points
      //    collapse same-bucket prints into one marker at the bucket
      //    close, hiding intra-bucket fills). Same-second collisions
      //    still collapse — two points can't share an x — but keep
      //    their ×N count visible.
      //  - Bucket fallback (tape unavailable or provably not covering
      //    the folded fills): the pre-#1139 shape — one point per
      //    bucket at the bucket close, with the ×N count marking every
      //    collapsed multi-fill bucket. TRADEOFF, on purpose: markers
      //    are drawn only from data we actually hold — a bucket close
      //    is real, an interpolated intra-bucket position would be
      //    fabricated. The ×N text is what keeps the collapse honest.
      const points = fillPoints ?? buckets;
      const line = chart.addSeries(LineSeries, {
        color: colors.executed,
        lineWidth: 2,
        lineType: LineType.WithSteps,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat,
      });
      // §5.3 rule 1 — gaps stay gaps (Codex #1139 round-3): whitespace
      // ({ time }-only, NO price — not interpolation) at every empty
      // bucket-grid slot between the first and last print, so quiet
      // stretches render as visible empty space instead of the fills
      // compressing together. Works for both point sources: exact fill
      // times (tape-backed) are folded onto the grid inside the helper.
      line.setData(
        [
          ...points.map((p) => ({
            time: p.t as UTCTimestamp,
            value: ('close' in p ? p.close : p.rateBps) / 100,
          })),
          ...whitespaceBucketTimes(
            points.map((p) => p.t),
            INTERVAL_SECONDS[interval],
          ).map((t) => ({ time: t as UTCTimestamp })),
        ].sort((a, b) => (a.time as number) - (b.time as number)),
      );
      createSeriesMarkers(
        line,
        points.map((p) => ({
          time: p.t as Time,
          position: 'inBar' as const,
          shape: 'circle' as const,
          color: colors.marker,
          size: 1,
          text: p.fills > 1 ? `×${p.fills}` : undefined,
        })),
      );
      series = line;
    } else {
      series = chart.addSeries(CandlestickSeries, {
        upColor: colors.up,
        downColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        borderVisible: false,
        priceLineVisible: false,
        priceFormat,
      });
      // §5.3 rule 1 (Codex #1139 round-3) — same whitespace treatment
      // as the sparse branch: empty buckets between the first and last
      // fill become { time }-only slots, so a candle-free day renders
      // as a visible gap rather than adjacent candles. No prices are
      // synthesized — whitespace is a time-scale slot, nothing more.
      series.setData(
        [
          ...buckets.map((b) => ({
            time: b.t as UTCTimestamp,
            open: b.open / 100,
            high: b.high / 100,
            low: b.low / 100,
            close: b.close / 100,
          })),
          ...whitespaceBucketTimes(
            buckets.map((b) => b.t),
            INTERVAL_SECONDS[interval],
          ).map((t) => ({ time: t as UTCTimestamp })),
        ].sort((a, b) => (a.time as number) - (b.time as number)),
      );
    }

    // §5.3 rule 4 — the quoted mid is a DASHED labelled line: clearly
    // a resting quote, never blended with the executed series.
    if (quotedMidBps !== null) {
      series.createPriceLine({
        price: quotedMidBps / 100,
        color: colors.quotedMid,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: text.quotedMid,
      });
    }

    chart.timeScale().fitContent();

    // §5.3 rule 3 — crosshair tooltip with the point's fill count +
    // total principal (formatted with the lending asset's metadata).
    // Keyed on whatever the series actually plots: exact fill times in
    // tape-backed sparse mode, bucket starts otherwise.
    const tipRows =
      sparse && fillPoints !== null
        ? fillPoints.map((p) => ({
            t: p.t,
            rateLine: formatBpsAsPercent(p.rateBps),
            fills: p.fills,
            principalTotal: p.principalTotal,
          }))
        : buckets.map((b) => ({
            t: b.t,
            rateLine: sparse
              ? formatBpsAsPercent(b.close)
              : `O ${formatBpsAsPercent(b.open)} · H ${formatBpsAsPercent(b.high)} · L ${formatBpsAsPercent(b.low)} · C ${formatBpsAsPercent(b.close)}`,
            fills: b.fills,
            principalTotal: b.principalTotal,
          }));
    const byTime = new Map(tipRows.map((r) => [r.t, r]));
    const onCrosshair = (param: MouseEventParams) => {
      const tip = tooltipRef.current;
      if (!tip) return;
      const t = typeof param.time === 'number' ? param.time : null;
      const b = t !== null ? byTime.get(t) : undefined;
      if (!b || !param.point) {
        tip.style.display = 'none';
        return;
      }
      const principal =
        decimals !== undefined
          ? `${formatTokenAmount(b.principalTotal, decimals)}${symbol ? ` ${symbol}` : ''}`
          : '…';
      tip.textContent = [
        b.rateLine,
        `${text.tooltipFills(b.fills)} · ${principal}`,
        formatDate(b.t),
      ].join('\n');
      tip.style.display = 'block';
      const pad = 12;
      const w = tip.offsetWidth;
      let left = param.point.x + pad;
      if (left + w > el.clientWidth - 4) left = param.point.x - w - pad;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, Math.min(param.point.y + pad, el.clientHeight - tip.offsetHeight - 4))}px`;
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
    };
    // Rebuilding the whole chart per change is deliberate: the data is
    // thin by definition (§5.3) and a rebuild is cheaper to reason
    // about than mutating series/theme/marker state in place.
  }, [
    buckets,
    sparse,
    fillPoints,
    resolved,
    quotedMidBps,
    decimals,
    symbol,
    interval,
    text,
  ]);

  return (
    <div className="card desk-chart-card">
      <div className="desk-chart-head">
        <div>
          <h2 className="card-title" style={{ marginBottom: 2 }}>
            {text.title}
          </h2>
          {/* §5.3 rule 5 — last executed print, never a %-change ticker. */}
          <p className="muted desk-chart-lastfill">
            {lastPrint
              ? text.lastFill(
                  formatBpsAsPercent(lastPrint.rateBps),
                  formatTimeAgo(lastPrint.at),
                )
              : text.lastFillNone}
          </p>
        </div>
        <div className="desk-chart-controls">
          <div
            className="desk-chips"
            role="group"
            aria-label={text.intervalLabel}
          >
            {INTERVALS.map((i) => (
              <button
                key={i}
                type="button"
                className={`desk-chip${i === interval ? ' active' : ''}`}
                onClick={() => setInterval(i)}
              >
                {i}
              </button>
            ))}
          </div>
          <div className="desk-chips" role="group" aria-label={text.rangeLabel}>
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={`desk-chip${r === range ? ' active' : ''}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {pair === null ? (
        <p className="muted">{copy.desk.pickPair}</p>
      ) : candles.isLoading ? (
        <p className="muted cluster" style={{ alignItems: 'center', gap: 6 }}>
          <LoaderCircle size={14} className="spin" aria-hidden /> {text.loading}
        </p>
      ) : buckets === null || buckets === undefined ? (
        <div>
          <UnavailableState body={text.unavailable} />
          <p style={{ textAlign: 'center', marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void candles.refetch()}
            >
              {text.retry}
            </button>
          </p>
        </div>
      ) : buckets.length === 0 ? (
        // "Never filled" vs "empty in this range" (Codex #1139 round-1
        // P3, tightened round 4): the market copy is only claimable
        // when the evidence covers the whole history AND the tape holds
        // no fill (candle-cache skew) — see chartEmptyKind.
        <p className="muted">
          {chartEmptyKind(range, tape) === 'market'
            ? text.empty
            : text.emptyRange}
        </p>
      ) : (
        <>
          {sparse ? (
            <p className="muted desk-chart-sparse-note">
              {text.sparseNote(totalFills(buckets))}
            </p>
          ) : null}
          <div className="desk-chart-plot">
            <div ref={containerRef} className="desk-chart-canvas" />
            <div ref={tooltipRef} className="desk-chart-tooltip" />
          </div>
          {quotedMidBps !== null ? (
            <p className="muted desk-chart-midhint">{text.quotedMidHint}</p>
          ) : null}
        </>
      )}

      {/* Apache-2.0 NOTICE for lightweight-charts (per the design doc). */}
      <p className="desk-chart-attribution">
        <a
          href="https://www.tradingview.com/lightweight-charts/"
          target="_blank"
          rel="noreferrer"
        >
          {text.attribution}
        </a>
      </p>
    </div>
  );
}
