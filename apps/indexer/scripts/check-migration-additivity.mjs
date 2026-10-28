#!/usr/bin/env node
/**
 * Additive-migration guardrail for the D1 databases (#2412).
 *
 * Every file in `apps/indexer/migrations/` (the shared database) and in
 * `apps/keeper/migrations/` (the keeper's private one) is applied while the
 * previous Workers are still serving (#2214 / #2409 / #2450), so each must be
 * additive:
 * expand/contract. The rule and what it counts as destructive live in
 * `lib/migration-additivity.mjs`, which reads the SQL through a lexer rather
 * than matching raw text.
 *
 * A destructive migration is allowed only as the CONTRACT step of a
 * coordinated two-step release, when the step before it has already stopped
 * every deployed reader and writer. Such a migration is listed in
 * `CONTRACT_STEPS` below with the exact destructive statements it carries and
 * why the deployed code no longer needs what it removes. The list is exact in
 * both directions: an unlisted destructive statement fails, and so does an
 * entry whose file is gone or whose statements no longer match.
 *
 * Run: `node apps/indexer/scripts/check-migration-additivity.mjs`
 *      (part of `pnpm --filter @vaipakam/indexer typecheck`)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { destructiveStatements } from './lib/migration-additivity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATION_DIRS = ['apps/indexer/migrations', 'apps/keeper/migrations'];

/**
 * Contract steps: destructive migrations whose expand step already shipped.
 * `statements` is the exact normalized form the lexer produces, so adding a
 * further destructive statement to a listed file still fails.
 */
const CONTRACT_STEPS = new Map([
  [
    'apps/indexer/migrations/0064_retire_shared_keeper_tables.sql',
    {
      issue: '#2560',
      why:
        'Drops the shared copies of five keeper tables after #2450 moved them to ' +
        "the keeper's private database; no deployed code reads or writes the " +
        "copies, and the keeper's old cutover check reads a missing table as retired.",
      statements: [
        'DROP TABLE IF EXISTS HF_BAND_STATE',
        'DROP TABLE IF EXISTS KEEPER_COMMITMENT_SCAN',
        'DROP TABLE IF EXISTS KEEPER_COMMITMENT_DAY',
        'DROP TABLE IF EXISTS KEEPER_REMIT_ACK',
        'DROP TABLE IF EXISTS KEEPER_REMIT_ACK_FRONTIER',
      ],
    },
  ],
  [
    'apps/indexer/migrations/0075_protocol_config_drop_master_flags.sql',
    {
      issue: '#2840',
      why:
        'Drops the retired getMasterFlags columns after #2839 stopped reading them. ' +
        'The serving build still named them in a fail-open snapshot upsert; the ' +
        'migration header states that window.',
      statements: [
        'ALTER TABLE PROTOCOL_CONFIG DROP COLUMN MASTER_FLAGS_JSON',
        'ALTER TABLE PROTOCOL_CONFIG DROP COLUMN MASTER_FLAGS_NAMES_JSON',
      ],
    },
  ],
  [
    'apps/indexer/migrations/0077_drop_prenotify_scan_cursor.sql',
    {
      issue: '#2838',
      why:
        'Drops the pre-notify scan cursor 0073 replaced, once no deployed agent ' +
        'read it (checked 2026-10-26).',
      statements: ['DROP TABLE IF EXISTS PRENOTIFY_SCAN_CURSOR'],
    },
  ],
  [
    'apps/indexer/migrations/0079_drop_recycle_day_backfill.sql',
    {
      issue: '#2937',
      why:
        'Drops a table nothing ever wrote, after step 1 of #2937 removed every ' +
        'reader and registration.',
      statements: ['DROP TABLE IF EXISTS RECYCLE_DAY_BACKFILL'],
    },
  ],
]);

const problems = [];
const files = MIGRATION_DIRS.flatMap((dir) =>
  readdirSync(join(REPO_ROOT, dir))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `${dir}/${f}`),
);

for (const file of files) {
  let found;
  try {
    found = destructiveStatements(readFileSync(join(REPO_ROOT, file), 'utf8'));
  } catch (e) {
    problems.push(`${file}: cannot be read as SQL (${e.message})`);
    continue;
  }
  const listed = CONTRACT_STEPS.get(file);
  if (!listed) {
    for (const { reason, statement } of found) {
      problems.push(`${file}: ${reason} — \`${statement}\``);
    }
    continue;
  }
  const actual = found.map((f) => f.statement).sort();
  const expected = [...listed.statements].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(
      `${file}: its destructive statements no longer match its CONTRACT_STEPS entry ` +
        `(found ${JSON.stringify(actual)}, listed ${JSON.stringify(expected)})`,
    );
  }
}

for (const file of CONTRACT_STEPS.keys()) {
  if (!files.includes(file)) {
    problems.push(`CONTRACT_STEPS lists ${file}, which does not exist — remove the entry`);
  }
}

if (problems.length > 0) {
  console.error('[check-migration-additivity] FAILED\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nA shared migration lands while the previous Workers are still serving, so it\n' +
      'must be additive. To remove or re-shape something, ship a release that stops\n' +
      'every reader and writer first, then land the removal as its own migration and\n' +
      'list it in CONTRACT_STEPS with its issue and why the deployed code no longer\n' +
      'needs it (CLAUDE.md, "Cloudflare D1 schema discipline").',
  );
  process.exit(1);
}

console.log(
  `[check-migration-additivity] OK — ${files.length} migrations, ` +
    `${CONTRACT_STEPS.size} listed contract step(s), no other destructive statement`,
);
