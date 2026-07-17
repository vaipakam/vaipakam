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
 *
 * Exactly-once: the ingest can re-scan overlapping block ranges, so each
 * event's effects apply only if its `reward_loop_events` row inserts fresh,
 * and the insert + every table update run in ONE `db.batch()` (a D1
 * transaction) — a crash can't split "recorded" from "applied". Ordering
 * within a scan follows the decoded-log order (block, logIndex), and the
 * single-writer ChainIngestDO serializes scans, so the min-clamp reads are
 * race-free.
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

function big(v: string | null | undefined): bigint {
  return BigInt(v ?? '0');
}

/**
 * Apply the RL-2 ledger effects for one scan's decoded logs.
 * Returns the number of events applied fresh (replays skip).
 */
export async function applyRewardLoopLedger(
  logs: RewardLoopLog[],
  env: Env,
  chainId: number,
  blockTimestamps: Map<bigint, number>,
): Promise<number> {
  let applied = 0;
  for (const log of logs) {
    if (!HANDLED.has(log.eventName)) continue;

    const user = String(log.args.user ?? '').toLowerCase();
    const amount = BigInt((log.args.amount as bigint) ?? 0n);
    if (!user || user === '0x' || amount < 0n) continue;

    const blockAt =
      blockTimestamps.get(log.blockNumber) ?? Math.floor(Date.now() / 1000);
    const dayId = Math.floor(blockAt / 86400);
    const blockNumber = Number(log.blockNumber);

    // Exactly-once gate: skip events already applied by a prior scan.
    const seen = await env.DB.prepare(
      `SELECT 1 FROM reward_loop_events
        WHERE chain_id = ? AND block_number = ? AND log_index = ?`,
    )
      .bind(chainId, blockNumber, log.logIndex)
      .first();
    if (seen) continue;

    // Current state reads (race-free under the single-writer DO).
    const retention = await env.DB.prepare(
      `SELECT retained FROM reward_retention WHERE chain_id = ? AND user = ?`,
    )
      .bind(chainId, user)
      .first<{ retained: string }>();
    const dayRow = await env.DB.prepare(
      `SELECT distributed, vault_delivered, reward_funded_debits
         FROM reward_day_user
        WHERE chain_id = ? AND day_id = ? AND user = ?`,
    )
      .bind(chainId, dayId, user)
      .first<{
        distributed: string;
        vault_delivered: string;
        reward_funded_debits: string;
      }>();
    const totals = await env.DB.prepare(
      `SELECT cum_distributed, cum_absorbed, retained_stock
         FROM reward_loop_totals WHERE chain_id = ?`,
    )
      .bind(chainId)
      .first<{
        cum_distributed: string;
        cum_absorbed: string;
        retained_stock: string;
      }>();

    let retained = big(retention?.retained);
    let distributed = big(dayRow?.distributed);
    let vaultDelivered = big(dayRow?.vault_delivered);
    let rewardFundedDebits = big(dayRow?.reward_funded_debits);
    let cumDistributed = big(totals?.cum_distributed);
    let retainedStock = big(totals?.retained_stock);
    let retainedDelta = 0n;

    if (log.eventName === 'InteractionRewardsClaimed') {
      distributed += amount;
      cumDistributed += amount;
    } else if (log.eventName === 'RewardDeliveredToVault') {
      retained += amount;
      retainedStock += amount;
      vaultDelivered += amount;
      retainedDelta = amount;
    } else {
      // VaultVpfiDebited — min-clamped retention decrement.
      const dec = amount < retained ? amount : retained;
      retained -= dec;
      retainedStock -= dec;
      rewardFundedDebits += dec;
      retainedDelta = -dec;
    }

    // One transaction: dedup row + every state write.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reward_loop_events
           (chain_id, block_number, log_index, tx_hash, kind, user,
            amount, day_id, retained_delta, block_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        chainId,
        blockNumber,
        log.logIndex,
        log.transactionHash.toLowerCase(),
        log.eventName,
        user,
        amount.toString(),
        dayId,
        retainedDelta.toString(),
        blockAt,
      ),
      env.DB.prepare(
        `INSERT INTO reward_retention (chain_id, user, retained)
         VALUES (?, ?, ?)
         ON CONFLICT (chain_id, user)
         DO UPDATE SET retained = excluded.retained`,
      ).bind(chainId, user, retained.toString()),
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
        user,
        distributed.toString(),
        vaultDelivered.toString(),
        rewardFundedDebits.toString(),
      ),
      env.DB.prepare(
        `INSERT INTO reward_loop_totals
           (chain_id, cum_distributed, cum_absorbed, retained_stock)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (chain_id)
         DO UPDATE SET cum_distributed = excluded.cum_distributed,
                       retained_stock = excluded.retained_stock`,
      ).bind(
        chainId,
        cumDistributed.toString(),
        big(totals?.cum_absorbed).toString(),
        retainedStock.toString(),
      ),
    ]);
    applied++;
  }
  return applied;
}
