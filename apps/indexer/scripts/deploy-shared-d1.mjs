#!/usr/bin/env node
/**
 * The deploy of every Worker that binds the shared `vaipakam-warm` D1 —
 * apps/indexer, apps/keeper and apps/agent (#2214 / #2409).
 *
 * ONE APPLIER (#2409 r4). The indexer owns the schema (every migration lives
 * in apps/indexer/migrations/), so only the indexer's deploy APPLIES
 * migrations. The keeper's and agent's deploys only READ the record, and
 * report whether the schema their code was built against is in place
 * (#3115: they publish either way). An earlier revision
 * had all three apply; three Workers Builds starting from one schema-changing
 * merge then raced to apply the same migration, and the losers aborted before
 * publishing — a partial release. With one applier there is no race between
 * the Workers, and a keeper or agent deploy never mutates the shared database.
 *
 *   node deploy-shared-d1.mjs apply    — the indexer's `deploy`
 *     1. apply pending migrations, non-interactively (running `deploy` is the
 *        consent; a declined prompt made wrangler exit 0 having applied
 *        nothing, #2409 r3). If the apply fails, WAIT (bounded) for the
 *        schema before failing: a concurrent indexer deploy may be applying
 *        the same migrations.
 *     2. verify, in the database, that EVERY migration this build carries is
 *        recorded (packages/lib/src/sharedD1Migrations.json — the list every
 *        Worker's runtime gate reads, #2410). The outcome is checked, not an exit status.
 *     3. publish.
 *
 *   node deploy-shared-d1.mjs verify   — the keeper's and agent's `deploy`
 *     1. read the same record ONCE, read-only, and REPORT it: every migration
 *        recorded, or a warning naming the ones still pending (or saying the
 *        record could not be read). It never waits and never refuses (#3115).
 *     2. publish.
 *
 * WHY `verify` DOES NOT WAIT (#3115). Cloudflare Workers Builds runs one build
 * at a time on this account. A keeper or agent build that waited for the
 * indexer's migrations held the only build slot while the indexer build that
 * would apply them sat queued behind it, so on any merge that changed the
 * schema the wait timed out and the Worker was left on its previous version
 * (the agent build for a68b4baa8). A longer wait only holds the slot longer.
 * Publishing first is safe because the schema is guarded where the code
 * RUNS, not here: every scheduled runner of the shared database declines
 * its ticks by name until every migration this build carries is recorded
 * (`@vaipakam/lib/d1SchemaGate`, #2410) and resumes by itself once the
 * indexer's deploy applies them; every migration is additive
 * (check-migration-additivity.mjs), so the old schema never breaks new code
 * that tolerates it; and every HTTP route must tolerate the previous schema
 * already, because the Workers Builds deploy command is not pinned by this
 * repository. The indexer stays the only applier, so nothing reintroduces
 * the three-applier race (#2409 r4).
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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyRetiredDeployment, readRetiredDeploymentsFile, retiredDeploymentsFromManifest } from './lib/retiredDeploymentSeed.mjs';
import { deployStamp, wranglerDeploy } from '@vaipakam/lib/deployStamp';

/** apps/indexer — where wrangler.jsonc lives and every wrangler call runs. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_PATH = join(ROOT, '..', '..', 'packages', 'lib', 'src', 'sharedD1Migrations.json');

/** How long the indexer's deploy waits, after its own apply FAILED, for a
 *  concurrent indexer deploy to finish the same migrations. `verify` mode
 *  never waits (#3115). */
export const APPLY_WAIT_MS = 10 * 60 * 1000;
export const APPLY_POLL_MS = 20 * 1000;
/** The longest one read of `d1_migrations` may take. */
export const READ_TIMEOUT_MS = 60 * 1000;

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
    // Bounded: a read that hangs must not hold the build slot. A killed read
    // has a null status and counts as unreadable.
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: READ_TIMEOUT_MS },
  );
  if (q.status !== 0) return null;
  return unapplied(q.stdout ?? '', required);
}

/** Whether the `apply` verification polls to a deadline (rather than reading
 *  once): only after a failed apply, when a concurrent indexer deploy may be
 *  part-way through the same migrations (#2409 r7). */
export const waitsForSchema = (applyOk) => !applyOk;

/** A verification that answered with nothing missing. */
export const isSettled = (missing) => Array.isArray(missing) && missing.length === 0;

/**
 * What a `verify` deploy (keeper, agent) says about the shared schema it
 * read once, before it publishes anyway (#3115). `missing` is `unapplied`'s
 * answer: the pending migrations, or `null` when the record could not be
 * read — reported as unknown, never as current.
 */
