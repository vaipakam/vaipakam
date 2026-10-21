/**
 * The keeper's PRIVATE database, checked before a machine tick runs (#2450).
 *
 * A Worker's deploy (`scripts/deploy-keeper.mjs`) applies the keeper-private
 * migrations and verifies them before it publishes. A machine has no deploy
 * step — pulling new code and restarting IS the release — so each tick asks
 * the same question itself, and declines, by name, while the answer is no:
 * does `KEEPER_DB` record every migration this build carries
 * (`src/requiredKeeperMigrations.json`, pinned to `migrations/` by a test)?
 * The machine never APPLIES them — one applier per database, and for this one
 * it is the keeper's deploy (`pnpm --filter @vaipakam/keeper run migrate`).
 *
 * Fail closed: an unread `d1_migrations` declines. A pass is never cached: the
 * check is one read per tick.
 *
 * Until #2560 this gate also re-read the five tables that began in the shared
 * database, to catch a legacy keeper still writing those old copies after the
 * one-time cutover. That watch could not see a keeper that only DELETED rows,
 * and indexer migration 0064 drops the copies, so the gate reads only the
 * private database now. The one-runner lease (`src/runnerLease.ts`) is what
 * keeps a second keeper out.
 */
import REQUIRED from '../src/requiredKeeperMigrations.json';

export type PrivateDbCheck = { ok: true } | { ok: false; line: string };

async function rows(db: D1Database, sql: string): Promise<Record<string, unknown>[] | null> {
  try {
    const r = await db.prepare(sql).all<Record<string, unknown>>();
    return Array.isArray(r.results) ? r.results : null;
  } catch {
    return null;
  }
}

export async function checkPrivateDb(priv: D1Database, required: readonly string[] = REQUIRED): Promise<PrivateDbCheck> {
  const applied = await rows(priv, 'SELECT name FROM d1_migrations');
  if (applied === null) {
    return { ok: false, line: '[keeper-host] tick declined: could not read the keeper database\'s d1_migrations; retrying next tick' };
  }
  const have = new Set(applied.map((r) => String(r.name)));
  const missing = required.filter((m) => !have.has(m));
  if (missing.length > 0) {
    return {
      ok: false,
      line:
        `[keeper-host] tick declined: keeper-private migration(s) ${missing.join(', ')} not applied; ` +
        'apply them with `pnpm --filter @vaipakam/keeper run migrate` (the keeper deploy is their one applier)',
    };
  }
  return { ok: true };
}

/** The gate a host runs before every tick: the full check, every time. */
export function createPrivateDbGate(required: readonly string[] = REQUIRED) {
  return {
    check: (priv: D1Database): Promise<PrivateDbCheck> => checkPrivateDb(priv, required),
  };
}
