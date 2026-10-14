/**
 * apps/keeper — one keeper runner at a time (#2503).
 *
 * The keeper can run on a Cloudflare Worker or on an always-on machine
 * (`host/`), and every copy signs with the same key. Two copies running at
 * once would race each other's sends (the per-network send ordering, #2486,
 * holds only within one process) and each other's per-tick state. So every
 * tick first claims a lease row in the shared database
 * (`apps/indexer/migrations/0059_keeper_runner_lease.sql`) and declines, by
 * name, while another runner holds it.
 *
 * The rules, all in one statement so two claimants cannot both win:
 *
 *   - a claim succeeds when there is no row, when the claimant already holds
 *     it (a renewal), or when it has expired;
 *   - a successful claim moves the expiry to `now + LEASE_TTL_MS`, and keeps
 *     `acquired_at` unless the holder changed;
 *   - nothing else touches the row, so a runner that stops renewing (its
 *     machine died, its schedule was removed) hands over by itself once its
 *     lease runs out, and a live runner renews every minute.
 *
 * Identity is `KEEPER_RUNNER_ID`, which must be set: the Worker's comes from
 * `wrangler.jsonc`, and the machine install writes the host name into the
 * machine's env file. A tick with no identity declines rather than guessing
 * one, because two runners that guessed the same name would each think they
 * held the lease.
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

/** How long a claim lasts without renewal. Ticks renew every minute. */
export const LEASE_TTL_MS = 10 * 60_000;

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
  nowMs: number,
  ttlMs: number = LEASE_TTL_MS,
): Promise<LeaseClaim> {
  if (holder === undefined || holder.trim() === '') {
    return {
      held: false,
      reason: 'KEEPER_RUNNER_ID is not set, so this runner cannot claim the one-runner lease',
    };
  }
  try {
    // SET assignments read the OLD row, so `acquired_at` compares against
    // the previous holder. The WHERE makes the upsert a no-op (no RETURNING
    // row) while someone else holds an unexpired lease.
    const row = await db
      .prepare(
        `INSERT INTO keeper_runner_lease (lease, holder, acquired_at, renewed_at, expires_at)
         VALUES (?1, ?2, ?3, ?3, ?4)
         ON CONFLICT (lease) DO UPDATE SET
           acquired_at = CASE WHEN keeper_runner_lease.holder = excluded.holder
                              THEN keeper_runner_lease.acquired_at
                              ELSE excluded.acquired_at END,
           holder = excluded.holder,
           renewed_at = excluded.renewed_at,
           expires_at = excluded.expires_at
         WHERE keeper_runner_lease.holder = excluded.holder
            OR keeper_runner_lease.expires_at <= excluded.renewed_at
         RETURNING acquired_at`,
      )
      .bind(LEASE_NAME, holder, nowMs, nowMs + ttlMs)
      .first<{ acquired_at: number }>();
    if (row !== null) {
      return { held: true, acquired: Number(row.acquired_at) === nowMs };
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
      reason: `could not claim the one-runner lease (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
