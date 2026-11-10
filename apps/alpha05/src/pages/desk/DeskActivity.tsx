import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import type { CopyAccess, CopyKey } from '../../shared/copy/useCopy';
import { ownOrders, type DeskLadder, type Market } from '../../shared/desk/markets';
import { CHART_PERIODS, PERIOD_STEP, parsePeriod, readCandles, readTape, runs, type Candle, type ChartPeriod } from '../../shared/desk/tape';
import { BOOK_POLL_MS, indexReason } from '../../shared/offers/OfferBook';
import { worldKey } from '../../shared/reads/identityKey';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import type { Unplaced } from '../../shared/reads/world/unplaced';
import { formatBps, formatSpan, formatUtc, formatUtcDate } from '../../shared/ui/format';

type Hex = `0x${string}`;
type MarketTerms = Pick<Market, 'lending' | 'collateral' | 'durationDays'>;

const PERIOD_LABEL: Readonly<Record<ChartPeriod, CopyKey>> = {
  '7d': 'desk.period7d',
  '30d': 'desk.period30d',
  '90d': 'desk.period90d',
  all: 'desk.periodAll',
};

function unplacedLine(u: Unplaced, format: CopyAccess['format']): string | null {
  if (u.count === 0) return null;
  return format(u.capped ? 'desk.unplacedCapped' : 'desk.unplaced', { count: String(u.count) });
}

/**
 * OFF-75 below a market's ladder: the viewer's own offers on it with how
 * much of each was taken, the market's recent loans (the fills tape) and the
 * rates loans were agreed at over time (the executed-rate chart), all from
 * the index (the world rail, RB-RAILS). A fill is a loan's terms as agreed
 * when it opened; the index's count of loans on the pair it could place in
 * no market is stated beside both views (RB-DESK-TAPE). A failed read is a
 * degraded-source warning, never an empty tape or chart.
 */
export function DeskActivity({
  market,
  marketLabel,
  ladder,
  viewer,
  meta,
  nowSec,
  copy,
}: {
  market: MarketTerms;
  marketLabel: string;
  ladder: DeskLadder | null;
  viewer: Hex | null;
  meta: TokenMetaMap | null;
  nowSec: number;
  copy: CopyAccess;
}) {
  return (
    <>
      {viewer !== null && ladder !== null && <OwnOrdersView ladder={ladder} viewer={viewer} market={market} meta={meta} copy={copy} />}
      <TapeView market={market} meta={meta} nowSec={nowSec} copy={copy} />
      <ChartView market={market} marketLabel={marketLabel} middleTenthBps={ladder?.middleTenthBps ?? null} meta={meta} nowSec={nowSec} copy={copy} />
    </>
  );
}

