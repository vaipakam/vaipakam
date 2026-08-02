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
 * 3. **The GLOBAL aggregate is published only for a finalized day.** A
 *    day's cross-chain reports arrive one at a time and before the day is
 *    stamped, so an unstamped day holds *some* mirrors' credits — summing
 *    them yields a plausible partial figure wearing a global label. Both
 *    components are always published; the sum is withheld until the day
 *    is finalized. This is also what makes the endpoint correct on a
 *    MIRROR deployment without asking which chain is canonical: a mirror
 *    never stamps a day, so it never publishes a global figure, and it
 *    keeps reporting the local absorption it genuinely observes. Deciding
 *    by the deployment's current role instead would erase a demoted
 *    chain's history — the mistake #1487 was corrected for.
 *
 * 4. **No days before coverage begins.** The dense window starts at the
 *    first day actually observed, never at `today − days`. Synthesising
 *    unstamped zero buckets in front of the first observation would make
 *    "not indexed yet" indistinguishable from "quiet", which is the very
 *    distinction the dense series exists to draw.
 *
 * 5. **No calendar dates.** Days are reported by their reward `dayId`
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

/**
 * Trailing smoothing window `W`, in reward days.
 *
 * MUST match the protocol's own `RECYCLE_TRAILING_WINDOW_DAYS = 7`
 * (`LibVaipakam.sol`; governor design §"smoothing window", a compile-time
 * constant deliberately not a knob). An earlier version of this file used
 * 30, which made the published runway a different metric from the ratified
 * one — same name, different denominator — and delayed the self-funded
 * terminal state (Codex #1507 r3 P2). A dashboard figure that quietly
 * disagrees with the protocol's own is worse than no figure.
 */
