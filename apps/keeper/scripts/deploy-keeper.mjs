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
 *   3. REFUSE unless the one-time CUTOVER COPY is complete. Five of the
 *      keeper's private tables began life in the shared database, and a keeper
 *      that starts on empty or partial private copies re-sends CCIP
 *      acknowledgements it has already paid for. The copy is
 *      `scripts/keeper-cutover.mjs` (DeploymentRunbook, "Keeper private D1 —
 *      one-time cutover"), which records a marker only after EVERY table has
 *      the same fingerprint (row count, latest write time) on both sides. The
 *      deploy requires that marker whenever the shared copies hold a row, and
 *      requires every shared table to still match it — a keeper that wrote the
 *      old copies after the copy left the private side behind. With no shared
 *      rows (a fresh environment, or the old copies retired) there is nothing
 *      to move and it passes. Anything unread refuses; it is never read as
 *      "no rows". (The earlier check looked at two of the five tables and
 *      passed once the private side held one row — Codex #2489 r1.)
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
import { PRIVATE_DB, SHARED_DB, cutoverVerdict, readFingerprints, readMarker } from './lib/keeper-cutover.mjs';

export { PRIVATE_DB };
const HERE = dirname(fileURLToPath(import.meta.url));
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

/** Why the publish must wait for the cutover, or null when it need not. */
function cutoverPending() {
  const v = cutoverVerdict(readFingerprints(SHARED_DB), readMarker(PRIVATE_DB));
  return v.ok ? null : v.why;
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