function OwnOrdersView({
  ladder,
  viewer,
  market,
  meta,
  copy,
}: {
  ladder: DeskLadder;
  viewer: Hex;
  market: MarketTerms;
  meta: TokenMetaMap | null;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const orders = ownOrders(ladder, viewer);
  const amount = (v: bigint) => tokenAmount(v, market.lending, meta, format);
  return (
    <section className="home-section" aria-labelledby="desk-orders-title" data-testid="desk-orders">
      <h2 id="desk-orders-title">{text('desk.ordersTitle')}</h2>
      {orders.length === 0 ? (
        <p className="tier-b" data-testid="desk-orders-none">
          {text('desk.ordersNone')}
        </p>
      ) : (
        <>
          <p className="tier-a">{text('desk.ordersLead')}</p>
          <ul className="rows">
            {orders.map((o) => {
              const id = o.id.toString();
              return (
                <li key={id} className="card" data-testid="desk-order" data-offer-id={id} data-taken={o.taken.toString()} data-open={o.open.toString()}>
                  <p className="row-head">
                    <Link to={`/offers/${id}`}>{format(o.lender ? 'desk.orderLend' : 'desk.orderBorrow', { id, rate: formatBps(o.rateBps) })}</Link>
                  </p>
                  <p className="tier-b">
                    {o.taken === 0n
                      ? format('desk.orderNoneTaken', { open: amount(o.open) })
                      : format('desk.orderTaken', { taken: amount(o.taken), total: amount(o.total), open: amount(o.open) })}
                  </p>
                  <progress
                    className="order-progress"
                    max={Number(o.total > 0n ? 10_000n : 1n)}
                    value={o.total > 0n ? Number((o.taken * 10_000n) / o.total) : 0}
                    aria-hidden="true"
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function TapeView({ market, meta, nowSec, copy }: { market: MarketTerms; meta: TokenMetaMap | null; nowSec: number; copy: CopyAccess }) {
  const { text, format } = copy;
  const world = useWorldRail();
  const noIndex = world.indexer.origin === null;
  const key = `${market.lending}-${market.collateral}-${market.durationDays}`.toLowerCase();
  const tape = useQuery({
    queryKey: worldKey(world.chainId, 'deskTape', key),
    queryFn: () => readTape(world.indexer, world.chainId, market),
    enabled: !noIndex,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const failed = noIndex || tape.status === 'error';
  const reason = noIndex ? text('offerBook.noIndex') : indexReason(tape.error, text);
  const ago = (t: number) => formatSpan(nowSec - t);
  const data = tape.data;
  const last = data?.fills[0];
  const unplaced = data ? unplacedLine(data.unplaced, format) : null;
  return (
    <section className="home-section" aria-labelledby="desk-tape-title" data-testid="desk-tape">
      <h2 id="desk-tape-title">{text('desk.tapeTitle')}</h2>
      <p className="tier-b">{text('desk.tapeLead')}</p>
      {failed && (
        <p className="tier-a" data-testid="desk-tape-failed">
          {format(data ? 'desk.tapeFailedCached' : 'desk.tapeFailed', { reason })}
        </p>
      )}
      {!failed && data === undefined && <p className="tier-b">{text('desk.tapeReading')}</p>}
      {data !== undefined && (
        <>
          {last ? (
            <p className="tier-b" data-testid="desk-tape-last" data-rate={last.rateBps.toString()}>
              {format('desk.tapeLast', { rate: formatBps(last.rateBps), age: ago(last.startAt) })}
            </p>
          ) : (
            data.unread === 0 && (
              <p className="tier-b home-empty" data-testid="desk-tape-none">
                {text('desk.tapeNone')}
              </p>
            )
          )}
          {unplaced !== null && (
            <p className="tier-a" data-testid="desk-unplaced">
              {unplaced}
            </p>
          )}
          {data.unread > 0 && <p className="tier-a">{format('desk.tapeUnread', { count: String(data.unread) })}</p>}
          {data.fills.length > 0 && (
            <ol className="tape-rows">
              {data.fills.map((f) => {
                const id = f.loanId.toString();
                const rate = formatBps(f.rateBps);
                return (
                  <li key={id} data-testid="desk-fill" data-loan-id={id} data-rate={f.rateBps.toString()}>
                    <Link to={`/positions/${id}`}>
                      {f.principal === null
                        ? format('desk.tapeRowNoAmount', { id, rate, age: ago(f.startAt) })
                        : format('desk.tapeRow', { id, rate, amount: tokenAmount(f.principal, market.lending, meta, format), age: ago(f.startAt) })}
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
          {data.more && <p className="tier-a">{format('desk.tapeMore', { count: String(data.fills.length) })}</p>}
        </>
      )}
    </section>
  );
}

/** Measures an element's width as it changes. */
function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}

/** Rate ticks in basis points: the smallest round step that gives at most
 *  four ticks across the range. */
function rateTicks(lo: number, hi: number): number[] {
  const steps = [5, 10, 25, 50, 100, 200, 250, 500, 1_000, 2_500, 5_000];
  const step = steps.find((s) => (hi - lo) / s <= 4) ?? 10_000;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

const PCT = (bps: number | bigint) => formatBps(BigInt(bps));

function ChartView({
  market,
  marketLabel,
  middleTenthBps,
  meta,
  nowSec,
  copy,
}: {
  market: MarketTerms;
  marketLabel: string;
  middleTenthBps: bigint | null;
  meta: TokenMetaMap | null;
  nowSec: number;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const world = useWorldRail();
  const [params, setParams] = useSearchParams();
  const period = parsePeriod(params.get('period'));
  const noIndex = world.indexer.origin === null;
  const key = `${market.lending}-${market.collateral}-${market.durationDays}`.toLowerCase();
  const series = useQuery({
    queryKey: worldKey(world.chainId, 'deskCandles', key, period),
    queryFn: () => readCandles(world.indexer, world.chainId, market, period),
    enabled: !noIndex,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const failed = noIndex || series.status === 'error';
  const reason = noIndex ? text('offerBook.noIndex') : indexReason(series.error, text);
  const data = series.data;
  const choose = (p: ChartPeriod) => {
    const next = new URLSearchParams(params);
    next.set('period', p);
    setParams(next, { replace: true });
  };
  const unplaced = data ? unplacedLine(data.unplaced, format) : null;
  const amount = (v: bigint) => tokenAmount(v, market.lending, meta, format);
  return (
    <section className="home-section" aria-labelledby="desk-chart-title" data-testid="desk-chart" data-period={period}>
      <h2 id="desk-chart-title">{text('desk.chartTitle')}</h2>
      <p className="tier-b">{text('desk.chartLead')}</p>
      <div className="segment chart-periods" role="group" aria-label={text('desk.chartPeriod')}>
        {CHART_PERIODS.map((p) => (
          <button key={p} type="button" aria-pressed={p === period} onClick={() => choose(p)} data-testid={`desk-period-${p}`}>
            {text(PERIOD_LABEL[p])}
          </button>
        ))}
      </div>
      {failed && (
        <p className="tier-a" data-testid="desk-chart-failed">
          {format(data ? 'desk.chartFailedCached' : 'desk.chartFailed', { reason })}
        </p>
      )}
      {!failed && data === undefined && <p className="tier-b">{text('desk.chartReading')}</p>}
      {data !== undefined && (
        <>
          {data.truncated && <p className="tier-a">{text('desk.chartTruncated')}</p>}
          {data.unread > 0 && <p className="tier-a">{format('desk.chartUnread', { count: String(data.unread) })}</p>}
          {unplaced !== null && <p className="tier-a">{unplaced}</p>}
          {data.candles.length === 0 ? (
            data.unread === 0 && (
              <p className="tier-b home-empty" data-testid="desk-chart-none">
                {text('desk.chartNone')}
              </p>
            )
          ) : (
            <>
              <RateChart
                candles={data.candles}
                stepSec={data.stepSec}
                periodDays={PERIOD_STEP[period].days}
                middleTenthBps={middleTenthBps}
                nowSec={nowSec}
                label={format('desk.chartLabel', { market: marketLabel, count: String(data.candles.length) })}
                amount={amount}
                copy={copy}
              />
              <details className="chart-table" data-testid="desk-chart-table">
                <summary>{text('desk.chartTable')}</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{text('desk.colStart')}</th>
                        <th scope="col">{text('desk.colLoans')}</th>
                        <th scope="col">{text('desk.colFirst')}</th>
                        <th scope="col">{text('desk.colHigh')}</th>
                        <th scope="col">{text('desk.colLow')}</th>
                        <th scope="col">{text('desk.colLast')}</th>
                        <th scope="col">{text('desk.colAmount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.candles].reverse().map((c) => (
                        <tr key={c.t} data-testid="desk-candle-row" data-t={c.t} data-close={c.close.toString()} data-fills={c.fills}>
                          <th scope="row">{formatUtc(c.t)}</th>
                          <td>{c.fills}</td>
                          <td>{PCT(c.open)}%</td>
                          <td>{PCT(c.high)}%</td>
                          <td>{PCT(c.low)}%</td>
                          <td>{PCT(c.close)}%</td>
                          <td>
                            {amount(c.principalTotal)}
                            {c.unrecorded > 0 && ` (${format('desk.chartTipUnrecorded', { count: String(c.unrecorded) })})`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

const CHART_H = 200;
const PAD = { left: 44, right: 12, top: 12, bottom: 22 };

/**
 * The executed-rate chart: one stepped line of each period's last agreed
 * rate, joined only across periods that follow one another, so a period
 * with no loan is a gap and never interpolated; a shaded bar spans each
 * period's low to high; the ladder's middle rate now, when there is one, is
 * a labelled dashed reference. No change figure is shown. Hover or focus on
 * a period shows its figures; the table beside it holds every figure.
 */
function RateChart({
  candles,
  stepSec,
  periodDays,
  middleTenthBps,
  nowSec,
  label,
  amount,
  copy,
}: {
  candles: Candle[];
  stepSec: number;
  periodDays: number | null;
  middleTenthBps: bigint | null;
  nowSec: number;
  label: string;
  amount: (v: bigint) => string;
  copy: CopyAccess;
}) {
  const { format } = copy;
  const [boxRef, width] = useWidth<HTMLDivElement>(320);
  // The active period is held by its start time, not its position, so a
  // refresh that drops or adds a period never points at the wrong one.
  const [activeT, setActiveT] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [tipW, setTipW] = useState(170);
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const x1 = Math.max(Math.floor(nowSec), last.t + stepSec);
  const x0 = periodDays === null ? Math.min(first.t, x1 - stepSec) : Math.min(first.t, x1 - periodDays * 86_400);
  const middle = middleTenthBps === null ? null : Number(middleTenthBps) / 10;
  const values = candles.flatMap((c) => [Number(c.low), Number(c.high)]).concat(middle === null ? [] : [middle]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.15, 25);
  const y0 = Math.max(0, lo - pad);
  const y1 = hi + pad;
  const plotW = Math.max(width - PAD.left - PAD.right, 40);
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - x0) / Math.max(x1 - x0, 1)) * plotW;
  const y = (bps: number) => PAD.top + (1 - (bps - y0) / Math.max(y1 - y0, 1)) * plotH;
  const ticks = rateTicks(y0, y1);
  const paths = runs(candles, stepSec).map((run) => {
    let d = '';
    for (const c of run) {
      const yc = y(Number(c.close));
      d += d === '' ? `M${x(c.t)},${yc}` : `V${yc}`;
      d += `H${x(c.t + stepSec)}`;
    }
    return d;
  });
  const narrow = x(first.t + stepSec) - x(first.t) < 8;
  const tip = activeT === null ? null : (candles.find((c) => c.t === activeT) ?? null);
  // The tip sits inside the plot beside the crosshair, on the side with more
  // room, so it never covers the controls above the chart; it is then kept
  // within the chart's width, measured, so a narrow phone never cuts it off.
  const tipX = tip === null ? 0 : x(tip.t + stepSec / 2);
  const wanted = tipX > width / 2 ? tipX - 12 - tipW : tipX + 12;
  const tipStyle = { left: Math.max(0, Math.min(wanted, width - tipW)), top: PAD.top };
  useLayoutEffect(() => {
    const w = tipRef.current?.offsetWidth;
    if (w !== undefined && w > 0 && w !== tipW) setTipW(w);
  }, [tip, width, tipW]);
  return (
    <div className="rate-chart" ref={boxRef} data-testid="desk-rate-chart">
      <svg width={width} height={CHART_H} role="img" aria-label={label}>
        {ticks.map((v) => (
          <g key={v} className="chart-grid">
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
            <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
              {PCT(v)}%
            </text>
          </g>
        ))}
        <text className="chart-axis" x={PAD.left} y={CHART_H - 6}>
          {formatUtcDate(x0)}
        </text>
        <text className="chart-axis" x={PAD.left + plotW} y={CHART_H - 6} textAnchor="end">
          {formatUtcDate(x1)}
        </text>
        {candles.map((c) =>
          c.high > c.low ? (
            <rect
              key={`r${c.t}`}
              className="chart-range"
              x={x(c.t)}
              width={Math.max(x(c.t + stepSec) - x(c.t), 2)}
              y={y(Number(c.high))}
              height={y(Number(c.low)) - y(Number(c.high))}
              rx={1}
            />
          ) : null,
        )}
        {middle !== null && (
          <g className="chart-middle" data-testid="desk-chart-middle">
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(middle)} y2={y(middle)} />
            <text x={PAD.left + plotW} y={y(middle) - 4} textAnchor="end">
              {format('desk.chartMiddle', { rate: formatUnits(middleTenthBps!, 3) })}
            </text>
          </g>
        )}
        {paths.map((d, i) => (
          <path key={i} className="chart-line" d={d} data-testid="desk-chart-run" />
        ))}
        {narrow && candles.map((c) => <circle key={`d${c.t}`} className="chart-dot" cx={x(c.t + stepSec / 2)} cy={y(Number(c.close))} r={4} />)}
        {tip !== null && <line className="chart-cross" x1={x(tip.t + stepSec / 2)} x2={x(tip.t + stepSec / 2)} y1={PAD.top} y2={PAD.top + plotH} />}
        {candles.map((c) => {
          const w = Math.max(x(c.t + stepSec) - x(c.t), 14);
          return (
            <rect
              key={`h${c.t}`}
              className="chart-hit"
              x={x(c.t + stepSec / 2) - w / 2}
              width={w}
              y={PAD.top}
              height={plotH}
              tabIndex={0}
              aria-label={`${formatUtc(c.t)}: ${PCT(c.close)}%`}
              onMouseEnter={() => setActiveT(c.t)}
              onMouseLeave={() => setActiveT(null)}
              onFocus={() => setActiveT(c.t)}
              onBlur={() => setActiveT(null)}
              data-testid="desk-chart-period"
            />
          );
        })}
      </svg>
      {tip !== null && (
        <div className="chart-tip" ref={tipRef} style={tipStyle} data-testid="desk-chart-tip" role="status">
          <p>{format('desk.chartTipWhen', { when: formatUtc(tip.t), span: formatSpan(stepSec) })}</p>
          <p>{format('desk.chartTipRates', { open: PCT(tip.open), high: PCT(tip.high), low: PCT(tip.low), close: PCT(tip.close) })}</p>
          <p>{format('desk.chartTipFills', { count: String(tip.fills) })}</p>
          <p>{format('desk.chartTipAmount', { amount: amount(tip.principalTotal) })}</p>
          {tip.unrecorded > 0 && <p>{format('desk.chartTipUnrecorded', { count: String(tip.unrecorded) })}</p>}
        </div>
      )}
    </div>
  );
}
