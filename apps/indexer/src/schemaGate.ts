/**
 * The D1 schema gate — scheduled work runs only against the schema this build
 * was written for.
 *
 * WHY A GATE AND NOT ONLY A DEPLOY ORDER. The deploy scripts and the package
 * `deploy` scripts of every Worker that binds the shared database now apply
 * migrations BEFORE publishing, and abort the publish if the apply fails. But
 * the indexer also auto-deploys on every merge through Cloudflare Workers
 * Builds, whose deploy command is dashboard configuration this repository
 * cannot see or pin. If that route publishes without migrating, the new code
 * meets the old schema — and #1149 is what that looks like: every scan failed
 * `no such column`, the fail-closed cursor held, and the stall was opaque
 * until someone read the logs. #2214 closed the same class for ONE table with
 * a per-feature probe; every later migration would need its own.
 *
 * This gate answers the question once, for every migration: is EVERY
 * migration this build carries recorded as applied? If not, scheduled ingest
 * and maintenance decline the tick with a log line naming what is missing,
 * instead of running code against a schema it was not written for. Nothing
 * advances and nothing half-writes, and ingest resumes by itself on the first
 * tick after the migrations land — no redeploy, no manual cursor repair.
 *
 * The WHOLE set, not the newest file (#2409 r1): a migration that fills a gap
 * in the numbering sorts below the newest, and a newest-only check would pass
 * a database that never applied it.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied:
 *  - the HTTP read API. A route that reads a column the database does not
 *    have yet still fails until the migration is applied; a feature adding
 *    such a read must tolerate the older schema itself (or ship its read
 *    after its migration). The gate keeps WRITES consistent; it does not make
 *    a read of a missing column succeed.
 *  - the keeper and agent Workers, which bind the same database. Their
 *    package deploys migrate first too, but they carry no gate of their own
 *    yet, so their Workers Builds auto-deploy is unguarded — tracked in the
 *    follow-up issue named in the indexer README.
 *
 * `REQUIRED_D1_MIGRATIONS` (requiredMigrations.ts) is pinned to the
 * `migrations/` directory by `scripts/check-schema-gate.mjs` (part of
 * `typecheck`).
 */
import { REQUIRED_D1_MIGRATIONS } from './requiredMigrations';

export type SchemaCheck =
  | { state: 'current' }
  | { state: 'pending'; missing: string[] }
  | { state: 'unknown' };

/** The narrow D1 surface the probe needs. */
interface D1Like {
  prepare(sql: string): {
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
}

/**
 * One probe per isolate once the answer is `current` — a migration does not
 * un-apply, so the steady-state cost is a single read for the isolate's life.
 * `pending` and `unknown` are NOT cached: the next tick asks again, so ingest
 * resumes on the first tick after the migrations are applied.
 */
export function createSchemaGate(required: readonly string[] = REQUIRED_D1_MIGRATIONS) {
  let current = false;
  const check = async (db: D1Like): Promise<SchemaCheck> => {
    if (current) return { state: 'current' };
    let applied: Set<string>;
    try {
      // wrangler's default migrations table (`wrangler.jsonc` sets no
      // `migrations_table` override). One read of the whole record — a few
      // dozen rows — rather than a bound IN-list that would have to be
      // chunked under D1's parameter cap as migrations accumulate.
      const res = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
      applied = new Set((res.results ?? []).map((r) => r.name));
    } catch {
      // The migrations table itself is missing (a database never migrated by
      // wrangler) or D1 did not answer. Either way the schema is not KNOWN to
      // match this build, so the caller declines — same as `pending`, but
      // named differently so the log does not claim a migration is missing
      // when the probe simply could not tell.
      return { state: 'unknown' };
    }
    const missing = required.filter((name) => !applied.has(name));
    if (missing.length > 0) return { state: 'pending', missing };
    current = true;
    return { state: 'current' };
  };
  return { check, required };
}

/** The Worker's gate. One per isolate (module scope is per isolate). */
export const schemaGate = createSchemaGate();

/** The log line a declined pass prints — one wording for every entry point. */
export function schemaDeclineNotice(
  where: string,
  check: Exclude<SchemaCheck, { state: 'current' }>,
): string {
  if (check.state === 'unknown') {
    return (
      `[indexer] ${where} declined: could not confirm this build's D1 migrations are ` +
      `applied (the d1_migrations read failed). Retrying next tick.`
    );
  }
  const shown = check.missing.slice(0, 3).join(', ');
  const more = check.missing.length > 3 ? ` and ${check.missing.length - 3} more` : '';
  return (
    `[indexer] ${where} declined: D1 migration(s) ${shown}${more} not applied to this ` +
    `database. This build runs scheduled work only against the schema it was written ` +
    `for; apply migrations (wrangler d1 migrations apply vaipakam-warm --remote) and ` +
    `ingest resumes on the next tick.`
  );
}
