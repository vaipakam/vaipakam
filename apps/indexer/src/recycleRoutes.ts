/**
 * M5 (#1218 / #1349) — recycling transparency read surface
 * (docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md §M5;
 *  figures ratified in VpfiRecyclingBalanceGovernorDesign.md §9).
 *
 * GET /metrics/recycling?chainId=&days=
 *
 * Serves the per-day recycling series the public dashboard reads:
 *
 *   scheduleFloor[D], recycledBudget[D]      — the day's pool, as stamped
 *   absorbed[D] = local + mirror             — global credit for the day
 *   freshDrawdown[D]                         — the schedule floor actually
 *                                              drawn; `netEmission` maps to
 *                                              exactly this
 *   selfFundingRatio[D] = recycledBudget / dailyPool
 *
 * ── Three ways this endpoint refuses to publish a misleading number ──
 *
 * 1. **Unstamped days serve `null`, never `0`.** A day accrues absorption
 *    long before it is finalized, so a row can hold real absorbed figures
 *    with no pool at all. Emitting `0` for the pool would be
 *    indistinguishable from a genuine zero — the exact defect #1487 fixed
 *    for the absorption term, so reintroducing it here would be
 *    self-defeating.
 *
 * 2. **Unarmed days are marked `estimate` and carry no `netEmission`.**
 *    Before the governor is armed nothing reserves against the day's
 *    figures: claim pricing reads an uncapped half while the stamp records
 *    a capped one. The numbers are still worth showing — they are the
 *    schedule the programme is running — but publishing them AS net
 *    emission would overstate, in the flattering direction. That is what
 *    the event's `armed` field exists to prevent, so the wire format
 *    withholds the derived figure rather than trusting every consumer to
 *    check a flag.
 *
 * 3. **No calendar dates.** Days are reported by their reward `dayId`
 *    only. Mapping those to dates needs `interactionLaunchTimestamp`, and
 *    embedding it here would make this endpoint a second authority on
 *    where day boundaries fall — the precise conflation the 0045 migration
 *    warns about, since reward days do not roll at UTC midnight.
 *
 * Amounts are wei decimal strings; ratios are numbers with 6-dp precision
 * computed in BigInt. Reads are open-CORS like every other indexer read.
 */

import type { Env } from './env';
import { jsonResponse } from './offerRoutes';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** Trailing window for the runway mean, per governor design §9. */
const RUNWAY_WINDOW_DAYS = 30;

function parseChainId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDays(raw: string | null): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

/** 6-dp ratio from BigInt numerator/denominator; null when den == 0. */
function ratio6(num: bigint, den: bigint): number | null {
  if (den === 0n) return null;
  return Number((num * 1_000_000n) / den) / 1_000_000;
}

interface PoolRow {
  day_id: number;
  stamped: number;
  schedule_floor: string;
  recycled_budget: string;
  a_bar: string;
  margin_bps: number;
  fresh_drawdown: string;
  armed: number;
  absorbed_local: string;
  absorbed_mirror: string;
}

