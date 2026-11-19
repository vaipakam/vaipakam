/**
 * #3751 — the public rate curve: the hourly pass that writes its daily
 * history, and the two public reads.
 *
 *   GET /rates/curve?chainId=&asset=0x..
 *   GET /rates/curve/history?chainId=&asset=0x..&days=30&range=90d|365d
 *
 * Each response carries TWO halves, labelled apart and never blended:
 *
 *   reference  the outside-source term average the rate reference reports
 *              (`termAverage(asset, term)`, TermAverageAndLinkGuardsDesign.md
 *              §6.2). That view is not built on any deployment yet, so the
 *              half says `not-published` and carries no figure. When the view
 *              exists the pass reads it here; the response shape does not
 *              change.
 *   ownLoans   the platform's own loans, whatever their status, under the §8 rule
 *              (`rateCurve.ts`), with every setting it was built under.
 *
 * Every figure is an observed average of what happened, never advice, a
 * forecast or an offer; `notice` says so, and the page repeats it.
 *
 * The reads are public and keyless, behind a per-IP budget
 * (`RATE_CURVE_RATELIMIT`, fails closed like every limiter here) and a
 * short cache. They read only the stored daily rows, so a request costs one
 * D1 query whatever the asset's history.
 */
import { type Env } from './env';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { slotRefusalStatus, takeCallerSlot } from '@vaipakam/lib/rateLimit';
import { chainNotServed, requestedChainId } from './servedChain';
import {
  CURVE_TERMS,
  MAX_LOOKBACK_DAYS,
  OWN_LOANS_RULE,
  PAID_INTEREST_SOURCES,
  TERM_RANGES,
  lookbackDays,
  ownLoansCurve,
  type CurveLoanRow,
  type CurveTerm,
  type OwnTermFigure,
} from './rateCurve';
import { interestPaidByLoan, type LoanInterestRow } from './loanInterest';

const DAY = 86_400;

/** What the pass writes per run: today and yesterday always (yesterday at
 *  its own end, so the day's final figure replaces the last hourly one),
 *  and up to this many missing earlier days, newest first. */
export const BACKFILL_DAYS_PER_RUN = 7;
/** How far back the pass fills history. */
export const HISTORY_DAYS = 365;
/** Row caps on the pass's two scans. Past a cap the oldest rows are the
 *  ones left out, and the points whose look-back reaches them are withheld
 *  as `history-incomplete` rather than computed from part of it. */
export const LOAN_SCAN_CAP = 20_000;
export const EVENT_SCAN_CAP = 40_000;

/** The pass's D1 statements per chain: existing days, loans, events, the
 *  one write. */
export const RATE_CURVE_D1_PER_CHAIN = 4;

/** The reference half's state until the term-average view exists. */
export const REFERENCE_NOT_PUBLISHED = 'not-published';

/** The sentence-free notice key every response carries; the page renders
 *  it as "observed averages, not advice, a forecast or an offer". */
export const CURVE_NOTICE = 'observed-averages-not-advice-forecast-or-offer';

interface CurveRow {
  asset: string;
  term_days: number;
  day: number;
  own_state: string;
  own_reason: string | null;
  own_p25_bps: number | null;
  own_median_bps: number | null;
  own_p75_bps: number | null;
  own_loans: number;
  own_lenders: number;
  own_borrowers: number;
  own_unconfirmed: number;
  ref_state: string;
  ref_value_bps: number | null;
  ref_a24_bps: number | null;
  ref_a90_bps: number | null;
  ref_weight_bps: number | null;
  computed_at: number;
}

/** The days one run computes, as (day number, as-of seconds). */
export function daysToCompute(now: number, existing: Set<number>): { day: number; asOf: number }[] {
  const today = Math.floor(now / DAY);
  const out = [
    { day: today, asOf: now },
    { day: today - 1, asOf: today * DAY - 1 },
  ];
  let added = 0;
  for (let d = today - 2; d > today - HISTORY_DAYS && added < BACKFILL_DAYS_PER_RUN; d--) {
    if (!existing.has(d)) {
      out.push({ day: d, asOf: (d + 1) * DAY - 1 });
      added++;
    }
  }
  return out;
}

interface LoanScanRow extends CurveLoanRow {
  lending_asset: string;
}