const RUNWAY_WINDOW_DAYS = 7;

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
    // Read BEFORE the empty-series branch below (Codex #1508 r2 P2). A
    // chain that has only ever taken pre-launch credits — the NORMAL state
    // before the schedule starts — has no day rows at all, so reading this
    // afterwards would report zero for exactly the period the figure exists
    // to describe, until some unrelated scheduled event created the first
    // day row.
    const preLaunchRow = await env.DB.prepare(
      `SELECT absorbed, day0_legacy FROM recycle_prelaunch WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ absorbed: string; day0_legacy: string }>();
    const preLaunch = preLaunchRow?.absorbed ?? '0';
    // Day 0 may still hold pre-launch value on a Diamond upgraded in place:
    // credits taken before the split are already inside it and no code
    // change separates them. True only where it is true.
    const dayZeroConflated = BigInt(preLaunchRow?.day0_legacy ?? '0') > 0n;

    const head = await env.DB.prepare(
      `SELECT MAX(day_id) AS max_day, MIN(day_id) AS min_day
         FROM recycle_day_pool WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ max_day: number | null; min_day: number | null }>();

    const maxDay = head?.max_day ?? null;
    if (maxDay === null) {
      return jsonResponse({
        chainId,
        days,
        fromDay: null,
        toDay: null,
        daily: [],
        scope: 'empty',
        coverageFromDay: null,
        cumulative: {
          absorbed: '0',
          absorbedPreLaunch: preLaunch,
          absorbedLocal: '0',
          absorbedMirror: '0',
          freshDrawdown: '0',
          recycledBudget: '0',
          runwayExtensionDays: null,
          // Present with the same shape as every non-empty response, so a
          // dashboard's no-data state does not need a special case to tell
          // "not self-funded" from "field absent" (Codex #1507 r1 P2).
          selfFunded: false,
        },
      });
    }

    // Clamp the window to where this consumer's observations actually
    // begin (Codex #1507 r1 P1). `maxDay - days + 1` can precede the first
    // event ever recorded — on a consumer deployed mid-programme it always
    // does — and filling that gap with unstamped zero rows publishes
    // "quiet" where the truth is "not indexed". `coverageFromDay` is
    // reported so a consumer can see the boundary rather than infer it.
    const coverageFromDay = head?.min_day ?? maxDay;
    const cutoff = Math.max(coverageFromDay, maxDay - days + 1);

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
    let cumAbsorbedLocal = 0n;
    let cumAbsorbedMirror = 0n;
    let cumFreshDrawdown = 0n;
    let cumRecycledBudget = 0n;
    let anyStamped = false;
    for (const r of lifetime.results ?? []) {
      cumAbsorbedLocal += BigInt(r.absorbed_local);
      cumAbsorbedMirror += BigInt(r.absorbed_mirror);
      // The GLOBAL absorption total sums only FINALIZED days. An unstamped
      // day holds whichever cross-chain reports have arrived so far, so
      // folding it in would put a partial figure inside a total labelled
      // global — and a lifetime total is exactly where a partial value
      // stops being recognisable as one. The two components above are
      // unconditional, so nothing observed is hidden.
      if (r.stamped !== 1) continue;
      anyStamped = true;
      cumAbsorbed += BigInt(r.absorbed_local) + BigInt(r.absorbed_mirror);
      // Only ARMED, stamped days contribute to the emission and budget
      // cumulatives — an unarmed day's figures are estimates nothing
      // reserved, and summing them would launder that straight into a
      // lifetime total where the per-day `estimate` flag cannot follow.
      if (r.armed === 1) {
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
          // Withheld until the day is finalized: mirrors report one at a
          // time, so this sum would be a partial figure under a global
          // label. On a mirror deployment no day is ever stamped, which
          // is why this endpoint needs no canonical-chain check.
          absorbed: null,
          preLaunchConflated: dayId === 0 && dayZeroConflated,
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
        // Only where it is actually true. A chain that has always had the
        // split files pre-launch value separately, so its day 0 is clean;
        // a chain upgraded in place carries the old mixture forever and no
        // code change can separate it (Codex #1508 r2 P2).
        preLaunchConflated: dayId === 0 && dayZeroConflated,
      });
    }

    // Runway (governor §9): cumulative recycled ÷ trailing-window mean of
    // `dailyPool`. Reported as null with `selfFunded: true` once the fresh
    // floor is zero across the window — the design's `∞ / self-funded`
    // terminal form, and NEVER a division by the zeroed floor.
    //
    // The trailing window is FIXED and read independently of `days`
    // (Codex #1507 r1 P2). Deriving it from the display window made a
    // lifetime metric move when a caller changed the range it asked to
    // see — `days=1` computed the mean from a single day — so the same
    // chain state answered differently depending on the question's shape.
    // A cumulative that depends on the query is reporting the query.
    // Anchored on the latest FINALIZED, armed day — not on the highest
    // row of any kind (Codex #1507 r3 P2). `maxDay` moves the moment the
    // next day's first credit arrives, and since the window then excludes
    // that unstamped row it would silently average W-1 days instead of W.
    // The reported lifetime runway would change because a day BEGAN,
    // which is not an event about the trailing window at all.
    let trailingPoolSum = 0n;
    let trailingFloorSum = 0n;
    let trailingCount = 0n;
    const anchorRow = await env.DB.prepare(
      `SELECT MAX(day_id) AS anchor FROM recycle_day_pool
        WHERE chain_id = ? AND stamped = 1 AND armed = 1`,
    )
      .bind(chainId)
      .first<{ anchor: number | null }>();
    const anchor = anchorRow?.anchor ?? null;
    const trailingRows =
      anchor === null
        ? { results: [] as Array<{ schedule_floor: string; recycled_budget: string }> }
        : await env.DB.prepare(
            `SELECT schedule_floor, recycled_budget
               FROM recycle_day_pool
              WHERE chain_id = ? AND day_id >= ? AND day_id <= ?
                AND stamped = 1 AND armed = 1`,
          )
            .bind(chainId, Math.max(0, anchor - RUNWAY_WINDOW_DAYS + 1), anchor)
            .all<{ schedule_floor: string; recycled_budget: string }>();
    for (const r of trailingRows.results ?? []) {
      trailingPoolSum += BigInt(r.schedule_floor) + BigInt(r.recycled_budget);
      trailingFloorSum += BigInt(r.schedule_floor);
      trailingCount += 1n;
    }
    const selfFunded = trailingCount > 0n && trailingFloorSum === 0n;
    // The numerator is the LIFETIME recycled stock, which genuinely includes
    // pre-launch credits — they are in the bucket and in the on-chain
    // recycled cumulative (Codex #1508 r2 P2). Keeping them out of `Ā` is a
    // statement about a trailing RATE and says nothing about this total; I
    // conflated the two and understated the runway.
    const runwayNumerator = cumAbsorbed + BigInt(preLaunch);
    const runwayExtensionDays =
      trailingCount === 0n || selfFunded
        ? null
        : ratio6(runwayNumerator * trailingCount, trailingPoolSum);

    return jsonResponse({
      chainId,
      days,
      fromDay: cutoff,
      toDay: maxDay,
      // Whether this deployment can answer the GLOBAL question at all.
      // Derived from whether it has ever finalized a day — not from which
      // chain currently holds the canonical role, so a demoted deployment
      // keeps serving the days it did finalize.
      scope: anyStamped ? 'global' : 'local-only',
      coverageFromDay,
      daily,
      cumulative: {
        absorbed: cumAbsorbed.toString(),
        // #1504 — absorption credited before the schedule started. It has no
        // day, so it appears here and nowhere in `daily`. Day 0 used to
        // carry it, which made that bucket the sum of an arbitrarily long
        // pre-launch period and the first real day; the contracts now file
        // it separately and so does this. It is the term that reconciles the
        // recycle bucket against the sum of the day series.
        absorbedPreLaunch: preLaunch,
        absorbedLocal: cumAbsorbedLocal.toString(),
        absorbedMirror: cumAbsorbedMirror.toString(),
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
