/**
 * D1 persistence — two things only.
 *
 * 1. `streak_state` — the run-length each windowed advisory needs. Kept
 *    as a counter rather than a window of stored observations so the
 *    signal is independent of tick spacing and the table stays O(chains).
 * 2. `alert_sent` — repeat suppression, so a condition that persists for
 *    days does not repost every tick.
 *
 * This Worker binds its OWN database (`vaipakam-mesh-alerts-db`), not the
 * shared `vaipakam-archive`. Same trust-boundary reasoning that gave
 * `ops/lz-watcher` a separate D1: internal ops alerting must not
 * co-locate with user-facing data.
 */

import type { StreakState } from './invariants';

export interface AlertRecord {
  key: string;
  /** Content hash — a changed fingerprint re-alerts immediately, because
   *  the numbers moving is new information even inside the quiet window. */
  fingerprint: string;
}

/** Load every persisted streak for one signal, keyed by chain id. */
export async function loadStreaks(
  db: D1Database,
  signal: string,
): Promise<Map<number, StreakState>> {
  const rows = await db
    .prepare('SELECT chain_id, marker, streak FROM streak_state WHERE signal = ?')
    .bind(signal)
    .all<{ chain_id: number; marker: string; streak: number }>();

  const out = new Map<number, StreakState>();
  for (const row of rows.results ?? []) {
    out.set(row.chain_id, { marker: row.marker, streak: row.streak });
  }
  return out;
}

/** Persist (or clear) one chain's streak for one signal. */
export function saveStreakStatement(
  db: D1Database,
  signal: string,
  chainId: number,
  next: StreakState | null,
  now: number,
): D1PreparedStatement {
  if (!next) {
    return db
      .prepare('DELETE FROM streak_state WHERE signal = ? AND chain_id = ?')
      .bind(signal, chainId);
  }
  return db
    .prepare(
      `INSERT INTO streak_state (chain_id, signal, marker, streak, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chain_id, signal) DO UPDATE SET
         marker = excluded.marker,
         streak = excluded.streak,
         updated_at = excluded.updated_at`,
    )
    .bind(chainId, signal, next.marker, next.streak, now);
}

/**
 * Filter a batch of alerts down to the ones worth sending.
 *
 * An alert is sent when it is new, when its content changed, or when the
 * quiet window has elapsed since it was last sent.
 *
 * @returns The subset to send, and the statements that record them.
 */
export async function selectAlertsToSend(
  db: D1Database,
  candidates: readonly AlertRecord[],
  repeatSeconds: number,
  now: number,
): Promise<{ send: AlertRecord[]; statements: D1PreparedStatement[] }> {
  if (candidates.length === 0) return { send: [], statements: [] };

  const placeholders = candidates.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT alert_key, last_sent_at, fingerprint FROM alert_sent WHERE alert_key IN (${placeholders})`,
    )
    .bind(...candidates.map((c) => c.key))
    .all<{ alert_key: string; last_sent_at: number; fingerprint: string }>();

  const seen = new Map(
    (rows.results ?? []).map((r) => [
      r.alert_key,
      { lastSentAt: r.last_sent_at, fingerprint: r.fingerprint },
    ]),
  );

  const send: AlertRecord[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const candidate of candidates) {
    const prior = seen.get(candidate.key);
    const due =
      !prior ||
      prior.fingerprint !== candidate.fingerprint ||
      now - prior.lastSentAt >= repeatSeconds;
    if (!due) continue;

    send.push(candidate);
    statements.push(
      db
        .prepare(
          `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint)
           VALUES (?, ?, ?)
           ON CONFLICT (alert_key) DO UPDATE SET
             last_sent_at = excluded.last_sent_at,
             fingerprint = excluded.fingerprint`,
        )
        .bind(candidate.key, now, candidate.fingerprint),
    );
  }

  return { send, statements };
}

/**
 * Drop dedup rows for conditions that are no longer active.
 *
 * Without this a condition that cleared would leave its row behind, and a
 * recurrence inside the quiet window would be silently suppressed —
 * exactly when the operator most wants to hear about it. Expressed as
 * "retain only the active keys" rather than "delete these cleared keys"
 * because the Worker knows what is firing now, not what fired historically.
 *
 * @param activeKeys Keys observed as firing this tick. Empty means
 *                   everything cleared, so the table is emptied.
 */
export function retainOnlyActiveStatement(
  db: D1Database,
  activeKeys: readonly string[],
): D1PreparedStatement {
  if (activeKeys.length === 0) {
    return db.prepare('DELETE FROM alert_sent');
  }
  const placeholders = activeKeys.map(() => '?').join(', ');
  return db
    .prepare(`DELETE FROM alert_sent WHERE alert_key NOT IN (${placeholders})`)
    .bind(...activeKeys);
}

/** Cheap content hash for the fingerprint field (FNV-1a, 32-bit). */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