/**
 * Recompute the curve's daily rows for one chain. Four D1 statements; the
 * write is ONE statement whatever the row count (`json_each` over a bound
 * JSON array), so the pass's cost does not grow with assets or days.
 */
export async function refreshRateCurveForChain(
  db: D1Database,
  chainId: number,
  now: number,
): Promise<{ rows: number; days: number }> {
  const today = Math.floor(now / DAY);
  const existingRes = await db
    .prepare('SELECT DISTINCT day FROM rate_curve_daily WHERE chain_id = ? AND day > ?')
    .bind(chainId, today - HISTORY_DAYS)
    .all<{ day: number }>();
  const existing = new Set((existingRes.results ?? []).map((r) => r.day));
  const days = daysToCompute(now, existing);
  const earliestAsOf = Math.min(...days.map((d) => d.asOf));
  const since = earliestAsOf - MAX_LOOKBACK_DAYS * DAY;

  // Market fills only, the same row scope the candles use: ERC-20 legs, no
  // lender-sale vehicle. Placement and status are judged per loan in
  // `loanWeight`, so a loan's history counts on the days it qualified.
  const loanRes = await db
    .prepare(
      `SELECT loan_id, lender, borrower, status, start_at, terminal_at,
              init_rate_bps, init_duration_days, init_terms_unbacked, duration_days, lending_asset
         FROM loans
        WHERE chain_id = ? AND start_at >= ? AND is_sale_vehicle = 0
          AND asset_type = 0 AND collateral_asset_type = 0
        ORDER BY start_at DESC, loan_id DESC
        LIMIT ?`,
    )
    .bind(chainId, since, LOAN_SCAN_CAP + 1)
    .all<LoanScanRow>();
  let loans = loanRes.results ?? [];
  let coveredFrom = Number.NEGATIVE_INFINITY;
  if (loans.length > LOAN_SCAN_CAP) {
    loans = loans.slice(0, LOAN_SCAN_CAP);
    coveredFrom = loans[loans.length - 1].start_at;
  }

  const eventRes = await db
    .prepare(
      `SELECT loan_id, kind, gross, block_at
         FROM loan_interest_events
        WHERE chain_id = ? AND block_at >= ?
        ORDER BY block_number DESC, log_index DESC
        LIMIT ?`,
    )
    .bind(chainId, since, EVENT_SCAN_CAP + 1)
    .all<LoanInterestRow>();
  let events = eventRes.results ?? [];
  if (events.length > EVENT_SCAN_CAP) {
    events = events.slice(0, EVENT_SCAN_CAP);
    // A payment always follows its loan's start, so a loan that started
    // after the oldest retained payment has every payment in the scan.
    const oldest = events[events.length - 1].block_at ?? Number.POSITIVE_INFINITY;
    coveredFrom = Math.max(coveredFrom, oldest);
  }

  const byAsset = new Map<string, LoanScanRow[]>();
  for (const l of loans) {
    const a = l.lending_asset.toLowerCase();
    const list = byAsset.get(a) ?? [];
    list.push(l);
    byAsset.set(a, list);
  }

  const rows: unknown[] = [];
  for (const { day, asOf } of days) {
    const paid = interestPaidByLoan(events, asOf);
    for (const [asset, assetLoans] of byAsset) {
      for (const f of ownLoansCurve(assetLoans, paid, asOf, coveredFrom)) {
        rows.push(curveRowJson(chainId, asset, day, f, now));
      }
    }
  }
  if (rows.length === 0) return { rows: 0, days: days.length };

  await db
    .prepare(
      `INSERT INTO rate_curve_daily
         (chain_id, asset, term_days, day, own_state, own_reason,
          own_p25_bps, own_median_bps, own_p75_bps,
          own_loans, own_lenders, own_borrowers, own_unconfirmed, ref_state, computed_at)
       SELECT json_extract(value, '$.c'), json_extract(value, '$.a'),
              json_extract(value, '$.t'), json_extract(value, '$.d'),
              json_extract(value, '$.s'), json_extract(value, '$.r'),
              json_extract(value, '$.p25'), json_extract(value, '$.p50'),
              json_extract(value, '$.p75'), json_extract(value, '$.n'),
              json_extract(value, '$.l'), json_extract(value, '$.b'),
              json_extract(value, '$.u'),
              json_extract(value, '$.rs'), json_extract(value, '$.at')
         FROM json_each(?)
        -- WHERE true: SQLite reads ON CONFLICT after a bare SELECT's FROM
        -- as a join constraint; the WHERE ends the SELECT (its documented
        -- parsing-ambiguity rule for upserts).
        WHERE true
       ON CONFLICT (chain_id, asset, term_days, day) DO UPDATE SET
         own_state = excluded.own_state, own_reason = excluded.own_reason,
         own_p25_bps = excluded.own_p25_bps, own_median_bps = excluded.own_median_bps,
         own_p75_bps = excluded.own_p75_bps, own_loans = excluded.own_loans,
         own_lenders = excluded.own_lenders, own_borrowers = excluded.own_borrowers,
         own_unconfirmed = excluded.own_unconfirmed,
         ref_state = excluded.ref_state, computed_at = excluded.computed_at`,
    )
    .bind(JSON.stringify(rows))
    .run();
  return { rows: rows.length, days: days.length };
}

