#!/usr/bin/env node
/**
 * Migration sequence-number guardrail (#1441).
 *
 * `apps/indexer/migrations/` is the single source of truth for every table
 * on the shared `vaipakam-archive` D1 (CLAUDE.md, "Cloudflare D1 schema
 * discipline") — explicitly so that a fresh environment can be bootstrapped
 * by replaying it. This check protects that guarantee.
 *
 * D1 keys its applied-migrations record on the FILENAME, not on the numeric
 * prefix, so two files sharing a prefix both run and neither is skipped.
 * Nothing breaks on an environment that already applied them. What breaks
 * is REPLAY ORDER on a fresh one: `wrangler d1 migrations apply` runs
 * pending files in lexicographic order, so a colliding pair replays in
 * whatever order their SLUGS sort in — which need not be the order
 * production actually experienced. For an order-dependent pair (a column
 * add and a backfill that reads it, say) a fresh bootstrap would then
 * diverge from production, silently.
 *
 * Fails (exit 1) when two migration files share a numeric prefix, EXCEPT
 * for the pairs in `GRANDFATHERED` below.
 *
 * Run: `node apps/indexer/scripts/check-migration-prefixes.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-migration-prefixes`)
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Prefixes that already collided before this check existed, and are
 * DELIBERATELY left alone.
 *
 * Renaming a migration file changes its `d1_migrations` key, which makes it
 * re-run on every environment that already applied it. For an existing pair
 * that is strictly worse than the latent risk: a re-run `CREATE TABLE`
 * without `IF NOT EXISTS`, or any non-idempotent statement, fails the whole
 * apply. So the collision is recorded here rather than tidied away — and
 * this comment exists so nobody "fixes" it later without knowing that.
 *
 * Each entry must state why the pair is safe, which means ORDER-INDEPENDENT:
 * replaying them in either order must reach the same schema.
 */
const GRANDFATHERED = new Map([
  [
    '0011',
    'Applied to production 2026-05-08 (offers_cancelled_at) and 2026-05-24 ' +
      '(liquidity_confidence), i.e. in the reverse of lexicographic order. ' +
      'Order-independent: one is a CREATE TABLE for a table nothing else in ' +
      'the pair touches, the other an unrelated column add on `offers`. ' +
      'Renaming either would change its d1_migrations key and re-run it.',
  ],
]);

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** Group filenames by their leading numeric prefix. */
const byPrefix = new Map();
const malformed = [];
for (const file of files) {
  const match = file.match(/^(\d+)_/);
  if (!match) {
    malformed.push(file);
    continue;
  }
  const prefix = match[1];
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(file);
}

const problems = [];

for (const name of malformed) {
  problems.push(
    `  ${name}\n` +
      `      does not start with a numeric prefix followed by "_". Every ` +
      `migration needs one so replay order is well-defined.`,
  );
}

for (const [prefix, group] of [...byPrefix].sort()) {
  if (group.length < 2) continue;
  if (GRANDFATHERED.has(prefix)) continue;
  problems.push(
    `  prefix ${prefix} used by ${group.length} files:\n` +
      group.map((f) => `      ${f}`).join('\n'),
  );
}

// A grandfathered prefix that is no longer duplicated means the entry is
// stale — drop it, so the allowlist cannot quietly accumulate dead
// exemptions that would mask a genuine future collision on the same number.
for (const prefix of GRANDFATHERED.keys()) {
  const group = byPrefix.get(prefix) ?? [];
  if (group.length >= 2) continue;
  problems.push(
    `  prefix ${prefix} is allowlisted in GRANDFATHERED but is no longer ` +
      `duplicated (${group.length} file(s)). Remove the entry.`,
  );
}

if (problems.length > 0) {
  console.error(
    `\n[check-migration-prefixes] ${problems.length} problem(s) in ` +
      `apps/indexer/migrations/:\n\n${problems.join('\n')}\n\n` +
      `Two migrations sharing a numeric prefix both apply (D1 keys on the\n` +
      `filename), so nothing breaks where they have already run — but a\n` +
      `FRESH environment replays them in lexicographic order, which need\n` +
      `not match the order production experienced.\n\n` +
      `Fix: give the NEW migration the next unused number. Do not renumber\n` +
      `a migration that has already been applied anywhere — that changes\n` +
      `its d1_migrations key and re-runs it.\n`,
  );
  process.exit(1);
}

console.log(
  `[check-migration-prefixes] OK — ${files.length} migrations, ` +
    `${byPrefix.size} distinct prefixes` +
    (GRANDFATHERED.size > 0
      ? ` (${GRANDFATHERED.size} grandfathered collision(s))`
      : ''),
);
