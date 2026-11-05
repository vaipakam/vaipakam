/**
 * RL-3 claim horizon (#1956) — the free pre-expiry notice, as inbox rows.
 *
 * The rule that turns the contract's horizon events into the rows a reward
 * entry's OWNER finds in the in-app notification centre. Each event names the
 * owner in its `user` argument and names no loan, so the rows need no loan
 * lookup:
 *
 *   - `RewardEntryExpiryArmed` — the contract's last call: the entry accrued
 *     its full horizon of executable time and now has the notice period left
 *     (`reward_final_notice`);
 *   - `RewardEntryExpiryBegun` — the removal point, after which the owner can
 *     no longer claim that entry (`reward_expired`).
 *
 * ONE RULE, TWO CONSUMERS (#3207). The indexer materializes these rows from
 * its scan (`apps/indexer/src/notifications.ts` re-exports both names), and
 * the connected app's e2e indexer stub derives the bell's reward rows from
 * the local chain's real logs with this same function, so the Anvil drive
 * that proves the safeguard before arming tests the indexer's rule rather
 * than a copy of it. Plain JavaScript (typed by the `.d.mts` beside it) so the
 * stub, which runs on the stock `node` binary, can import it.
 */

/** Source event → the inbox kind its owner row carries. */
export const REWARD_OWNER_NOTIF_MAP = Object.freeze({
  RewardEntryExpiryArmed: 'reward_final_notice',
  RewardEntryExpiryBegun: 'reward_expired',
});

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * One row per source event, to the lowercased `user` the event names.
 *
 * The dedup key carries the event position, not just the entry, because a
 * horizon reconfiguration re-earns a fresh notice and re-arms the entry — that
 * second last call must notify again rather than be swallowed as a duplicate.
 * `dataJson` carries the entry id (and, for the last call, when its notice
 * period began) so the client can say which reward it means. A log with no
 * usable owner or entry id yields no row.
 */
export function planOwnerNotifications(chainId, logs, blockTimestamps, nowSec) {
  const rows = [];
  const seen = new Set();
  for (const log of logs) {
    const kind = Object.hasOwn(REWARD_OWNER_NOTIF_MAP, log.eventName)
      ? REWARD_OWNER_NOTIF_MAP[log.eventName]
      : undefined;
    if (!kind) continue;
    const user = log.args.user;
    if (typeof user !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(user) || user.toLowerCase() === ZERO_ADDR) {
      continue;
    }
    const recipient = user.toLowerCase();
    const entryId = String(log.args.entryId ?? '');
    if (!/^[0-9]+$/.test(entryId)) continue;
    const blockNumber = Number(log.blockNumber);
    const dedupKey = `${chainId}:${recipient}:${kind}:entry:${entryId}:${blockNumber}:${log.logIndex}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const data = { entryId };
    if (log.args.finalNoticeFrom !== undefined) data.finalNoticeFrom = Number(log.args.finalNoticeFrom);
    rows.push({
      chainId,
      recipient,
      kind,
      loanId: null,
      eventKind: log.eventName,
      blockNumber,
      logIndex: log.logIndex,
      createdAt: blockTimestamps.get(log.blockNumber) ?? nowSec,
      dedupKey,
      dataJson: JSON.stringify(data),
    });
  }
  return rows;
}
