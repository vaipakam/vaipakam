#!/usr/bin/env node
/**
 * Schema-gate pin (see src/schemaGate.ts).
 *
 * The indexer's, keeper's and agent's scheduled work runs only once EVERY
 * migration this build carries is applied to the shared database, and the
 * deploy wrapper verifies the same before publishing. All of them read the
 * set from `packages/lib/src/sharedD1Migrations.json` (#2410: the shared
 * database's list, in the package every Worker depends on); this check fails
 * (exit 1) unless that list equals the `.sql` files in THIS Worker's
 * `migrations/` — the schema's one home — exactly: nothing missing, nothing
 * extra, no duplicates. So adding a migration (including one that fills a
 * numbering gap and sorts below the newest, #2409 r1) without listing it is a
 * CI failure rather than a gate that lets new code run ahead of its schema.
 *
 * The list is parsed as JSON — the same value the Worker imports — not
 * matched as text, so nothing in it can be counted that the runtime does not
 * see (#2409 r3).
 *
 * Run: `node apps/indexer/scripts/check-schema-gate.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-schema-gate`)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(root, '..', '..', 'packages', 'lib', 'src', 'sharedD1Migrations.json');
const LIST_NAME = 'packages/lib/src/sharedD1Migrations.json';
const onDisk = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

let listed;
try {
  listed = JSON.parse(readFileSync(LIST, 'utf8'));
} catch (err) {
  console.error(`check-schema-gate: ${LIST_NAME} is not valid JSON: ${err}`);
  process.exit(1);
}
if (!Array.isArray(listed) || !listed.every((x) => typeof x === 'string')) {
  console.error(`check-schema-gate: ${LIST_NAME} must be an array of filenames.`);
  process.exit(1);
}

const missing = onDisk.filter((f) => !listed.includes(f));
const extra = listed.filter((f) => !onDisk.includes(f));
const dupes = listed.filter((f, i) => listed.indexOf(f) !== i);
if (missing.length || extra.length || dupes.length) {
  if (missing.length) console.error(`check-schema-gate: not listed in ${LIST_NAME}: ${missing.join(', ')}`);
  if (extra.length) console.error(`check-schema-gate: listed but no such migration file: ${extra.join(', ')}`);
  if (dupes.length) console.error(`check-schema-gate: listed twice: ${dupes.join(', ')}`);
  process.exit(1);
}
console.log(`check-schema-gate: gate requires all ${onDisk.length} migrations.`);
