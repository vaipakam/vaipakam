/**
 * RL-2 (#1303) — loop-closure metric read surface
 * (docs/DesignsAndPlans/VpfiRecyclingLoopClosureDesign.md §6 RL-2).
 *
 * GET /metrics/loop-closure?chainId=&days=
 *
 * Serves the two ratios the design pins — **daily is a flow ratio,
 * cumulative is a stock ratio; deliberately different quantities**:
 *
 *   daily:      (netVaultDelivered[D] + absorbed[D]) / distributed[D]
 *               netVaultDelivered[D] = Σ_u max(0, vaultDelivered[u][D]
 *                                               − rewardFundedDebits[u][D])
 *               (netting is PER USER, then summed)
 *   cumulative: (retainedStock + cumAbsorbed) / cumDistributed
 *
 * Zero-distribution convention: days with `distributed == 0` report
 * `ratio: null` (never 0 / NaN / ∞) and are excluded from any averaging a
 * consumer does. `absorbed` is `"0"` until the governor stack's
 * VpfiRecycled events land (PR-3a — see rewardLoopLedger.ts).
 *
 * Amounts are wei decimal strings; ratios are numbers with 6-dp precision
 * computed in BigInt. Reads are open-CORS like every other indexer read;
 * the connected app's public analytics page is its display home (#1218).
 *
 * WHICH DAYS ARE KNOWN (#1349 M5). A day's figures are a FACT only once the
 * day has ended AND every claim in it has been ingested. The series used to
 * pad every day of the window with zeros, so the UTC day still in progress,
 * and any day the indexer had not reached yet, read as a day on which
 * nothing was paid out. The response now publishes `recordedBefore` — the
 * moment before which every claim is in the series (the ingest's time
 * watermark, {@link INGESTED_BEFORE_TIME_KIND}) — and gives each day a
 * `status`:
 *
 *   complete    ended, and wholly before `recordedBefore`. Amounts final;
 *               the ratio follows the zero-distribution convention.
 *   partial     straddles `recordedBefore`, or is the UTC day in progress.
 *               Amounts are what is recorded SO FAR; `ratio` is null, because
 *               a part-day ratio is not a lower bound on the day's final one
 *               and this metric may never overstate closure.
 *   unrecorded  starts at or after `recordedBefore` (every day, while no
 *               watermark exists). Amounts and ratio are null — not zero:
 *               the indexer does not know them yet.
 *
 * The status is decided HERE, once, so no consumer becomes a second authority
 * on where the record ends.
 */

import type { Env } from './env';
import { jsonResponse } from './offerRoutes';
import { INGESTED_BEFORE_TIME_KIND } from './rewardLoopLedger';

const DAY_SECONDS = 86_400;

/** How complete one day's figures are — see the module note. */
export type LoopDayStatus = 'complete' | 'partial' | 'unrecorded';

/**
 * Classify one UTC day against the recorded-before moment.
 *
 * @param dayId          UTC epoch-day
 * @param todayId        the UTC epoch-day in progress (wall clock)
 * @param recordedBefore unix seconds; `null` when no caught-up pass has
 *                       stamped one
 */
