#!/usr/bin/env node
/**
 * The deploy of every Worker that binds the shared `vaipakam-warm` D1 —
 * apps/indexer, apps/keeper and apps/agent (#2214 / #2409).
 *
 * Three steps, each gating the next:
 *
 *  1. APPLY pending migrations (apps/indexer's `migrate` script — the schema's
 *     owner, and the one place the apply is spelt). Run with stdin detached,
 *     so wrangler takes its non-interactive path and applies without a
 *     confirmation prompt: running `deploy` IS the operator's consent, and a
 *     prompt answered "no" made wrangler exit 0 having applied nothing
 *     (#2409 r3).
 *  2. VERIFY, in the database, that EVERY migration this build carries is
 *     recorded in `d1_migrations` — the same list the indexer's runtime gate
 *     reads (src/requiredMigrations.json). The outcome is checked, not the
 *     apply's exit status: any way the apply can end without applying (a
 *     declined prompt, a partial run, a wrangler that changes its behaviour)
 *     stops here, before code ships.
 *  3. DEPLOY: `wrangler deploy --keep-vars` in the CALLING Worker's directory.
 *
 * It takes NO arguments, and refuses any (#2409 r3). pnpm appends `run`
 * arguments to the end of a script, so an argument meant for wrangler would
 * arrive here — and deciding which spellings mean "do not publish"
 * (`--dry-run`, `--dry-run=true`, `--version`, `-h`, …) is an unbounded
 * predicate: the next spelling nobody listed would migrate the live database
 * on a dry run. A refusal has no such edge. A dry run is its own script,
 * `deploy:dry`, which never migrates; any other wrangler invocation is run
 * directly, after `pnpm --filter @vaipakam/indexer run migrate`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'requiredMigrations.json');

/** Whether this invocation may run at all. Any argument is refused. */
export function admit(args) {
  if (args.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `[deploy] refusing: this script takes no arguments (got: ${args.join(' ')}).\n` +
      '  It applies the shared D1 migrations, verifies them, then publishes — and an\n' +
      '  argument it would have to interpret could turn a dry run into a live migration.\n' +
      '  - Dry run (never migrates):   pnpm run deploy:dry\n' +
      '  - Anything else:              pnpm --filter @vaipakam/indexer run migrate,\n' +
      '                                then run wrangler yourself with your arguments.',
  };
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

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`[deploy] \`${cmd} ${args.join(' ')}\` failed — stopping before anything further runs.`);
    process.exit(r.status ?? 1);
  }
  return r;
}

function main() {
  const gate = admit(process.argv.slice(2));
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(2);
  }
  const required = JSON.parse(readFileSync(REQUIRED_PATH, 'utf8'));

  console.log('[deploy] 1/3 applying D1 migrations to vaipakam-warm');
  run('pnpm', ['--filter', '@vaipakam/indexer', 'run', 'migrate'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  console.log(`[deploy] 2/3 verifying all ${required.length} migrations are recorded`);
  const q = run(
    'pnpm',
    [
      '--filter', '@vaipakam/indexer', 'exec',
      'wrangler', 'd1', 'execute', 'vaipakam-warm', '--remote', '--json',
      '--command', 'SELECT name FROM d1_migrations',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' },
  );
  const missing = unapplied(q.stdout ?? '', required);
  if (missing === null) {
    console.error('[deploy] could not read d1_migrations to verify the apply — not publishing.');
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`[deploy] migrations still not applied: ${missing.join(', ')} — not publishing.`);
    process.exit(1);
  }

  console.log('[deploy] 3/3 publishing');
  run('wrangler', ['deploy', '--keep-vars'], { stdio: 'inherit' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