export function verifyReport(missing) {
  if (isSettled(missing)) {
    return { level: 'ok', message: '[deploy] every migration this build carries is recorded' };
  }
  const what =
    missing === null
      ? 'could not read d1_migrations, so whether this build\'s migrations are applied is UNKNOWN'
      : `migrations not applied yet: ${missing.join(', ')}`;
  return {
    level: 'warn',
    message:
      `[deploy] WARNING: ${what}.\n` +
      '  Publishing anyway (#3115): this Worker\'s scheduled work declines each tick, by name,\n' +
      '  until the indexer\'s deploy applies them (d1SchemaGate), and resumes by itself.\n' +
      '  The indexer owns the schema; if its deploy is not queued, run\n' +
      '  pnpm --filter @vaipakam/indexer run deploy.',
  };
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

  if (gate.mode === 'verify') {
    // One read, then publish whatever it says (#3115): waiting here would hold
    // the account's only Workers Builds slot while the indexer build that
    // applies the migrations is queued behind it. The runtime gate, not this
    // script, keeps the new code's scheduled work off an older schema.
    console.log(`[deploy] reading the shared schema record (${required.length} migrations; read-only, no wait)`);
    const report = verifyReport(readMissing(required));
    (report.level === 'ok' ? console.log : console.warn)(report.message);
  } else {
    // Apply, then verify. WAIT for the schema, polling to a bounded deadline,
    // only after a failed apply — a concurrent indexer deploy may be part-way
    // through the same migrations, and a single re-read would abort while it
    // finishes (#2409 r7). A clean apply checks once.
    console.log('[deploy] applying D1 migrations to vaipakam-warm (this Worker owns the schema)');
    const a = sh('pnpm', ['--filter', '@vaipakam/indexer', 'run', 'migrate'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const applyOk = a.status === 0;
    if (!applyOk) {
      console.error('[deploy] the apply failed — waiting to see whether a concurrent deploy completes the migrations');
    }
    const wait = waitsForSchema(applyOk);

    console.log(`[deploy] verifying all ${required.length} migrations are recorded`);
    const deadline = Date.now() + (wait ? APPLY_WAIT_MS : 0);
    let missing = readMissing(required);
    // An UNREADABLE result (null) waits too (#2409 r5): a transient read
    // failure is not an answer. The indexer still refuses to publish if the
    // deadline passes without a clean verification: it is the applier, so a
    // schema it could not confirm is its own failure.
    while (wait && !isSettled(missing) && Date.now() < deadline) {
      console.log(
        missing === null
          ? '[deploy] could not read d1_migrations yet — retrying'
          : `[deploy] waiting for the migrations to land: ${missing.join(', ')}`,
      );
      sleep(APPLY_POLL_MS);
      missing = readMissing(required);
    }
    if (missing === null) fail('[deploy] could not read d1_migrations to verify the schema — not publishing.');
    if (missing.length > 0) fail(`[deploy] migrations not applied: ${missing.join(', ')} — not publishing.`);

    // Retired deployments are SEEDED here, after the schema is verified current
    // and BEFORE the publish (Codex #2545 r3): the only moment the table is
    // guaranteed to exist and the new code is guaranteed not to be running. A
    // seed that cannot land stops the deploy — publishing first would let the
    // new Worker's first pass adopt the new Diamond blind, and a later seed
    // would then have to correct it (it can, but only while that row is blind).
    // The entries come from the committed archive manifest (r6), so every
    // deploy of the merged tree seeds what the repository records.
    seedRetiredDeployments();
  }

  // The commit this build came from, recorded on the deployment so the
  // deploy-lag check reads it back instead of inferring it (#2242).
  // The publish runs in the CALLER's directory, never ROOT: the agent and the
  // keeper run this script from apps/agent and apps/keeper (`verify`), and
  // each publishes its own Worker from its own wrangler config. ROOT is the
  // indexer's, and only the migration and seed steps above belong to it.
  const stamp = deployStamp();
  console.log(`[deploy] publishing — ${'reason' in stamp ? `commit NOT recorded: ${stamp.reason}` : stamp.message}`);
  // Wrangler's own entry, without a shell, so the stamp's message stays one
  // argument on Windows too (wranglerDeploy).
  const d = wranglerDeploy(['--keep-vars'], { stamp });
  if (d.status !== 0) process.exit(d.status ?? 1);
}

/**
 * The retired Diamonds the COMMITTED archive manifest records for the chains
 * the live bundle names (Codex #2545 r6: nothing untracked decides this —
 * a deploy from a clean checkout seeds exactly what the repository says),
 * plus any `INDEXER_RETIRED_DEPLOYMENTS_FILE` adds. Idempotent per entry.
 */
function seedRetiredDeployments() {
  const entries = retiredDeploymentsFromManifest();
  const file = process.env.INDEXER_RETIRED_DEPLOYMENTS_FILE;
  if (file) {
    if (!existsSync(file)) fail(`[deploy] INDEXER_RETIRED_DEPLOYMENTS_FILE names a missing file: ${file} — not publishing.`);
    for (const e of readRetiredDeploymentsFile(file)) {
      if (!entries.some((x) => x.chainId === e.chainId && x.diamond.toLowerCase() === e.diamond.toLowerCase())) entries.push(e);
    }
  }
  if (entries.length === 0) {
    console.log('[deploy] no retired deployment recorded for a live chain — nothing to seed');
    return;
  }
  console.log(`[deploy] seeding ${entries.length} retired deployment(s) for the indexer's epoch reset`);
  for (const e of entries) {
    const r = applyRetiredDeployment(e, { cwd: ROOT });
    if (!r.ok) fail(`[deploy] could not seed retired Diamond ${e.diamond} for chainId=${e.chainId} — not publishing.\n  ${r.output.trim()}`);
    console.log(`  ✓ chainId=${e.chainId}: retired Diamond ${e.diamond} (deploy block ${e.deployBlock}) recorded`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
