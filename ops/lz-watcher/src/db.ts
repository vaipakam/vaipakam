/**
 * D1 helpers for the LZ-watcher. Three tables the migration creates:
 *   - lz_alert_state    (alert dedup)
 *   - scan_cursor       (per-chain log scanner cursor)
 *   - oft_balance_history (append-only snapshot trail)
 */

const ALERT_REPEAT_AFTER_SEC = 60 * 60; // 1 hour

export interface AlertState {
  kind: string;
  key: string;
  last_value: string | null;
  first_alerted_at: number;
  last_alerted_at: number;
}

/**
 * Decide whether to fire an alert for `(kind, key, currentValue)`.
 *
 *   - First time we see a bad state: fire + record.
 *   - State persists with same value: re-fire only after 1h.
 *   - Value changes (e.g. drift grows): fire + update record.
 *   - Recovery (caller passes `currentValue=null`): clear the record;
 *     next bad state is treated as a fresh first-alert.
 *
 * Returns the alert "verb" so the caller can decorate the message
 * (NEW vs. ESCALATED vs. STILL-BAD vs. RECOVERED).
 */
export type AlertVerb = 'new' | 'escalated' | 'persistent' | 'recovered' | 'suppressed';

export async function decideAndRecordAlert(
  db: D1Database,
  kind: string,
  key: string,
  currentValue: string | null,
  now: number,
): Promise<AlertVerb> {
  const existing = await db
    .prepare('SELECT last_value, first_alerted_at, last_alerted_at FROM lz_alert_state WHERE kind = ? AND key = ?')
    .bind(kind, key)
    .first<{
      last_value: string | null;
      first_alerted_at: number;
      last_alerted_at: number;
    }>();

  if (currentValue === null) {
    // Recovery branch: clear iff there was an open alert.
    if (existing) {
      await db
        .prepare('DELETE FROM lz_alert_state WHERE kind = ? AND key = ?')
        .bind(kind, key)
        .run();
      return 'recovered';
    }
    return 'suppressed';
  }

  if (!existing) {
    await db
      .prepare(
        'INSERT INTO lz_alert_state (kind, key, last_value, first_alerted_at, last_alerted_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(kind, key, currentValue, now, now)
      .run();
    return 'new';
  }

  if (existing.last_value !== currentValue) {
    await db
      .prepare(
        'UPDATE lz_alert_state SET last_value = ?, last_alerted_at = ? WHERE kind = ? AND key = ?',
      )
      .bind(currentValue, now, kind, key)
      .run();
    return 'escalated';
  }

  // Same offending value as before: only re-emit once an hour.
  if (now - existing.last_alerted_at >= ALERT_REPEAT_AFTER_SEC) {
    await db
      .prepare('UPDATE lz_alert_state SET last_alerted_at = ? WHERE kind = ? AND key = ?')
      .bind(now, kind, key)
      .run();
    return 'persistent';
  }

  return 'suppressed';
}

// ── Per-chain log scanner cursor ────────────────────────────────────

export async function getScanCursor(
  db: D1Database,
  chainId: number,
  scanner: string,
): Promise<bigint> {
  const row = await db
    .prepare('SELECT last_block FROM scan_cursor WHERE chain_id = ? AND scanner = ?')
    .bind(chainId, scanner)
    .first<{ last_block: number }>();
  return row ? BigInt(row.last_block) : 0n;
}

export async function setScanCursor(
  db: D1Database,
  chainId: number,
  scanner: string,
  lastBlock: bigint,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scan_cursor (chain_id, scanner, last_block, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (chain_id, scanner) DO UPDATE SET
         last_block = excluded.last_block,
         updated_at = excluded.updated_at`,
    )
    .bind(chainId, scanner, Number(lastBlock), now)
    .run();
}

// ── OFT balance history ─────────────────────────────────────────────

export async function recordOftSnapshot(
  db: D1Database,
  ts: number,
  baseLocked: bigint,
  sumMirrorSupply: bigint,
): Promise<void> {
  const drift = baseLocked - sumMirrorSupply;
  await db
    .prepare(
      `INSERT INTO oft_balance_history (ts, base_locked, sum_mirror_supply, drift, ok)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      ts,
      baseLocked.toString(),
      sumMirrorSupply.toString(),
      drift.toString(),
      drift === 0n ? 1 : 0,
    )
    .run();

  // Bound the history table at ~30 days. Deletes only run when there's
  // actually old rows to drop, so this is essentially free on most ticks.
  const cutoff = ts - 30 * 24 * 60 * 60;
  await db
    .prepare('DELETE FROM oft_balance_history WHERE ts < ?')
    .bind(cutoff)
    .run();
}
