/**
 * RL-2 (#1303) — reward loop-closure ledger
 * (docs/DesignsAndPlans/VpfiRecyclingLoopClosureDesign.md §6 RL-2).
 *
 * Consumes three Diamond events from the ingest's decoded-log stream and
 * maintains the per-user reward-retention ledger plus the per-day flow
 * components behind `loopClosureRatio`:
 *
 *   - `InteractionRewardsClaimed(user, fromDay, toDay, amount)` —
 *     `distributed[user][D]` (every claim payout, wallet- or
 *     vault-delivered).
 *   - `RewardDeliveredToVault(user, amount, claimDayId)` (RL-1, #1302) —
 *     `vault_delivered[user][D]` and a retention CREDIT.
 *   - `VaultVpfiDebited(user, amount, recipient)` — a retention DEBIT,
 *     min-clamped to the current ledger balance: debits spend
 *     reward-delivered VPFI FIRST, and later personal deposits can never
 *     re-inflate the ledger (a naive `min(balance, cumDelivered)` clamp
 *     would falsely report full retention after a withdraw + re-fund).
 *
 * Day basis: `D = floor(blockTimestamp / 86400)` — the UTC epoch-day the
 * tokens actually left protocol custody, applied identically to BOTH sides
 * of the ratio, so every indexer reading the same events reports the same
 * number and a claim spanning many finalized reward days is never re-split.
 * Logs whose block timestamp fell back to the ingest's wall-clock sentinel
 * get ONE in-place retry via the caller-supplied `retryTimestamp`; if the
 * timestamp is still unavailable the ledger THROWS, failing the whole scan
 * so the cursor does not advance past the event (Codex #1310 r2 P1: the
 * cron path has no guaranteed overlapping scan, so a silent skip would
 * lose the event forever; day bucketing must never lock in a sentinel).
 *
 * Exactly-once: the ingest can re-scan overlapping block ranges, so each
 * event's effects apply only if its `reward_loop_events` row inserts fresh,
 * and the insert + every table update run in ONE `db.batch()` (a D1
 * transaction) — a crash can't split "recorded" from "applied". Ordering
 * within a scan follows the decoded-log order (block, logIndex), and the
 * single-writer ChainIngestDO serializes scans, so the min-clamp reads are
 * race-free.
 *
 * One-time backfill (Codex #1310 P2): on a chain whose ingest cursor is
 * already past historical reward events, the live wiring alone would
 * omit prior wallet-paid distributions from `cum_distributed` and
 * OVERSTATE closure. First invocation per chain therefore replays the
 * three event kinds from the `activity_events` ledger (which records
 * every decoded event since the indexer's genesis) through the same
ratio-critical apply-one path, then stamps
 * `reward_loop_totals.backfill_done`. The dedup key is identical, so
 * backfill and live application can overlap safely, and the backfill runs
 * BEFORE this scan's rows land in activity_events (Codex #1310 r2 P2) so
 * it can never consume a sentinel-stamped row from the current scan.
 * Historical vault debits that predate the `VaultVpfiDebited` event are
 * replayed from `VPFIWithdrawnFromVault` rows, bounded to blocks BEFORE
 * the first VaultVpfiDebited row (Codex #1310 r2 P1) — past that boundary
 * both events fire in the same unstake tx and replaying both would
 * double-decrement. (`activity_events.block_at` can itself carry a rare
 * wall-clock sentinel from a historical RPC hiccup — it is the best
 * available record for history and accepted as-is for the backfill only.)
 *
 * `absorbed[D]` / `cum_absorbed`: deliberately ZERO until the governor
 * stack's recycle-bucket events exist. When PR-3a lands its
 * `VpfiRecycled(class, …)` credit event, add a branch here crediting
 * `cum_absorbed` (and a per-day absorbed column) from that event — the
 * ratio endpoints already carry the term.
 *
 * All amounts are 18-dec wei as decimal strings; arithmetic is JS BigInt
 * (wei overflows SQLite int64).
 */

import type { Env } from './env';

/** The decoded-log slice this module consumes (structural subset of the
 *  ingest's DecodedLog — kept local so the module stays unit-testable). */
export interface RewardLoopLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

const HANDLED = new Set([
  'InteractionRewardsClaimed',
  'RewardDeliveredToVault',
  'VaultVpfiDebited',
]);

interface LedgerEvent {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  kind: string;
  user: string;
  amount: bigint;
  blockAt: number;
}

function big(v: string | null | undefined): bigint {
  return BigInt(v ?? '0');
}

/** Apply ONE event's ledger effects exactly once. Returns true when the
 *  event was fresh (false = dedup replay, skipped). Shared by the live
 *  ingest path and the one-time activity_events backfill. */
