#!/usr/bin/env node
/**
 * Schema-gate pin (see src/schemaGate.ts).
 *
 * The indexer's scheduled work runs only once the NEWEST migration this build
 * carries is applied to the database. The gate names that migration in
 * `REQUIRED_D1_MIGRATION`; this check fails (exit 1) unless it equals the
 * lexicographically highest file in `migrations/` — the last one wrangler
 * applies — so adding a migration without moving the gate is a CI failure
 * rather than a gate that silently lets new code run a step ahead of its
 * schema.
 *
 * Run: `node apps/indexer/scripts/check-schema-gate.mjs`
 *      (or `pnpm --filter @vaipakam/indexer check-schema-gate`)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();
const newest = files[files.length - 1];

const src = readFileSync(join(root, 'src', 'schemaGate.ts'), 'utf8');
const m = src.match(/export const REQUIRED_D1_MIGRATION = '([^']+)';/);
if (!m) {
  console.error('check-schema-gate: REQUIRED_D1_MIGRATION not found in src/schemaGate.ts');
  process.exit(1);
}
if (m[1] !== newest) {
  console.error(
    `check-schema-gate: REQUIRED_D1_MIGRATION is '${m[1]}' but the newest migration is ` +
      `'${newest}'. Move the gate to the new migration in src/schemaGate.ts.`,
  );
  process.exit(1);
}
console.log(`check-schema-gate: gate pinned to ${newest}.`);