function curveRowJson(chainId: number, asset: string, day: number, f: OwnTermFigure, now: number) {
  return {
    c: chainId,
    a: asset,
    t: f.days,
    d: day,
    s: f.state,
    r: f.reason,
    p25: f.p25Bps,
    p50: f.medianBps,
    p75: f.p75Bps,
    n: f.loans,
    l: f.lenders,
    b: f.borrowers,
    u: f.unconfirmed,
    rs: REFERENCE_NOT_PUBLISHED,
    at: now,
  };
}

/** The pass over every served chain; one chain's failure never stops the
 *  next. */
export async function refreshRateCurve(db: D1Database, chainIds: number[], now: number): Promise<void> {
  for (const chainId of chainIds) {
    try {
      const r = await refreshRateCurveForChain(db, chainId, now);
      console.log(`[rateCurve] chain ${chainId}: ${r.rows} rows over ${r.days} days`);
    } catch (err) {
      console.error(`[rateCurve] chain ${chainId} failed`, redactedError(err));
    }
  }
}

// ─── Reads ───────────────────────────────────────────────────────────

function json(body: unknown, status = 200, cache = 'public, max-age=300'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cache,
    },
  });
}

export function handleRateCurvePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** The rule as a response states it: every setting, each point's duration
 *  range and look-back, and what is counted. */
export function ruleStatement() {
  return {
    ...OWN_LOANS_RULE,
    provisional: true,
    excludes: [
      'linked-rate-loans',
      'self-trade-pairs',
      'unconfirmed-terms',
      'lender-sale-vehicles',
      'nft-legs',
      'loans-younger-than-min-age',
    ],
    interestSources: PAID_INTEREST_SOURCES,
    // Every interest payment states itself (#3755) except a fallback
    // recovery, which settles principal, interest and the bonus as one
    // amount, so no interest figure exists for it to count.
    interestNotCounted: ['fallback-recovery'],
    points: CURVE_TERMS.map((days) => ({
      days,
      termRange: TERM_RANGES[days],
      lookbackDays: lookbackDays(days),
    })),
  };
}

function ownOf(r: CurveRow) {
  return {
    state: r.own_state,
    reason: r.own_reason,
    p25Bps: r.own_p25_bps,
    medianBps: r.own_median_bps,
    p75Bps: r.own_p75_bps,
    loans: r.own_loans,
    lenders: r.own_lenders,
    borrowers: r.own_borrowers,
    unconfirmedLeftOut: r.own_unconfirmed,
  };
}

function referenceOf(r: CurveRow) {
  return {
    state: r.ref_state,
    valueBps: r.ref_value_bps,
    a24Bps: r.ref_a24_bps,
    a90Bps: r.ref_a90_bps,
    weightBps: r.ref_weight_bps,
  };
}

const ASSET_RE = /^0x[0-9a-fA-F]{40}$/;

/** The common front of both reads: the rate limit and the asset. Each
 *  read checks its own parameters, then the served chain (a malformed
 *  request is a 400 whatever the chain, servedChain.ts). */
