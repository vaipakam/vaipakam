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
// THE SHARED CHUNKER, reached by relative path rather than a package
// dependency (#2234, Codex #2235 r1 P2). This Worker is outside the pnpm
// workspace on purpose — its own D1, its own Telegram bot — so it cannot
// `import '@vaipakam/lib/d1Binds'`. That boundary is about CREDENTIALS AND
// DATA, not about source: `chains.ts` already reaches into `packages/` the
// same way for `deployments.json`, and for the same reason — one definition
// beats a copy that drifts.
import { chunkD1InList } from '../../../packages/lib/src/d1Binds';

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
      // CHUNKED, because this list is NOT bounded by configuration (#2234,
      // corrected at Codex #2235 r1 P2). An earlier version of this comment
      // claimed the three dynamic lists here were sized by the watcher's own
      // signals times its CONFIGURED chains. They are not, and `chains.ts`
      // says so in its own header: the chain set is read from the canonical
      // Diamond's `getExpectedSourceChainIds()`, which has no length ceiling
      // on-chain, and a chain can contribute more than one finding. So the
      // claim was exactly the kind this module was being changed to remove —
      // an assumption of smallness with nothing enforcing it.
      const seen = new Map<string, { lastSentAt: number; fingerprint: string }>();
      const chunks = chunkD1InList(candidates.map((c) => c.key));
      const parts = await this.db.batch<{
        alert_key: string;
        last_sent_at: number;
        fingerprint: string;
      }>(
        chunks.map((c) =>
          this.db
            .prepare(
              `SELECT alert_key, last_sent_at, fingerprint FROM alert_sent WHERE alert_key IN (${c.placeholders})`,
            )
            .bind(...c.binds),
        ),
      );
      for (const part of parts) {
        for (const r of part.results ?? []) {
          seen.set(r.alert_key, { lastSentAt: r.last_sent_at, fingerprint: r.fingerprint });
        }
      }
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
      const statements: D1PreparedStatement[] = [];
      for (const op of ops) {
        // eslint-disable-next-line no-await-in-loop
        statements.push(...(await this.build(op)));
      }
      if (statements.length === 0) return { ok: true, value: undefined };
      await this.db.batch(statements);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, failure: classify(err, 'writing alert state') };
    }
  }

  /**
   * One op becomes ONE OR MORE statements.
   *
   * It used to be exactly one, which is what made the two retention ops
   * unbounded: `DELETE … WHERE x NOT IN (keep)` carries the whole keep set in
   * a single statement, and a `NOT IN` CANNOT be split the way an `IN` can —
   * `NOT IN (A)` followed by `NOT IN (B)` deletes everything in B on the first
   * pass. So they are phrased POSITIVELY instead: read what is stored, work
   * out what is not being kept, and delete that in bounded `IN` batches.
   *
   * The read happens here, inside `commit`'s guard, which is the whole point
   * of this module (#1443 r8 P1): a throw from it is caught and returned like
   * any other failure rather than escaping to the tick.
   */
  private async build(op: StoreOp): Promise<D1PreparedStatement[]> {
    switch (op.kind) {
      case 'saveStreak':
        return [
          this.db
            .prepare(
              `INSERT INTO streak_state (chain_id, signal, marker, streak, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (chain_id, signal) DO UPDATE SET
               marker = excluded.marker,
               streak = excluded.streak,
               updated_at = excluded.updated_at`,
            )
            .bind(op.chainId, op.signal, op.state.marker, op.state.streak, op.at),
        ];
      case 'clearStreak':
        return [
          this.db
            .prepare('DELETE FROM streak_state WHERE signal = ? AND chain_id = ?')
            .bind(op.signal, op.chainId),
        ];
      case 'pruneStreaks': {
        if (op.keepChainIds.length === 0) return [this.db.prepare('DELETE FROM streak_state')];
        const stored = await this.db
          .prepare('SELECT DISTINCT chain_id FROM streak_state')
          .all<{ chain_id: number }>();
        const keep = new Set(op.keepChainIds);
        const drop = (stored.results ?? [])
          .map((r) => r.chain_id)
          .filter((id) => !keep.has(id));
        return chunkD1InList(drop).map((c) =>
          this.db
            .prepare(`DELETE FROM streak_state WHERE chain_id IN (${c.placeholders})`)
            .bind(...c.binds),
        );
      }
      case 'recordAlert':
        return [
          this.db
            .prepare(
              `INSERT INTO alert_sent (alert_key, last_sent_at, fingerprint)
             VALUES (?, ?, ?)
             ON CONFLICT (alert_key) DO UPDATE SET
               last_sent_at = excluded.last_sent_at,
               fingerprint = excluded.fingerprint`,
            )
            .bind(op.key, op.at, op.fingerprint),
        ];
      case 'retainAlerts': {
        if (op.keepKeys.length === 0) return [this.db.prepare('DELETE FROM alert_sent')];
        const stored = await this.db
          .prepare('SELECT alert_key FROM alert_sent')
          .all<{ alert_key: string }>();
        const keep = new Set(op.keepKeys);
        const drop = (stored.results ?? [])
          .map((r) => r.alert_key)
          .filter((k) => !keep.has(k));
        return chunkD1InList(drop).map((c) =>
          this.db
            .prepare(`DELETE FROM alert_sent WHERE alert_key IN (${c.placeholders})`)
            .bind(...c.binds),
        );
      }
    }
  }
}
