/**
 * M5 (#1218 / #1349) — recycling transparency day series ingest
 * (docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md §M5).
 *
 * Turns three Diamond events into the per-day rows behind
 * `GET /metrics/recycling`:
 *
 *   GovernorDayPoolStamped(dayId, scheduleFloor, recycledBudget, aBar,
 *                          marginBps, freshDrawdown, armed)
 *       → the day's pool composition, once per finalized day.
 *   VpfiRecycled(source, refId, amount, dayId)
 *       → this chain's own absorption for that day.
 *   ChainRecycledReported(sourceChainId, dayId, cumulative,
 *                         forDayReported, dayCreditAccepted)
 *       → absorption accepted FROM ANOTHER CHAIN (see the filter below).
 *
 * **Every day index here comes out of the event payload.** That is the
 * REWARD day — whole days since `interactionLaunchTimestamp` — which is
 * the key the contracts themselves use for `recycledCreditedByDay` and
 * `dayMirrorRecycledCredit`. It is NOT RL-2's UTC epoch day, and the two
 * must never be joined (see the 0045 migration header for why both exist).
 *
 * A pleasant consequence: this ingest needs no block timestamps at all,
 * so none of RL-2's sentinel-timestamp recovery applies. There is nothing
 * to derive and nothing to fall back to — the day is stated by the event.
 */

import type { Env } from './env';

export interface RecycleSeriesLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

const HANDLED = new Set([
  'GovernorDayPoolStamped',
  'VpfiRecycled',
  'ChainRecycledReported',
]);

function big(v: string | null | undefined): bigint {
  return BigInt(v ?? '0');
}

/** Read a uint out of a decoded log arg, whatever width viem gave it. */
function argBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v.length > 0) return BigInt(v);
  return 0n;
}

/**
 * Ensure a row exists for `(chainId, dayId)` so the absorption branches can
 * accumulate into a day that has not been finalized yet. Pool columns keep
 * their defaults and `stamped` stays 0 — an unstamped row carrying real
 * absorption is an ordinary state, not a gap.
 */
function ensureRow(env: Env, chainId: number, dayId: number) {
  return env.DB.prepare(
    `INSERT INTO recycle_day_pool (chain_id, day_id)
     VALUES (?, ?)
     ON CONFLICT (chain_id, day_id) DO NOTHING`,
  ).bind(chainId, dayId);
}

/**
 * Apply ONE event's series effects exactly once.
 * Returns true when the event was fresh (false = dedup replay, skipped).
 */
async function applyOne(
  env: Env,
  chainId: number,
  log: RecycleSeriesLog,
): Promise<boolean> {
  const blockNumber = Number(log.blockNumber);
  const dayId = Number(argBig(log.args.dayId));

  // Exactly-once gate: overlapping scan ranges (webhook + sweep) must not
  // double-count an absorption credit.
  const seen = await env.DB.prepare(
    `SELECT 1 FROM recycle_series_events
      WHERE chain_id = ? AND block_number = ? AND log_index = ?`,
  )
    .bind(chainId, blockNumber, log.logIndex)
    .first();
  if (seen) return false;

  const record = env.DB.prepare(
    `INSERT INTO recycle_series_events
       (chain_id, block_number, log_index, tx_hash, kind, day_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    chainId,
    blockNumber,
    log.logIndex,
    log.transactionHash,
    log.eventName,
    dayId,
  );

  if (log.eventName === 'GovernorDayPoolStamped') {
    // Absorption columns are deliberately NOT touched here — they are
    // accumulated by their own branches, and a re-stamp of the same day
    // must not reset credits that arrived independently of it.
    await env.DB.batch([
      record,
      ensureRow(env, chainId, dayId),
      env.DB.prepare(
        `UPDATE recycle_day_pool
            SET stamped = 1,
                schedule_floor = ?,
                recycled_budget = ?,
                a_bar = ?,
                margin_bps = ?,
                fresh_drawdown = ?,
                armed = ?
          WHERE chain_id = ? AND day_id = ?`,
      ).bind(
        argBig(log.args.scheduleFloor).toString(),
        argBig(log.args.recycledBudget).toString(),
        argBig(log.args.aBar).toString(),
        Number(argBig(log.args.marginBps)),
        argBig(log.args.freshDrawdown).toString(),
        log.args.armed === true ? 1 : 0,
        chainId,
        dayId,
      ),
    ]);
    return true;
  }

  if (log.eventName === 'VpfiRecycled') {
    const amount = argBig(log.args.amount);
    const row = await env.DB.prepare(
      `SELECT absorbed_local FROM recycle_day_pool
        WHERE chain_id = ? AND day_id = ?`,
    )
      .bind(chainId, dayId)
      .first<{ absorbed_local: string }>();
    await env.DB.batch([
      record,
      ensureRow(env, chainId, dayId),
      env.DB.prepare(
        `UPDATE recycle_day_pool SET absorbed_local = ?
          WHERE chain_id = ? AND day_id = ?`,
      ).bind((big(row?.absorbed_local) + amount).toString(), chainId, dayId),
    ]);
    return true;
  }

  // ChainRecycledReported — the canonical chain's OWN report is excluded.
  //
  // This event fires for every reporting chain including the canonical one
  // reporting itself, but the contract folds the accepted credit into
  // `dayMirrorRecycledCredit` only when `sourceChainId != block.chainid`;
  // its own credit deliberately stays in the local `recycledCreditedByDay`
  // series that `VpfiRecycled` above already feeds. Counting the self-report
  // here would add the canonical chain's absorption a second time — and in
  // the flattering direction, overstating precisely the cross-chain activity
  // this series exists to evidence. Mirroring the contract's own condition
  // is what keeps `absorbed_local + absorbed_mirror` equal to the global
  // figure the day-pool stamp was sized from.
  const sourceChainId = Number(argBig(log.args.sourceChainId));
  const accepted = argBig(log.args.dayCreditAccepted);
  if (sourceChainId === chainId || accepted === 0n) {
    // Still recorded, so a replay cannot re-evaluate the filter.
    await env.DB.batch([record]);
    return true;
  }

  const row = await env.DB.prepare(
    `SELECT absorbed_mirror FROM recycle_day_pool
      WHERE chain_id = ? AND day_id = ?`,
  )
    .bind(chainId, dayId)
    .first<{ absorbed_mirror: string }>();
  await env.DB.batch([
    record,
    ensureRow(env, chainId, dayId),
    env.DB.prepare(
      `UPDATE recycle_day_pool SET absorbed_mirror = ?
        WHERE chain_id = ? AND day_id = ?`,
    ).bind((big(row?.absorbed_mirror) + accepted).toString(), chainId, dayId),
  ]);
  return true;
}

/**
 * Ingest entry point — called from the chain scan with every decoded log.
 * Returns the number of events actually applied (fresh, non-replay).
 */
export async function applyRecycleDaySeries(
  logs: RecycleSeriesLog[],
  env: Env,
  chainId: number,
): Promise<number> {
  let applied = 0;
  for (const log of logs) {
    if (!HANDLED.has(log.eventName)) continue;
    if (await applyOne(env, chainId, log)) applied++;
  }
  return applied;
}
