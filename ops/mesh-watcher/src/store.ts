/**
 * ROOT-CAUSE FIX #2 — storage that cannot throw.
 *
 * Five review rounds found five different call sites where a D1
 * rejection escaped to the tick's outer catch and destroyed
 * already-computed ledger evidence (#1443 r5, r6, r7 twice, r8). Each
 * fix wrapped one more site. The fifth was the sharpest: statement
 * CONSTRUCTION (`prepare`/`bind`) happened outside the delivery
 * boundary, so even a correctly-guarded `commit` could not save it.
 *
 * The pattern is unwinnable while any caller can hold a raw `D1Database`,
 * because "did you remember to guard this one?" is a question that has to
 * be answered correctly every time, forever. So this module owns the
 * binding and exposes methods that RETURN failures instead of throwing:
 * there is nothing to catch, and therefore nothing to forget to catch.
 *
 * Operations are described as DATA ({@link StoreOp}) and turned into
 * statements inside `commit`, so construction is inside the boundary too.
 */

import { classify, type Failure } from './errors';
import type { StreakState } from './invariants';

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: Failure };

/** A write, described rather than prepared — see the module note. */
export type StoreOp =
  | { kind: 'saveStreak'; signal: string; chainId: number; state: StreakState; at: number }
  | { kind: 'clearStreak'; signal: string; chainId: number }
  | { kind: 'pruneStreaks'; keepChainIds: readonly number[] }
  | { kind: 'recordAlert'; key: string; fingerprint: string; at: number }
  | { kind: 'retainAlerts'; keepKeys: readonly string[] };

export interface DueAlert {
  key: string;
  fingerprint: string;
}

export class AlertStore {
  constructor(private readonly db: D1Database) {}

  /** Persisted runs for one signal, keyed by chain id. */
  async loadStreaks(signal: string): Promise<StoreResult<Map<number, StreakState>>> {
    try {
      const rows = await this.db
        .prepare('SELECT chain_id, marker, streak FROM streak_state WHERE signal = ?')
        .bind(signal)
        .all<{ chain_id: number; marker: string; streak: number }>();
      const out = new Map<number, StreakState>();
      for (const row of rows.results ?? []) {
        out.set(row.chain_id, { marker: row.marker, streak: row.streak });
      }
      return { ok: true, value: out };
    } catch (err) {
      return { ok: false, failure: classify(err, 'loading alert runs') };
    }
  }

  /**
   * Which candidates are due to send.
   *
   * On failure the caller is expected to send EVERYTHING — "could not
   * check whether this is a repeat" must degrade to "send it".
   */
  async selectDue(
    candidates: readonly DueAlert[],
    repeatSeconds: number,
    now: number,
  ): Promise<StoreResult<DueAlert[]>> {
    if (candidates.length === 0) return { ok: true, value: [] };
    try {
      const placeholders = candidates.map(() => '?').join(', ');
      const rows = await this.db
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
      return {
        ok: true,
        value: candidates.filter((c) => {
          const prior = seen.get(c.key);
          return (
            !prior ||
            prior.fingerprint !== c.fingerprint ||
            now - prior.lastSentAt >= repeatSeconds
          );
        }),
      };
    } catch (err) {
      return { ok: false, failure: classify(err, 'checking repeat suppression') };
    }
  }

  /**
   * Apply writes.
   *
   * Statements are BUILT here, inside the guard — passing already-prepared
   * statements in was the fifth escape (#1443 r8 P1).
   */
  async commit(ops: readonly StoreOp[]): Promise<StoreResult<void>> {
    if (ops.length === 0) return { ok: true, value: undefined };
    try {
      const statements = ops.map((op) => this.build(op));
      await this.db.batch(statements);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, failure: classify(err, 'writing alert state') };
    }
  }

  private build(op: StoreOp): D1PreparedStatement {
    switch (op.kind) {
      case 'saveStreak':
        return this.db
          .prepare(
            `INSERT INTO streak_state (chain_id, signal, marker, streak, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (chain_id, signal) DO UPDATE SET
               marker = excluded.marker,
               streak = excluded.streak,
               updated_at = excluded.updated_at`,
          )
          .bind(op.chainId, op.signal, op.state.marker, op.state.streak, op.at);
      case 'clearStreak':
        return this.db
          .prepare('DELETE FROM streak_state WHERE signal = ? AND chain_id = ?')
          .bind(op.signal, op.chainId);
      case 'pruneStreaks':
        return op.keepChainIds.length === 0
          ? this.db.prepare('DELETE FROM streak_state')
          : this.db
              .prepare(
                `DELETE FROM streak_state WHERE chain_id NOT IN (${op.keepChainIds.map(() => '?').join(', ')})`,
              )
              .bind(...op.keepChainIds);
      case 'recordAlert':
        return this.db
          .prepare(
            `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint)
             VALUES (?, ?, ?)
             ON CONFLICT (alert_key) DO UPDATE SET
               last_sent_at = excluded.last_sent_at,
               fingerprint = excluded.fingerprint`,
          )
          .bind(op.key, op.at, op.fingerprint);
      case 'retainAlerts':
        return op.keepKeys.length === 0
          ? this.db.prepare('DELETE FROM alert_sent')
          : this.db
              .prepare(
                `DELETE FROM alert_sent WHERE alert_key NOT IN (${op.keepKeys.map(() => '?').join(', ')})`,
              )
              .bind(...op.keepKeys);
    }
  }
}
