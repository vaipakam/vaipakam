#!/usr/bin/env node
/**
 * The keeper's deploy (#2450).
 *
 * The keeper binds TWO databases, and the one-applier rule (#2409 r4) is per
 * database:
 *   - the SHARED database is the indexer's — the keeper only VERIFIES
 *     it, read-only (`deploy-shared-d1.mjs verify`);
 *   - its private `vaipakam-keeper-db` is the keeper's own — nothing else
 *     binds it, so the keeper's deploy is its ONE applier and there is no
 *     race to lose. Applying it here is what keeps a keeper migration from
 *     depending on someone remembering to run it by hand.
 *
 * So, in order:
 *   1. APPLY the private migrations (`run migrate`), non-interactively
 *      (stdin closed: running `deploy` is the consent).
 *   2. VERIFY, in the database, that every file in `migrations/` is recorded
 *      in its `d1_migrations` — the outcome, never an exit status (#2409 r3:
 *      a declined prompt exited 0 having applied nothing).
 *   3. REFUSE while the one-time CUTOVER COPY is pending. Five of the keeper's
 *      private tables began life in the shared database, and a keeper that
 *      starts on empty private copies re-sends CCIP acknowledgements it has
 *      already paid for. The copy has to land between the schema and the
 *      publish (DeploymentRunbook, "Keeper private D1 — one-time cutover"), so
 *      the deploy checks for it: a monotone cursor table that still has rows
 *      in the shared copy and NONE in the private one means the copy has not
 *      run. Both sentinels are only ever inserted or advanced, never deleted,
 *      so after the copy the private side is never empty again; once the old
 *      shared copies are dropped, there is nothing to compare and the check
 *      passes. An unreadable answer refuses — it is never read as "no rows".
 *   4. Hand over to the shared script's `verify` mode, which checks the shared
 *      schema and publishes. Its exit code is this script's.
 *
 * Takes NO arguments, for the shared script's reason (#2409 r3): an argument
 * it had to interpret could turn a dry run into a live database change. A dry
 * run is `deploy:dry`, which touches no database.
 *
 * Like every migration, a keeper migration must be ADDITIVE: it lands while
 * the old keeper is still serving, and the publish can still fail after it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unapplied } from '../../indexer/scripts/deploy-shared-d1.mjs';
import { SUCCESSOR } from '../../indexer/scripts/lib/cutover-databases.mjs';
import { PRIVATE_DATABASES } from '../../indexer/scripts/lib/d1-workers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Both names from their pinned registries, never spelled here. */
export const PRIVATE_DB = PRIVATE_DATABASES.find((d) => d.binding === 'KEEPER_DB').name;
const SHARED_DB = SUCCESSOR.name;
/** Monotone cursor tables (inserted or advanced, never deleted) that began in
 *  the shared database: their rows decide whether the cutover copy has run. */
export const CUTOVER_SENTINELS = ['keeper_remit_ack_frontier', 'keeper_commitment_scan'];
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const SHARED_DEPLOY = join(HERE, '..', '..', 'indexer', 'scripts', 'deploy-shared-d1.mjs');

/** The private migrations this build carries: every `.sql` file in
 *  `apps/keeper/migrations/`, by the file name D1 records. */
export function requiredPrivateMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Whether this invocation may run: no arguments at all. */
export function admit(args) {
  if (args.length > 0) {
    return {
      ok: false,
      message:
        `[deploy] refusing: this script takes no arguments (got: ${args.join(' ')}).\n` +
        '  An argument it would have to interpret could turn a dry run into a live\n' +
        '  database change. Dry run (never touches a database): pnpm run deploy:dry',
    };
  }
  return { ok: true };
}

const sh = (cmd, args, opts) => spawnSync(cmd, args, { shell: process.platform === 'win32', ...opts });

function readMissing(required) {
  const q = sh(
    'pnpm',
    [
      '--filter', '@vaipakam/keeper', 'exec',
      'wrangler', 'd1', 'execute', PRIVATE_DB, '--remote', '--json',
      '--command', 'SELECT name FROM d1_migrations',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  if (q.status !== 0) return null;
  return unapplied(q.stdout ?? '', required);
}

/** One `SELECT` on `db` through wrangler, its result rows, or `null` when the
 *  read failed or its output could not be parsed. */
function query(db, sql) {
  const q = sh(
    'pnpm',
    ['--filter', '@vaipakam/keeper', 'exec', 'wrangler', 'd1', 'execute', db, '--remote', '--json', '--command', sql],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  if (q.status !== 0) return null;
  const out = q.stdout ?? '';
  const start = out.indexOf('[');
  if (start < 0) return null;
  try {
    const rows = JSON.parse(out.slice(start))?.[0]?.results;
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** The cutover verdict from the two counts — pure, for the tests. `shared` is
 *  `undefined` when the shared table no longer exists (old copies retired). */
export function cutoverVerdict(table, shared, priv) {
  if (shared === undefined || shared === 0) return { ok: true };
  if (shared === null || priv === null) return { ok: false, why: `could not read ${table}'s row counts` };
  if (priv === 0) {
    return {
      ok: false,
      why:
        `${table} holds ${shared} row(s) in the shared database and none in ${PRIVATE_DB}: ` +
        'the one-time cutover copy has not run (DeploymentRunbook, "Keeper private D1 — one-time cutover").',
    };
  }
  return { ok: true };
}

function count(db, table) {
  const rows = query(db, `SELECT COUNT(*) AS n FROM ${table}`);
  if (rows === null || rows.length !== 1) return null;
  const n = Number(rows[0]?.n);
  return Number.isFinite(n) ? n : null;
}

function cutoverPending() {
  const names = CUTOVER_SENTINELS.map((t) => `'${t}'`).join(', ');
  const present = query(SHARED_DB, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names})`);
  if (present === null) return `could not read ${SHARED_DB}'s table list`;
  const inShared = new Set(present.map((r) => r?.name));
  for (const table of CUTOVER_SENTINELS) {
    const shared = inShared.has(table) ? count(SHARED_DB, table) : undefined;
    const priv = shared === undefined || shared === 0 ? 0 : count(PRIVATE_DB, table);
    const v = cutoverVerdict(table, shared, priv);
    if (!v.ok) return v.why;
  }
  return null;
}

function main() {
  const gate = admit(process.argv.slice(2));
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(2);
  }
  const required = requiredPrivateMigrations();

  console.log(`[deploy] applying D1 migrations to ${PRIVATE_DB} (this Worker owns that schema)`);
  const a = sh('pnpm', ['--filter', '@vaipakam/keeper', 'run', 'migrate'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (a.status !== 0) {
    console.error(`[deploy] the apply to ${PRIVATE_DB} failed — not publishing.`);
    process.exit(1);
  }

  console.log(`[deploy] verifying all ${required.length} private migrations are recorded`);
  const missing = readMissing(required);
  if (missing === null) {
    console.error(`[deploy] could not read ${PRIVATE_DB}'s d1_migrations to verify — not publishing.`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`[deploy] private migrations not applied: ${missing.join(', ')} — not publishing.`);
    process.exit(1);
  }

  const pending = cutoverPending();
  if (pending !== null) {
    console.error(`[deploy] ${pending} — not publishing.`);
    process.exit(1);
  }

  // The shared schema (verified, never applied here) and the publish.
  const d = sh('node', [SHARED_DEPLOY, 'verify'], { stdio: 'inherit' });
  process.exit(d.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
