/**
 * The shared-D1 schema gate (#2410): scheduled work runs only against the
 * schema its build was written for.
 *
 * Three Workers bind the one shared database (`vaipakam-warm`): the indexer,
 * the keeper and the agent. The indexer OWNS its schema — `apps/indexer/
 * migrations/` is the only migrations directory, and the indexer's deploy is
 * the only applier (CLAUDE.md, "Cloudflare D1 schema discipline"). But all
 * three auto-deploy on merge through Cloudflare Workers Builds, whose deploy
 * command is dashboard configuration this repository cannot pin, and the
 * keeper also runs on a machine whose release is a pull and a restart. If any
 * route publishes code that uses a new column before the migration landed,
 * that code meets the old schema — #1149's `no such column` stall.
 *
 * So each Worker asks the database the same question before its scheduled
 * work: is EVERY migration this build carries recorded as applied? If not,
 * the work declines with a line naming what is missing, and resumes by itself
 * on the first tick after the migrations land. Nothing advances and nothing
 * half-writes.
 *
 * The WHOLE set, not the newest file (#2409 r1): a migration that fills a gap
 * in the numbering sorts below the newest, and a newest-only check would pass
 * a database that never applied it.
 *
 * THE LIST. `sharedD1Migrations.json` beside this file is every migration in
 * `apps/indexer/migrations/`. It lives here, in the package all three Workers
 * already depend on, because it is the shared database's contract, not one
 * Worker's; the directory it describes stays the indexer's.
 * `apps/indexer/scripts/check-schema-gate.mjs` (part of the indexer's
 * `typecheck`) fails CI unless the list equals that directory exactly, so a
 * migration cannot be added without listing it. JSON, not a TS array, so no
 * commented-out entry can pass a check the runtime would not see (#2409 r3).
 * Full filenames, which is what wrangler records in `d1_migrations.name`.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied:
 *  - HTTP. A gate holds SCHEDULED work only. Every `fetch()` handler runs
 *    against whatever schema the database has, so a handler that reads or
 *    writes a new column must tolerate the previous schema itself.
 *  - a migration INCOMPATIBLE with the code already deployed. Migrations land
 *    while old Workers are still serving, so each must be additive
 *    (expand / contract); ordering does not make a destructive change safe.
 *  - the keeper's PRIVATE database, which has its own migrations and its own
 *    gate (`apps/keeper/host/privateDbGate.ts`).
 */
import list from './sharedD1Migrations.json';

/** Every migration of the shared database this build was written against. */
export const SHARED_D1_MIGRATIONS: readonly string[] = list;

export type SchemaCheck =
  | { state: 'current' }
  | { state: 'pending'; missing: string[] }
  | { state: 'unknown' };

/** The narrow D1 surface the probe needs. */
export interface D1Like {
  prepare(sql: string): {
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
}

/**
 * One probe per isolate (or process) once the answer is `current` — a
 * migration does not un-apply, so the steady-state cost is a single read for
 * its life. `pending` and `unknown` are NOT cached: the next tick asks again,
 * so work resumes on the first tick after the migrations are applied.
 */
export function createSchemaGate(required: readonly string[] = SHARED_D1_MIGRATIONS) {
  let current = false;
  const check = async (db: D1Like): Promise<SchemaCheck> => {
    if (current) return { state: 'current' };
    let applied: Set<string>;
    try {
      // wrangler's default migrations table (the indexer's `wrangler.jsonc`
      // sets no `migrations_table` override). One read of the whole record —
      // a few dozen rows — rather than a bound IN-list that would have to be
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

/** The log line a declined pass prints — one wording for every Worker and
 *  entry point, so an operator searching the logs finds every decline. */
export function schemaDeclineNotice(
  worker: string,
  where: string,
  check: Exclude<SchemaCheck, { state: 'current' }>,
): string {
  if (check.state === 'unknown') {
    return (
      `[${worker}] ${where} declined: could not confirm this build's D1 migrations are ` +
      `applied (the d1_migrations read failed). Retrying next tick.`
    );
  }
  const shown = check.missing.slice(0, 3).join(', ');
  const more = check.missing.length > 3 ? ` and ${check.missing.length - 3} more` : '';
  return (
    `[${worker}] ${where} declined: D1 migration(s) ${shown}${more} not applied to this ` +
    `database. This build runs scheduled work only against the schema it was written ` +
    `for; the indexer's deploy applies migrations (wrangler d1 migrations apply ` +
    `vaipakam-warm --remote), and the work resumes on the next tick.`
  );
}