export async function handleRecyclingSeries(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const days = parseDays(url.searchParams.get('days'));

  try {
    // The window is the last `days` REWARD days present for this chain.
    // Anchoring on the highest stored day rather than on wall-clock time
    // keeps this endpoint free of the launch timestamp (see the header):
    // the series describes protocol days, and the newest one it knows
    // about is the newest one there is.
    const head = await env.DB.prepare(
      `SELECT MAX(day_id) AS max_day FROM recycle_day_pool WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ max_day: number | null }>();

    const maxDay = head?.max_day ?? null;
    if (maxDay === null) {
      return jsonResponse({
        chainId,
        days,
        fromDay: null,
        toDay: null,
        daily: [],
        cumulative: {
          absorbed: '0',
          freshDrawdown: '0',
          recycledBudget: '0',
          runwayExtensionDays: null,
        },
      });
    }

    const cutoff = Math.max(0, maxDay - days + 1);

    // Cumulative figures are LIFETIME, not window-scoped — a runway that
    // moved when a caller changed `days` would be reporting the query, not
    // the programme. Both reads return rows and the folding happens in
    // BigInt: these are 18-dec wei decimal strings, and a SQL `SUM` over
    // them would silently overflow SQLite's int64.
    const [windowRows, lifetime] = await Promise.all([
      env.DB.prepare(
        `SELECT day_id, stamped, schedule_floor, recycled_budget, a_bar,
                margin_bps, fresh_drawdown, armed,
                absorbed_local, absorbed_mirror
           FROM recycle_day_pool
          WHERE chain_id = ? AND day_id >= ?
          ORDER BY day_id ASC`,
      )
        .bind(chainId, cutoff)
        .all<PoolRow>(),
      env.DB.prepare(
        `SELECT stamped, armed, schedule_floor, recycled_budget,
                fresh_drawdown, absorbed_local, absorbed_mirror
           FROM recycle_day_pool WHERE chain_id = ?`,
      )
        .bind(chainId)
        .all<
          Pick<
            PoolRow,
            | 'stamped'
            | 'armed'
            | 'schedule_floor'
            | 'recycled_budget'
            | 'fresh_drawdown'
            | 'absorbed_local'
            | 'absorbed_mirror'
          >
        >(),
    ]);

    let cumAbsorbed = 0n;
    let cumFreshDrawdown = 0n;
    let cumRecycledBudget = 0n;
    for (const r of lifetime.results ?? []) {
      cumAbsorbed += BigInt(r.absorbed_local) + BigInt(r.absorbed_mirror);
      // Only ARMED, stamped days contribute to the emission and budget
      // cumulatives — an unarmed day's figures are estimates nothing
      // reserved, and summing them would launder that straight into a
      // lifetime total where the per-day `estimate` flag cannot follow.
      if (r.stamped === 1 && r.armed === 1) {
        cumFreshDrawdown += BigInt(r.fresh_drawdown);
        cumRecycledBudget += BigInt(r.recycled_budget);
      }
    }

    const daily = [];
    const rowsByDay = new Map<number, PoolRow>();
    for (const r of windowRows.results ?? []) rowsByDay.set(r.day_id, r);

    // Dense series: emit EVERY day in the window so a consumer can tell a
    // quiet day from a missing bucket (the same convention RL-2 pins).
    for (let dayId = cutoff; dayId <= maxDay; dayId++) {
      const r = rowsByDay.get(dayId);
      const absorbedLocal = BigInt(r?.absorbed_local ?? '0');
      const absorbedMirror = BigInt(r?.absorbed_mirror ?? '0');
      const stamped = r?.stamped === 1;
      const armed = r?.armed === 1;

      if (!stamped) {
        daily.push({
          dayId,
          stamped: false,
          armed: false,
          estimate: false,
          scheduleFloor: null,
          recycledBudget: null,
          aBar: null,
          marginBps: null,
          freshDrawdown: null,
          netEmission: null,
          selfFundingRatio: null,
          absorbedLocal: absorbedLocal.toString(),
          absorbedMirror: absorbedMirror.toString(),
          absorbed: (absorbedLocal + absorbedMirror).toString(),
        });
        continue;
      }

      const scheduleFloor = BigInt(r!.schedule_floor);
      const recycledBudget = BigInt(r!.recycled_budget);
      const freshDrawdown = BigInt(r!.fresh_drawdown);
      const dailyPool = scheduleFloor + recycledBudget;

      daily.push({
        dayId,
        stamped: true,
        armed,
        // An unarmed day's pool figures are unreserved estimates. Shown,
        // but labelled, and with the derived emission withheld.
        estimate: !armed,
        scheduleFloor: scheduleFloor.toString(),
        recycledBudget: recycledBudget.toString(),
        aBar: r!.a_bar,
        marginBps: r!.margin_bps,
        freshDrawdown: freshDrawdown.toString(),
        netEmission: armed ? freshDrawdown.toString() : null,
        selfFundingRatio: ratio6(recycledBudget, dailyPool),
        absorbedLocal: absorbedLocal.toString(),
        absorbedMirror: absorbedMirror.toString(),
        absorbed: (absorbedLocal + absorbedMirror).toString(),
      });
    }

    // Runway (governor §9): cumulative recycled ÷ trailing-window mean of
    // `dailyPool`. Reported as null with `selfFunded: true` once the fresh
    // floor is zero across the window — the design's `∞ / self-funded`
    // terminal form, and NEVER a division by the zeroed floor.
    let trailingPoolSum = 0n;
    let trailingFloorSum = 0n;
    let trailingCount = 0n;
    const trailingFrom = Math.max(cutoff, maxDay - RUNWAY_WINDOW_DAYS + 1);
    for (let dayId = trailingFrom; dayId <= maxDay; dayId++) {
      const r = rowsByDay.get(dayId);
      if (!r || r.stamped !== 1 || r.armed !== 1) continue;
      trailingPoolSum += BigInt(r.schedule_floor) + BigInt(r.recycled_budget);
      trailingFloorSum += BigInt(r.schedule_floor);
      trailingCount += 1n;
    }
    const selfFunded = trailingCount > 0n && trailingFloorSum === 0n;
    const runwayExtensionDays =
      trailingCount === 0n || selfFunded
        ? null
        : ratio6(cumAbsorbed * trailingCount, trailingPoolSum);

    return jsonResponse({
      chainId,
      days,
      fromDay: cutoff,
      toDay: maxDay,
      daily,
      cumulative: {
        absorbed: cumAbsorbed.toString(),
        freshDrawdown: cumFreshDrawdown.toString(),
        recycledBudget: cumRecycledBudget.toString(),
        runwayExtensionDays,
        selfFunded,
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: 'recycling-series query failed', detail: String(err) },
      500,
    );
  }
}