async function applyOne(
  env: Env,
  chainId: number,
  ev: LedgerEvent,
): Promise<boolean> {
  const dayId = Math.floor(ev.blockAt / 86400);

  // Exactly-once gate: skip events already applied by a prior scan or
  // by the backfill (same key space).
  const seen = await env.DB.prepare(
    `SELECT 1 FROM reward_loop_events
      WHERE chain_id = ? AND block_number = ? AND log_index = ?`,
  )
    .bind(chainId, ev.blockNumber, ev.logIndex)
    .first();
  if (seen) return false;

  // Current state reads (race-free under the single-writer DO).
  const retention = await env.DB.prepare(
    `SELECT retained FROM reward_retention WHERE chain_id = ? AND user = ?`,
  )
    .bind(chainId, ev.user)
    .first<{ retained: string }>();
  const dayRow = await env.DB.prepare(
    `SELECT distributed, vault_delivered, reward_funded_debits
       FROM reward_day_user
      WHERE chain_id = ? AND day_id = ? AND user = ?`,
  )
    .bind(chainId, dayId, ev.user)
    .first<{
      distributed: string;
      vault_delivered: string;
      reward_funded_debits: string;
    }>();
  const totals = await env.DB.prepare(
    `SELECT cum_distributed, retained_stock
       FROM reward_loop_totals WHERE chain_id = ?`,
  )
    .bind(chainId)
    .first<{ cum_distributed: string; retained_stock: string }>();

  let retained = big(retention?.retained);
  let distributed = big(dayRow?.distributed);
  let vaultDelivered = big(dayRow?.vault_delivered);
  let rewardFundedDebits = big(dayRow?.reward_funded_debits);
  let cumDistributed = big(totals?.cum_distributed);
  let retainedStock = big(totals?.retained_stock);
  let retainedDelta = 0n;

  if (ev.kind === 'InteractionRewardsClaimed') {
    distributed += ev.amount;
    cumDistributed += ev.amount;
  } else if (ev.kind === 'RewardDeliveredToVault') {
    retained += ev.amount;
    retainedStock += ev.amount;
    vaultDelivered += ev.amount;
    retainedDelta = ev.amount;
  } else {
    // VaultVpfiDebited (or a pre-boundary historical
    // VPFIWithdrawnFromVault replayed by the backfill) — min-clamped
    // retention decrement.
    const dec = ev.amount < retained ? ev.amount : retained;
    retained -= dec;
    retainedStock -= dec;
    rewardFundedDebits += dec;
    retainedDelta = -dec;
  }

  // One transaction: dedup row + every state write. The totals upsert
  // deliberately updates ONLY the two counters this path owns —
  // `cum_absorbed` (PR-3a's future feed) and `backfill_done` are
  // preserved by the ON CONFLICT column list.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO reward_loop_events
         (chain_id, block_number, log_index, tx_hash, kind, user,
          amount, day_id, retained_delta, block_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      chainId,
      ev.blockNumber,
      ev.logIndex,
      ev.txHash.toLowerCase(),
      ev.kind,
      ev.user,
      ev.amount.toString(),
      dayId,
      retainedDelta.toString(),
      ev.blockAt,
    ),
    env.DB.prepare(
      `INSERT INTO reward_retention (chain_id, user, retained)
       VALUES (?, ?, ?)
       ON CONFLICT (chain_id, user)
       DO UPDATE SET retained = excluded.retained`,
    ).bind(chainId, ev.user, retained.toString()),
    env.DB.prepare(
      `INSERT INTO reward_day_user
         (chain_id, day_id, user, distributed, vault_delivered,
          reward_funded_debits)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (chain_id, day_id, user)
       DO UPDATE SET distributed = excluded.distributed,
                     vault_delivered = excluded.vault_delivered,
                     reward_funded_debits = excluded.reward_funded_debits`,
    ).bind(
      chainId,
      dayId,
      ev.user,
      distributed.toString(),
      vaultDelivered.toString(),
      rewardFundedDebits.toString(),
    ),
    env.DB.prepare(
      `INSERT INTO reward_loop_totals
         (chain_id, cum_distributed, retained_stock)
       VALUES (?, ?, ?)
       ON CONFLICT (chain_id)
       DO UPDATE SET cum_distributed = excluded.cum_distributed,
                     retained_stock = excluded.retained_stock`,
    ).bind(chainId, cumDistributed.toString(), retainedStock.toString()),
  ]);
  return true;
}

/** Parse a reward event out of an `activity_events` backfill row. */
function eventFromActivityRow(row: {
  block_number: number;
  log_index: number;
  tx_hash: string;
  kind: string;
  args_json: string;
  block_at: number;
}): LedgerEvent | null {
  try {
    const args = JSON.parse(row.args_json) as Record<string, unknown>;
    const user = String(args.user ?? '').toLowerCase();
    if (!user.startsWith('0x')) return null;
    return {
      blockNumber: row.block_number,
      logIndex: row.log_index,
      txHash: row.tx_hash,
      kind: row.kind,
      user,
      // serializeArgs coerces bigints to decimal strings in args_json.
      amount: BigInt(String(args.amount ?? '0')),
      blockAt: row.block_at,
    };
  } catch {
    return null;
  }
}

