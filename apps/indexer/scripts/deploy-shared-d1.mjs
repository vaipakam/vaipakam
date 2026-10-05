#!/usr/bin/env node
/**
 * The deploy of every Worker that binds the shared `vaipakam-warm` D1 —
 * apps/indexer, apps/keeper and apps/agent (#2214 / #2409).
 *
 * ONE APPLIER (#2409 r4). The indexer owns the schema (every migration lives
 * in apps/indexer/migrations/), so only the indexer's deploy APPLIES
 * migrations. The keeper's and agent's deploys only VERIFY, read-only, that
 * the schema their code was built against is in place. An earlier revision
 * had all three apply; three Workers Builds starting from one schema-changing
 * merge then raced to apply the same migration, and the losers aborted before
 * publishing — a partial release. With one applier there is no race between
 * the Workers, and a keeper or agent deploy never mutates the shared database.
 *
 *   node deploy-shared-d1.mjs apply    — the indexer's `deploy`
 *     1. apply pending migrations, non-interactively (running `deploy` is the
 *        consent; a declined prompt made wrangler exit 0 having applied
 *        nothing, #2409 r3). If the apply fails, re-verify before failing: a
 *        concurrent indexer deploy may have applied the same migrations.
 *     2. verify, in the database, that EVERY migration this build carries is
 *        recorded (src/requiredMigrations.json — the list the runtime gate
 *        reads). The outcome is checked, not an exit status.
 *     3. publish.
 *
 *   node deploy-shared-d1.mjs verify   — the keeper's and agent's `deploy`
 *     1. verify the same way, read-only. If migrations are still pending,
 *        wait (bounded) for the indexer's deploy to apply them — the
 *        concurrent-Workers-Builds case — then refuse rather than publish
 *        code onto a schema it was not written for.
 *     2. publish.
 *
 * The mode is fixed by each package's `deploy` script. Anything after it is
 * REFUSED (#2409 r3): pnpm appends `run` arguments to the end of a script, and
 * deciding which spellings mean "do not publish" (`--dry-run`,
 * `--dry-run=true`, `--version`, …) is an unbounded predicate whose next
 * unlisted spelling would touch the live database on a dry run. A dry run is
 * its own script, `deploy:dry`, which never touches the database.
 *
 * WHAT ORDERING DOES NOT MAKE SAFE (#2409 r4): migrations land while the OLD
 * Workers are still serving, and a publish can still fail after its apply. So
 * every migration must be compatible with the code already deployed —
 * additive (expand / contract). A destructive change (a dropped or renamed
 * column, a tightened constraint) needs a coordinated two-step release, not
 * this script. Stated in CLAUDE.md's D1 schema discipline section.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'requiredMigrations.json');

/** How long a `verify` deploy waits for the indexer's deploy to apply. */
export const VERIFY_WAIT_MS = 10 * 60 * 1000;
export const VERIFY_POLL_MS = 20 * 1000;

const USAGE =
  '  - Dry run (never touches the database):  pnpm run deploy:dry\n' +
  '  - Anything else: apply migrations through the indexer\'s deploy (or\n' +
  '    pnpm --filter @vaipakam/indexer run migrate), then run wrangler yourself.';

/** Whether this invocation may run, and in which mode. The mode comes from
 *  the package script; any further argument is refused. */
export function admit(args) {
  const [mode, ...rest] = args;
  if (mode !== 'apply' && mode !== 'verify') {
    return { ok: false, message: `[deploy] internal: unknown mode "${mode ?? ''}" (expected apply | verify).` };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      message:
        `[deploy] refusing: this script takes no arguments (got: ${rest.join(' ')}).\n` +
        '  An argument it would have to interpret could turn a dry run into a live\n' +
        '  database change.\n' +
        USAGE,
    };
  }
  return { ok: true, mode };
}

/**
 * The required migrations NOT recorded in the database, from the JSON that
 * `wrangler d1 execute --json` printed. `null` when that output cannot be
 * read — treated as a failure by the caller, never as "nothing missing".
 */
export function unapplied(stdout, required) {
  const start = stdout.indexOf('[');
  if (start < 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(rows)) return null;
  const have = new Set(rows.map((r) => r?.name));
  return required.filter((n) => !have.has(n));
}

const sh = (cmd, args, opts) => spawnSync(cmd, args, { shell: process.platform === 'win32', ...opts });

function readMissing(required) {
  const q = sh(
    'pnpm',
    [
      '--filter', '@vaipakam/indexer', 'exec',
      'wrangler', 'd1', 'execute', 'vaipakam-warm', '--remote', '--json',
      '--command', 'SELECT name FROM d1_migrations',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  if (q.status !== 0) return null;
  return unapplied(q.stdout ?? '', required);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  const gate = admit(process.argv.slice(2));
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(2);
  }
  const required = JSON.parse(readFileSync(REQUIRED_PATH, 'utf8'));

  if (gate.mode === 'apply') {
    console.log('[deploy] applying D1 migrations to vaipakam-warm (this Worker owns the schema)');
    const a = sh('pnpm', ['--filter', '@vaipakam/indexer', 'run', 'migrate'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (a.status !== 0) {
      // A concurrent indexer deploy may have applied the same migrations
      // between this one's read and its write. Give it a moment, then judge
      // by the database rather than by this process's exit status.
      console.error('[deploy] the apply failed — re-checking whether the migrations are in place anyway');
      sleep(VERIFY_POLL_MS);
    }
  }

  console.log(`[deploy] verifying all ${required.length} migrations are recorded`);
  const deadline = Date.now() + (gate.mode === 'verify' ? VERIFY_WAIT_MS : 0);
  let missing = readMissing(required);
  while (gate.mode === 'verify' && missing !== null && missing.length > 0 && Date.now() < deadline) {
    console.log(`[deploy] waiting for the indexer's deploy to apply: ${missing.join(', ')}`);
    sleep(VERIFY_POLL_MS);
    missing = readMissing(required);
  }
  if (missing === null) fail('[deploy] could not read d1_migrations to verify the schema — not publishing.');
  if (missing.length > 0) {
    fail(
      `[deploy] migrations not applied: ${missing.join(', ')} — not publishing.\n` +
        (gate.mode === 'verify'
          ? '  The indexer owns the schema: deploy it first (pnpm --filter @vaipakam/indexer run deploy).'
          : ''),
    );
  }

  console.log('[deploy] publishing');
  const d = sh('wrangler', ['deploy', '--keep-vars'], { stdio: 'inherit' });
  if (d.status !== 0) process.exit(d.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
