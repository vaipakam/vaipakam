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
  'VpfiRecycledPreLaunch',
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
  // A pre-launch credit carries NO dayId — deliberately, so that a field
  // that always reads zero cannot re-create the day-0 attribution (#1504).
  // Recorded as -1 in the audit table so it can never be mistaken for day 0.
  const dayId =
    log.eventName === 'VpfiRecycledPreLaunch'
      ? -1
      : Number(argBig(log.args.dayId));

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
    // The PRE-CUTOVER five-field shape is refused, not coerced (Codex
    // #1507 r3 P1). Widening the event changed its topic, so days
    // finalized before the upgrade were announced under the old
    // signature and simply cannot supply `freshDrawdown` / `armed`.
    // Reading the absent fields as `0` / `false` would store them as
    // stamped-but-unarmed days with a zero drawdown — fabricated history
    // in the shape of real history, and it would drag the coverage
    // boundary back over days this consumer cannot actually account for.
    // The ratified cutover puts those days on the getter-based backfill
    // instead (plan §M5, "Cutover"), which is a separate slice.
    //
    // Presence, not a block boundary: a widened emission always carries
    // both keys and a legacy one carries neither, so this is exact and
    // needs no operator-supplied cutover height.
    if (!('freshDrawdown' in log.args) || !('armed' in log.args)) {
      // Recorded so the audit trail is complete and a replay cannot
      // re-decide it; the day stays unstamped and absorption-only, which
      // is the truthful state until the backfill covers it.
      await env.DB.batch([record]);
      return true;
    }

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

  // #1504 — absorption credited while the schedule was INACTIVE. It has no
  // day, so it is kept as a single per-chain total rather than forced into
  // one: filing it under day 0 is the defect the contracts just stopped
  // committing. Published beside the series because it is what reconciles
  // the bucket against the sum of the days.
  if (log.eventName === 'VpfiRecycledPreLaunch') {
    const amount = argBig(log.args.amount);
    const row = await env.DB.prepare(
      `SELECT absorbed FROM recycle_prelaunch WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{ absorbed: string }>();
    await env.DB.batch([
      record,
      env.DB.prepare(
        `INSERT INTO recycle_prelaunch (chain_id, absorbed) VALUES (?, ?)
         ON CONFLICT (chain_id) DO UPDATE SET absorbed = excluded.absorbed`,
      ).bind(chainId, (big(row?.absorbed) + amount).toString()),
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
    const writes = [
      record,
      ensureRow(env, chainId, dayId),
      env.DB.prepare(
        `UPDATE recycle_day_pool SET absorbed_local = ?
          WHERE chain_id = ? AND day_id = ?`,
      ).bind((big(row?.absorbed_local) + amount).toString(), chainId, dayId),
    ];

    await env.DB.batch(writes);
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

  // Record the reporting chain's LIFETIME cumulative regardless of what was
  // accepted for the day (#1508 r4). `accepted` is bounded by that chain's
  // remaining attribution headroom, and its pre-launch stock is in no day
  // report at all — so the day series alone cannot see all of a mirror's
  // recycled value. `cumulative` is that chain's own
  // `recycleCreditedCumulative`, which counts every credit it ever took.
  // Stored as a MAX because a replayed or out-of-order report must never
  // walk a monotonic figure backwards.
  const reported = argBig(log.args.cumulative);
  const prevReported = await env.DB.prepare(
    `SELECT reported_cumulative FROM recycle_chain_reported
      WHERE chain_id = ? AND source_chain_id = ?`,
  )
    .bind(chainId, sourceChainId)
    .first<{ reported_cumulative: string }>();
  const reportedWrite = env.DB.prepare(
    `INSERT INTO recycle_chain_reported
       (chain_id, source_chain_id, reported_cumulative)
     VALUES (?, ?, ?)
     ON CONFLICT (chain_id, source_chain_id)
     DO UPDATE SET reported_cumulative = excluded.reported_cumulative`,
  ).bind(
    chainId,
    sourceChainId,
    (reported > big(prevReported?.reported_cumulative)
      ? reported
      : big(prevReported?.reported_cumulative)
    ).toString(),
  );
  if (sourceChainId === chainId || accepted === 0n) {
    // Still recorded, so a replay cannot re-evaluate the filter — and the
    // reporting chain's lifetime cumulative is kept either way, since a
    // zero-credit day still carries a truthful total.
    await env.DB.batch([record, reportedWrite]);
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
    reportedWrite,
    ensureRow(env, chainId, dayId),
    env.DB.prepare(
      `UPDATE recycle_day_pool SET absorbed_mirror = ?
        WHERE chain_id = ? AND day_id = ?`,
    ).bind((big(row?.absorbed_mirror) + accepted).toString(), chainId, dayId),
  ]);
  return true;
}

/**
 * Rebuild the series from `activity_events`, once per chain.
 *
 * The chain scan shares ONE cursor across every domain handler, so on an
 * existing deployment that cursor is already past every block this series
 * cares about. Wiring the ingest in without this would start the history
 * at "whenever this shipped" while looking complete — and the deferred
 * pre-cutover getter backfill does not cover it, because these are days
 * that DID announce themselves, just before anyone was listening
 * (Codex #1507 r1 P1).
 *
 * `activity_events` is the unified feed of every decoded log, so the
 * replay needs no chain access. It runs through the same `applyOne` as
 * the live path, so the dedup table makes it idempotent and a partially
 * completed replay simply resumes.
 *
 * The coverage boundary this produces is honest rather than assumed: it
 * is wherever `activity_events` itself begins, and the read surface
 * reports it rather than synthesising quiet days in front of it.
 */
export async function ensureRecycleSeriesBackfill(
  env: Env,
  chainId: number,
): Promise<void> {
  const state = await env.DB.prepare(
    `SELECT backfill_done FROM recycle_series_state WHERE chain_id = ?`,
  )
    .bind(chainId)
    .first<{ backfill_done: number }>();
  if (state?.backfill_done) return;

  const rows = await env.DB.prepare(
    `SELECT block_number, log_index, tx_hash, kind, args_json
       FROM activity_events
      WHERE chain_id = ?
        AND kind IN ('GovernorDayPoolStamped',
                     'VpfiRecycled',
                     'VpfiRecycledPreLaunch',
                     'ChainRecycledReported')
      ORDER BY block_number ASC, log_index ASC`,
  )
    .bind(chainId)
    .all<{
      block_number: number;
      log_index: number;
      tx_hash: string;
      kind: string;
      args_json: string;
    }>();

  for (const row of rows.results ?? []) {
    let args: Record<string, unknown>;
    try {
      // serializeArgs coerces bigints to strings; argBig accepts both.
      args = JSON.parse(row.args_json) as Record<string, unknown>;
    } catch {
      continue; // malformed row — skip rather than wedge the scan
    }
    await applyOne(env, chainId, {
      eventName: row.kind,
      args,
      blockNumber: BigInt(row.block_number),
      transactionHash: row.tx_hash,
      logIndex: row.log_index,
    });
  }

  await env.DB.prepare(
    `INSERT INTO recycle_series_state (chain_id, backfill_done)
     VALUES (?, 1)
     ON CONFLICT (chain_id) DO UPDATE SET backfill_done = 1`,
  )
    .bind(chainId)
    .run();
}

/**
 * Ingest entry point — called from the chain scan with every decoded log.
 * Returns the number of events actually applied (fresh, non-replay).
 *
 * Runs the one-time backfill first, and does so unconditionally — a
 * caught-up scan with no matching logs is exactly when a freshly deployed
 * consumer needs it most.
 */
export async function applyRecycleDaySeries(
  logs: RecycleSeriesLog[],
  env: Env,
  chainId: number,
): Promise<number> {
  await ensureRecycleSeriesBackfill(env, chainId);

  let applied = 0;
  for (const log of logs) {
    if (!HANDLED.has(log.eventName)) continue;
    if (await applyOne(env, chainId, log)) applied++;
  }
  return applied;
}