/** One-time per-chain backfill from the activity_events ledger (see the
 *  module header). Idempotent: dedup keys match the live path, so an
 *  interrupted backfill resumes safely on the next scan. Exported so the
 *  ingest's caught-up quiet tick can seed the tables on a chain with no
 *  new logs (Codex #1310 r2 P2 — without this, /metrics/loop-closure
 *  would serve zeros until an unrelated future log arrived). */
export async function ensureRewardLoopBackfill(
  env: Env,
  chainId: number,
): Promise<void> {
  const totals = await env.DB.prepare(
    `SELECT backfill_done FROM reward_loop_totals WHERE chain_id = ?`,
  )
    .bind(chainId)
    .first<{ backfill_done: number }>();
  if (totals?.backfill_done) return;

  // Debit-observability boundary: before the first VaultVpfiDebited row,
  // vault VPFI outflows were visible only as VPFIWithdrawnFromVault
  // (unstakes) — replay those as debits so historical deliveries that
  // were later withdrawn don't overstate retention. From the boundary on,
  // an unstake tx emits BOTH events, so the withdraw rows are excluded
  // to avoid double-decrementing.
  const boundaryRow = await env.DB.prepare(
    `SELECT MIN(block_number) AS b FROM activity_events
      WHERE chain_id = ? AND kind = 'VaultVpfiDebited'`,
  )
    .bind(chainId)
    .first<{ b: number | null }>();
  const boundary = boundaryRow?.b ?? null;

  const rows = await env.DB.prepare(
    `SELECT block_number, log_index, tx_hash, kind, args_json, block_at
       FROM activity_events
      WHERE chain_id = ?
        AND kind IN ('InteractionRewardsClaimed',
                     'RewardDeliveredToVault',
                     'VaultVpfiDebited',
                     'VPFIWithdrawnFromVault')
      ORDER BY block_number ASC, log_index ASC`,
  )
    .bind(chainId)
    .all<{
      block_number: number;
      log_index: number;
      tx_hash: string;
      kind: string;
      args_json: string;
      block_at: number;
    }>();

  for (const row of rows.results ?? []) {
    if (
      row.kind === 'VPFIWithdrawnFromVault' &&
      (boundary === null || row.block_number >= boundary)
    ) {
      continue;
    }
    const ev = eventFromActivityRow(row);
    if (ev && ev.amount >= 0n) await applyOne(env, chainId, ev);
  }

  await env.DB.prepare(
    `INSERT INTO reward_loop_totals (chain_id, backfill_done)
     VALUES (?, 1)
     ON CONFLICT (chain_id) DO UPDATE SET backfill_done = 1`,
  )
    .bind(chainId)
    .run();
}

/**
 * Apply the RL-2 ledger effects for one scan's decoded logs. Runs the
 * one-time activity_events backfill first (a single cheap SELECT once
 * done). Returns the number of events applied fresh (replays skip).
 *
 * @param fallbackTimestampBlocks Blocks whose `blockTimestamps` entry is
 *        the ingest's wall-clock sentinel. A reward log in such a block
 *        gets ONE retry via `retryTimestamp`; if the real timestamp is
 *        still unavailable this function THROWS so the whole scan fails
 *        and the cursor never advances past the event (reward events are
 *        rare — failing the tick beats corrupting the day bucketing).
 * @param retryTimestamp Re-fetches a block's chain timestamp (seconds),
 *        returning null on failure. Optional for unit tests.
 */
export async function applyRewardLoopLedger(
  logs: RewardLoopLog[],
  env: Env,
  chainId: number,
  blockTimestamps: Map<bigint, number>,
  fallbackTimestampBlocks: Set<bigint> = new Set(),
  retryTimestamp?: (blockNumber: bigint) => Promise<number | null>,
): Promise<number> {
  await ensureRewardLoopBackfill(env, chainId);

  let applied = 0;
  for (const log of logs) {
    if (!HANDLED.has(log.eventName)) continue;
    let blockAt: number | undefined;
    if (fallbackTimestampBlocks.has(log.blockNumber)) {
      blockAt = (await retryTimestamp?.(log.blockNumber)) ?? undefined;
    } else {
      blockAt = blockTimestamps.get(log.blockNumber);
    }
    if (blockAt === undefined) {
      throw new Error(
        `reward-loop: unrecoverable block timestamp for block ` +
          `${log.blockNumber} (chain ${chainId}) — failing the scan so ` +
          `the cursor does not advance past a reward event`,
      );
    }

    const user = String(log.args.user ?? '').toLowerCase();
    const amount = BigInt((log.args.amount as bigint) ?? 0n);
    if (!user.startsWith('0x') || amount < 0n) continue;

    const fresh = await applyOne(env, chainId, {
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex,
      txHash: log.transactionHash,
      kind: log.eventName,
      user,
      amount,
      blockAt,
    });
    if (fresh) applied++;
  }
  return applied;
}