async function curveRequest(
  req: Request,
  env: Env,
): Promise<{ chainId: number; asset: string; url: URL } | Response> {
  const refusal = slotRefusalStatus(await takeCallerSlot(req, env.RATE_CURVE_RATELIMIT));
  if (refusal) return json({ error: refusal.error }, refusal.status, 'no-store');
  const url = new URL(req.url);
  const raw = url.searchParams.get('asset');
  if (!raw || !ASSET_RE.test(raw)) return json({ error: 'bad-asset' }, 400);
  return { chainId: requestedChainId(url), asset: raw.toLowerCase(), url };
}

/** GET /rates/curve — the latest day's curve for one asset. */
export async function handleRateCurve(req: Request, env: Env): Promise<Response> {
  const front = await curveRequest(req, env);
  if (front instanceof Response) return front;
  const { chainId, asset } = front;
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM rate_curve_daily
        WHERE chain_id = ?1 AND asset = ?2
          AND day = (SELECT MAX(day) FROM rate_curve_daily WHERE chain_id = ?1 AND asset = ?2)
        ORDER BY term_days`,
    )
      .bind(chainId, asset)
      .all<CurveRow>();
    const rows = res.results ?? [];
    const byTerm = new Map(rows.map((r) => [r.term_days, r]));
    return json({
      chainId,
      asset,
      notice: CURVE_NOTICE,
      // False when the pass has never written this asset: no loan of it is
      // in any look-back, or the pass has not run since it appeared.
      computed: rows.length > 0,
      day: rows[0]?.day ?? null,
      asOf: rows.length ? Math.max(...rows.map((r) => r.computed_at)) : null,
      reference: {
        source: 'outside-rate-reference',
        terms: CURVE_TERMS.map((days) => {
          const r = byTerm.get(days);
          return r
            ? { days, ...referenceOf(r) }
            : { days, state: REFERENCE_NOT_PUBLISHED, valueBps: null, a24Bps: null, a90Bps: null, weightBps: null };
        }),
      },
      ownLoans: {
        source: 'platform-loans',
        rule: ruleStatement(),
        terms: CURVE_TERMS.map((days: CurveTerm) => {
          const r = byTerm.get(days);
          const range = { days, termRange: TERM_RANGES[days], lookbackDays: lookbackDays(days) };
          return r
            ? { ...range, ...ownOf(r) }
            : { ...range, state: 'not-computed', reason: null, p25Bps: null, medianBps: null, p75Bps: null, loans: 0, lenders: 0, borrowers: 0, unconfirmedLeftOut: null };
        }),
      },
    });
  } catch (err) {
    console.error('[rateCurve] curve read failed', redactedError(err));
    return json({ error: 'rate-curve-failed' }, 500, 'no-store');
  }
}

/** Allowed history ranges, in days. Null-prototype (raw query keys). */
const HISTORY_RANGES: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, { '30d': 30, '90d': 90, '365d': 365 }),
);

/** GET /rates/curve/history — one point's daily rows, both halves. */
export async function handleRateCurveHistory(req: Request, env: Env): Promise<Response> {
  const front = await curveRequest(req, env);
  if (front instanceof Response) return front;
  const { chainId, asset, url } = front;
  const days = Number(url.searchParams.get('days') ?? '30');
  if (!(CURVE_TERMS as readonly number[]).includes(days)) return json({ error: 'bad-days' }, 400);
  const rangeRaw = url.searchParams.get('range') ?? '90d';
  if (!Object.hasOwn(HISTORY_RANGES, rangeRaw)) return json({ error: 'bad-range' }, 400);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  const since = Math.floor(Date.now() / 1000 / DAY) - HISTORY_RANGES[rangeRaw];
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM rate_curve_daily
        WHERE chain_id = ? AND asset = ? AND term_days = ? AND day > ?
        ORDER BY day`,
    )
      .bind(chainId, asset, days, since)
      .all<CurveRow>();
    return json({
      chainId,
      asset,
      days,
      termRange: TERM_RANGES[days as CurveTerm],
      lookbackDays: lookbackDays(days as CurveTerm),
      notice: CURVE_NOTICE,
      rule: ruleStatement(),
      // Only days the pass has written; a gap is a day it has not filled
      // yet, never a zero.
      rows: (res.results ?? []).map((r) => ({
        day: r.day,
        reference: referenceOf(r),
        ownLoans: ownOf(r),
      })),
    });
  } catch (err) {
    console.error('[rateCurve] history read failed', redactedError(err));
    return json({ error: 'rate-curve-history-failed' }, 500, 'no-store');
  }
}
