/**
 * Every D1 migration this build was written against — the schema gate
 * (schemaGate.ts) holds scheduled work until ALL of them are recorded in
 * `d1_migrations`, and the deploy wrapper (scripts/migrate-then-deploy.mjs)
 * refuses to publish until they are.
 *
 * The whole set, not only the newest: a migration that fills a gap in the
 * numbering sorts BELOW the newest, so a newest-only check would pass a
 * database that never applied it (#2409 r1).
 *
 * The list itself is `requiredMigrations.json` — JSON, so it has no comments
 * and no syntax a checker could misread (#2409 r3: a TS array let a
 * commented-out filename pass a text-matching check). A Worker bundle cannot
 * read its own migrations directory, hence a committed list;
 * `scripts/check-schema-gate.mjs` (part of `typecheck`) fails CI unless it
 * equals the `migrations/` directory exactly. Full filenames, which is what
 * wrangler records in `d1_migrations.name`.
 */
import list from './requiredMigrations.json';

export const REQUIRED_D1_MIGRATIONS: readonly string[] = list;