export function loopDayStatus(
  dayId: number,
  todayId: number,
  recordedBefore: number | null,
): LoopDayStatus {
  const start = dayId * DAY_SECONDS;
  if (recordedBefore === null || start >= recordedBefore) return 'unrecorded';
  // The day in progress is never final, however far the record reaches.
  if (dayId >= todayId) return 'partial';
  return start + DAY_SECONDS <= recordedBefore ? 'complete' : 'partial';
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

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

export async function handleLoopClosure(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const days = parseDays(url.searchParams.get('days'));
  const todayId = Math.floor(Date.now() / 86_400_000);
  const cutoff = todayId - days + 1;

  try {
    const [dayRows, absorbedRows, totals, watermark] = await Promise.all([
      env.DB.prepare(
        `SELECT day_id, user, distributed, vault_delivered,
                reward_funded_debits
           FROM reward_day_user
          WHERE chain_id = ? AND day_id >= ?
          ORDER BY day_id ASC`,
      )
        .bind(chainId, cutoff)
        .all<{
          day_id: number;
          user: string;
          distributed: string;
          vault_delivered: string;
          reward_funded_debits: string;
        }>(),
      env.DB.prepare(
        `SELECT day_id, absorbed FROM reward_loop_day
          WHERE chain_id = ? AND day_id >= ?`,
      )
        .bind(chainId, cutoff)
        .all<{ day_id: number; absorbed: string }>(),
      env.DB.prepare(
        `SELECT cum_distributed, cum_absorbed, retained_stock
           FROM reward_loop_totals WHERE chain_id = ?`,
      )
        .bind(chainId)
        .first<{
          cum_distributed: string;
          cum_absorbed: string;
          retained_stock: string;
        }>(),
      env.DB.prepare(
        `SELECT last_block FROM indexer_cursor
          WHERE chain_id = ? AND kind = ?`,
      )
        .bind(chainId, INGESTED_BEFORE_TIME_KIND)
        .first<{ last_block: number }>(),
    ]);
    const recordedBefore =
      watermark && Number.isFinite(Number(watermark.last_block)) && Number(watermark.last_block) > 0
        ? Number(watermark.last_block)
        : null;

    // Fold per-(user, day) rows into per-day aggregates in BigInt —
    // the per-user max(0, …) netting happens HERE, before summation.
    const byDay = new Map<
      number,
      { distributed: bigint; netVaultDelivered: bigint }
    >();
    for (const r of dayRows.results ?? []) {
      const d = byDay.get(r.day_id) ?? {
        distributed: 0n,
        netVaultDelivered: 0n,
      };
      d.distributed += BigInt(r.distributed);
      const net =
        BigInt(r.vault_delivered) - BigInt(r.reward_funded_debits);
      if (net > 0n) d.netVaultDelivered += net;
      byDay.set(r.day_id, d);
    }

    // Dense series (Codex #1310 P3): emit EVERY day in the requested
    // window, so a dashboard can distinguish a quiet day (an explicit
    // `ratio: null` bucket per the zero-distribution convention) from a
    // missing bucket. Days without events simply have no rows.
    const absorbedByDay = new Map<number, bigint>();
    for (const r of absorbedRows.results ?? []) {
      absorbedByDay.set(r.day_id, BigInt(r.absorbed));
    }

    const daily = [];
    for (let dayId = cutoff; dayId <= todayId; dayId++) {
      const date = new Date(dayId * 86_400_000).toISOString().slice(0, 10);
      const status = loopDayStatus(dayId, todayId, recordedBefore);
      if (status === 'unrecorded') {
        // Not zero: unknown. A zero here is what made a day the indexer had
        // not reached read as "nothing paid out".
        daily.push({
          dayId,
          date,
          status,
          distributed: null,
          netVaultDelivered: null,
          absorbed: null,
          ratio: null,
        });
        continue;
      }
      const d = byDay.get(dayId) ?? {
        distributed: 0n,
        netVaultDelivered: 0n,
      };
      const absorbed = absorbedByDay.get(dayId) ?? 0n;
      daily.push({
        dayId,
        date,
        status,
        distributed: d.distributed.toString(),
        netVaultDelivered: d.netVaultDelivered.toString(),
        absorbed: absorbed.toString(),
        // A part-day ratio is not a lower bound on the final one.
        ratio:
          status === 'complete'
            ? ratio6(d.netVaultDelivered + absorbed, d.distributed)
            : null,
      });
    }

    const cumDistributed = BigInt(totals?.cum_distributed ?? '0');
    const cumAbsorbed = BigInt(totals?.cum_absorbed ?? '0');
    const retainedStock = BigInt(totals?.retained_stock ?? '0');

    return jsonResponse({
      chainId,
      days,
      // Every claim timestamped before this moment is in the series. `null`
      // = no caught-up pass has recorded one yet, so no day is known.
      recordedBefore:
        recordedBefore === null
          ? null
          : new Date(recordedBefore * 1000).toISOString(),
      daily,
      cumulative: {
        cumDistributed: cumDistributed.toString(),
        cumAbsorbed: cumAbsorbed.toString(),
        retainedStock: retainedStock.toString(),
        ratio: ratio6(retainedStock + cumAbsorbed, cumDistributed),
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: 'loop-closure query failed', detail: String(err) },
      500,
    );
  }
}
