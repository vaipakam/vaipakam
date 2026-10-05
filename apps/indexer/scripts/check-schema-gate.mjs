#!/usr/bin/env node
/**
 * Schema-gate pin (see src/schemaGate.ts).
 *
 * The indexer's scheduled work runs only once EVERY migration this build
 * carries is applied to the database. The gate reads that set from
 * `src/requiredMigrations.ts`; this check fails (exit 1) unless the list
 * equals the `.sql` files in `migrations/` exactly — nothing missing, nothing
 * extra. So adding a migration (including one that fills a numbering gap and
 * sorts below the newest, #2409 r1) without listing it is a CI failure rather
 * than a gate that lets new code run ahead of its schema.
 *
 * Run: `node apps/indexer/scripts/check-schema-gate.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-schema-gate`)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const onDisk = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

const src = readFileSync(join(root, 'src', 'requiredMigrations.ts'), 'utf8');
const block = src.match(/REQUIRED_D1_MIGRATIONS[^=]*=\s*\[([\s\S]*?)\]/);
if (!block) {
  console.error('check-schema-gate: REQUIRED_D1_MIGRATIONS not found in src/requiredMigrations.ts');
  process.exit(1);
}
const listed = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const missing = onDisk.filter((f) => !listed.includes(f));
const extra = listed.filter((f) => !onDisk.includes(f));
const dupes = listed.filter((f, i) => listed.indexOf(f) !== i);
if (missing.length || extra.length || dupes.length) {
  if (missing.length) console.error(`check-schema-gate: not listed in src/requiredMigrations.ts: ${missing.join(', ')}`);
  if (extra.length) console.error(`check-schema-gate: listed but no such migration file: ${extra.join(', ')}`);
  if (dupes.length) console.error(`check-schema-gate: listed twice: ${dupes.join(', ')}`);
  process.exit(1);
}
console.log(`check-schema-gate: gate requires all ${onDisk.length} migrations.`);
