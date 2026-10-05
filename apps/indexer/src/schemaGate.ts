/**
 * The D1 schema gate — scheduled work runs only against the schema this build
 * was written for.
 *
 * WHY A GATE AND NOT ONLY A DEPLOY ORDER. The deploy scripts and the package
 * `deploy` script now apply migrations BEFORE publishing the Worker, and abort
 * the publish if the apply fails. But the indexer also auto-deploys on every
 * merge through Cloudflare Workers Builds, whose deploy command is dashboard
 * configuration this repository cannot see or pin. If that route publishes
 * without migrating, the new code meets the old schema — and #1149 is what
 * that looks like: every scan failed `no such column`, the fail-closed cursor
 * held, and the stall was opaque until someone read the logs. #2214 closed the
 * same class for ONE table with a per-feature probe; every later migration
 * would need its own.
 *
 * This gate answers the question once, for every migration: has the newest
 * migration in this build been applied to the database? If not, scheduled
 * ingest and maintenance decline the tick with a named log line instead of
 * running code against a schema it was not written for. Nothing advances and
 * nothing half-writes, and ingest resumes by itself on the first tick after
 * the migration lands — no redeploy, no manual cursor repair.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied: the HTTP read API. A
 * route that reads a column the database does not have yet still fails until
 * the migration is applied; a feature adding such a read must tolerate the
 * older schema itself (or ship its read after its migration). The gate keeps
 * WRITES consistent; it does not make a read of a missing column succeed.
 *
 * `REQUIRED_D1_MIGRATION` is pinned to the highest file in `migrations/` by
 * `scripts/check-schema-gate.mjs` (part of `typecheck`), so a new migration
 * that forgets to move it fails CI rather than leaving the gate a step behind.
 */

/** The newest migration file this build was written against — its FULL
 *  filename, which is what wrangler records in `d1_migrations.name`. */
export const REQUIRED_D1_MIGRATION = '0053_quarantine_observation_token.sql';

/** wrangler's default migrations table; `wrangler.jsonc` sets no override.
 *  (The query below spells it literally so the #1149 SQL guard can see it.) */
const MIGRATIONS_TABLE = 'd1_migrations';

export type SchemaState = 'current' | 'pending' | 'unknown';

/** The narrow D1 surface the probe needs. */
interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): { first<T = unknown>(): Promise<T | null> };
  };
}

/**
 * One probe per isolate once the answer is `current` — a migration does not
 * un-apply, so the steady-state cost is a single read for the isolate's life.
 * `pending` and `unknown` are NOT cached: the next tick asks again, so ingest
 * resumes on the first tick after the migration is applied.
 */
export function createSchemaGate(required: string = REQUIRED_D1_MIGRATION) {
  let current = false;
  const check = async (db: D1Like): Promise<SchemaState> => {
    if (current) return 'current';
    try {
      const row = await db
        .prepare('SELECT name FROM d1_migrations WHERE name = ?')
        .bind(required)
        .first<{ name: string }>();
      if (row) {
        current = true;
        return 'current';
      }
      return 'pending';
    } catch {
      // The migrations table itself is missing (a database never migrated by
      // wrangler) or D1 did not answer. Either way the schema is not KNOWN to
      // match this build, so the caller declines — same as `pending`, but
      // named differently so the log does not claim a migration is missing
      // when the probe simply could not tell.
      return 'unknown';
    }
  };
  return { check, required };
}

/** The Worker's gate. One per isolate (module scope is per isolate). */
export const schemaGate = createSchemaGate();

/** The log line a declined pass prints — one wording for every entry point. */
export function schemaDeclineNotice(where: string, state: Exclude<SchemaState, 'current'>): string {
  return state === 'pending'
    ? `[indexer] ${where} declined: D1 migration ${REQUIRED_D1_MIGRATION} is not applied ` +
        `to this database. This build runs scheduled work only against the schema it ` +
        `was written for; apply migrations (wrangler d1 migrations apply vaipakam-warm ` +
        `--remote) and ingest resumes on the next tick.`
    : `[indexer] ${where} declined: could not confirm D1 migration ${REQUIRED_D1_MIGRATION} ` +
        `is applied (the ${MIGRATIONS_TABLE} read failed). Retrying next tick.`;
}
