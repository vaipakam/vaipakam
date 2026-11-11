/**
 * apps/keeper — one keeper runner at a time (#2503).
 *
 * The keeper can run on a Cloudflare Worker or on an always-on machine
 * (`host/`), and every copy signs with the same key. Two copies running at
 * once would race each other's sends (the per-network send ordering, #2486,
 * holds only within one process) and each other's per-tick state. So every
 * tick first claims a lease row in the keeper's PRIVATE database
 * (`apps/keeper/migrations/0009_keeper_runner_lease.sql`) and declines, by
 * name, while another runner holds it.
 *
 * #1722 — the row lived in the shared database until then, where the indexer
 * and the agent can write any table: either could hold the lease with an
 * expiry years out and stop every keeper pass, liquidations included. Only
 * the keeper binds `KEEPER_DB`, and a lease running past
 * {@link LEASE_MAX_TERM_MS} is not honoured even there.
 *
 * The rules, all in one statement so two claimants cannot both win:
 *
 *   - a claim succeeds when there is no row, when the claimant already holds
 *     it (a renewal), when it has expired, or when its expiry lies further out
 *     than the longest term a keeper ever writes ({@link LEASE_MAX_TERM_MS}).
 *     No claim this code makes produces such a row, so one can only come from
 *     a writer that is not a keeper runner, or from a database clock that
 *     jumped backwards; either way, honouring it would idle the keeper for
 *     however long the row says;
 *   - a successful claim moves the expiry to `now + LEASE_TTL_MS`, and keeps
 *     `acquired_at` unless the holder changed;
 *   - "now" is the DATABASE's clock, read inside the statement, never the
 *     claimant's. The Worker and a machine keep independent clocks, so a
 *     runner whose clock ran ahead would otherwise see a live lease as
 *     expired and take it, and one whose clock ran behind would hold it past
 *     its TTL;
 *   - nothing else touches the row, so a runner that stops renewing (its
 *     machine died, its schedule was removed) hands over by itself once its
 *     lease runs out, and a live runner renews every minute.
 *
 * Identity is `KEEPER_RUNNER_ID`. The Worker's comes from `wrangler.jsonc`;
 * on a machine it defaults to `host:<host name>` (`host/hostEnv.ts`) unless
 * the env file sets one. Here, a tick with no identity declines rather than
 * guessing one, because two runners that guessed the same name would each
 * think they held the lease.
 *
 * Every failure declines. A tick that cannot confirm it is the only runner
 * (the table is missing, the database is unreachable) does not run, which is
 * the safe direction for a process that signs.
 *
 * What this is NOT: a fencing token. A runner whose single pass outlives the
 * TTL without the minute clock renewing could overlap a successor. The
 * machine host renews on minutes it skips for a still-running tick, and the
 * TTL is many times the length of a normal tick, so that needs a pass stuck
 * for ten minutes AND a second runner configured, and the decline line names
 * the holder either way.
 */

import { redactedError } from '@vaipakam/lib/errorDescription';

/** How long a claim lasts without renewal. Ticks renew every minute. */
export const LEASE_TTL_MS = 10 * 60_000;

/**
 * The furthest out a lease's expiry may lie and still be honoured (#1722).
 * Equal to the TTL: every claim sets the expiry to exactly `now + TTL`, so a
 * live row written by a runner of this code is never further out than this.
 * A future build that lengthens the TTL must lengthen this with it, or a
 * runner on this build would read the newer runner's lease as one to take.
 */
export const LEASE_MAX_TERM_MS = LEASE_TTL_MS;

/** The single lease row's key. */
export const LEASE_NAME = 'keeper';

export type LeaseClaim =
  | { held: true; acquired: boolean }
  | { held: false; reason: string };

/**
 * Claim or renew the lease for `holder`. Never throws: a failure is a
 * decline with its cause, so a broken database cannot start a tick.
 */
export async function claimRunnerLease(
  db: D1Database,
  holder: string | undefined,
  ttlMs: number = LEASE_TTL_MS,
  maxTermMs: number = LEASE_MAX_TERM_MS,
): Promise<LeaseClaim> {
  if (holder === undefined || holder.trim() === '') {
    return {
      held: false,
      reason: 'KEEPER_RUNNER_ID is not set, so this runner cannot claim the one-runner lease',
    };
  }
  try {
    // `now` is the database's clock in milliseconds, fixed for the whole
    // statement (julianday works on every SQLite D1 runs). SET assignments
    // read the OLD row, so `acquired_at` compares against the previous
    // holder. The upsert WHERE makes it a no-op (no RETURNING row) while
    // someone else holds an unexpired lease whose expiry is within the
    // maximum term; `WHERE true` is the SELECT's own clause, which SQLite
    // requires before ON CONFLICT.
    const row = await db
      .prepare(
        `INSERT INTO keeper_runner_lease (lease, holder, acquired_at, renewed_at, expires_at)
         SELECT ?1, ?2, now, now, now + ?3
           FROM (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now)
          WHERE true
         ON CONFLICT (lease) DO UPDATE SET
           acquired_at = CASE WHEN keeper_runner_lease.holder = excluded.holder
                              THEN keeper_runner_lease.acquired_at
                              ELSE excluded.acquired_at END,
           holder = excluded.holder,
           renewed_at = excluded.renewed_at,
           expires_at = excluded.expires_at
         WHERE keeper_runner_lease.holder = excluded.holder
            OR keeper_runner_lease.expires_at <= excluded.renewed_at
            OR keeper_runner_lease.expires_at > excluded.renewed_at + ?4
         RETURNING acquired_at, renewed_at`,
      )
      .bind(LEASE_NAME, holder, ttlMs, maxTermMs)
      .first<{ acquired_at: number; renewed_at: number }>();
    if (row !== null) {
      return { held: true, acquired: Number(row.acquired_at) === Number(row.renewed_at) };
    }
    const other = await db
      .prepare('SELECT holder, expires_at FROM keeper_runner_lease WHERE lease = ?1')
      .bind(LEASE_NAME)
      .first<{ holder: string; expires_at: number }>();
    if (other === null) {
      // Released between the two statements; the next tick claims it.
      return { held: false, reason: 'the one-runner lease changed hands while it was being claimed' };
    }
    return {
      held: false,
      reason: `runner "${other.holder}" holds the one-runner lease until ${new Date(Number(other.expires_at)).toISOString()}`,
    };
  } catch (err) {
    return {
      held: false,
      reason: `could not claim the one-runner lease (${redactedError(err, { stack: false })})`,
    };
  }
}
