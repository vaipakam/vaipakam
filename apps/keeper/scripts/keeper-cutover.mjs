#!/usr/bin/env node
/**
 * The keeper private D1 one-time cutover copy (#2450; scripted in #2489 after
 * Codex round 1). Run it ONCE, with the keeper stopped, right before the first
 * deploy of a keeper that reads `KEEPER_DB`:
 *
 *   pnpm --filter @vaipakam/keeper run cutover
 *
 * It copies the five keeper tables that began life in the shared database into
 * the private one, checks every table, and only then records the completion
 * marker the keeper's deploy requires (`scripts/deploy-keeper.mjs`). In order:
 *
 *   1. REFUSE if a cutover is already recorded. Re-running over a live private
 *      database would replace the new keeper's state with the old copies. A
 *      deliberate re-run (after a rollback to the shared copies) deletes the
 *      marker first — DeploymentRunbook, "Keeper private D1 — one-time
 *      cutover".
 *   2. FINGERPRINT the shared copies (row count and latest write time per
 *      table). Nothing to move — no table holds a row — ends here: the deploy
 *      passes a fresh environment without a marker.
 *   3. EXPORT each table from the shared database (data only), EMPTY the five
 *      private tables, and IMPORT each export. Emptying first makes a re-run
 *      after a partial import exact rather than a duplicate-key failure.
 *   4. VERIFY: every table's fingerprint is the same on both sides, and the
 *      shared side's is unchanged since step 2. A partial import has the wrong
 *      count; a keeper still writing the old copies moves its time. Either
 *      fails here, with no marker written.
 *   5. RECORD the marker (the shared fingerprints) and read it back.
 *
 * The export files hold keeper operational state; they are written to a
 * private temporary directory and removed however the run ends.
 *
 * Takes NO arguments, like the deploy: nothing it would have to interpret can
 * change which database it writes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CUTOVER_TABLES,
  PRIVATE_DB,
  SHARED_DB,
  copyVerdict,
  query,
  readFingerprints,
  readMarker,
} from './lib/keeper-cutover.mjs';

const sh = (cmd, args, opts) => spawnSync(cmd, args, { shell: process.platform === 'win32', ...opts });
const wrangler = (args) =>
  sh('pnpm', ['--filter', '@vaipakam/keeper', 'exec', 'wrangler', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

/** A refusal. Thrown, never `process.exit` — an exit would skip the `finally`
 *  that removes the export files. */
class CutoverRefused extends Error {}
function fail(message) {
  throw new CutoverRefused(message);
}

/** Whether every table has a readable fingerprint (an object) on that side. */
const readable = (fp) => CUTOVER_TABLES.every(({ table }) => fp[table] !== null && fp[table] !== undefined);

function main() {
  if (process.argv.length > 2) {
    console.error(`[cutover] refusing: this script takes no arguments (got: ${process.argv.slice(2).join(' ')}).`);
    process.exit(2);
  }
  try {
    run();
  } catch (err) {
    if (!(err instanceof CutoverRefused)) throw err;
    console.error(`[cutover] ${err.message}`);
    process.exitCode = 1;
  }
}

function run() {
  // 1. Never over a recorded cutover.
  const marker = readMarker();
  if (marker === null) {
    fail(
      `could not read ${PRIVATE_DB}'s cutover record. Apply the private schema first: ` +
        '`pnpm --filter @vaipakam/keeper run migrate`.',
    );
  }
  if (marker !== 'none') {
    fail(
      `a cutover is already recorded in ${PRIVATE_DB} (at ${new Date(marker.completedAt * 1000).toISOString()}). ` +
        'Nothing was changed. A deliberate re-run follows the runbook: delete that record first.',
    );
  }

  // 2. What is there to move.
  const before = readFingerprints(SHARED_DB);
  if (!readable(before)) fail(`could not read every table's fingerprint in ${SHARED_DB}: ${JSON.stringify(before)}`);
  const live = CUTOVER_TABLES.filter(({ table }) => before[table] !== 'absent' && before[table].n > 0);
  if (live.length === 0) {
    console.log(`[cutover] no keeper table in ${SHARED_DB} holds a row — nothing to move, no record needed.`);
    return;
  }
  const missing = CUTOVER_TABLES.filter(({ table }) => before[table] === 'absent').map(({ table }) => table);
  if (missing.length > 0) fail(`${missing.join(', ')} missing in ${SHARED_DB} while others hold rows — not a state this copy knows.`);
  const privBefore = readFingerprints(PRIVATE_DB);
  if (!readable(privBefore) || CUTOVER_TABLES.some(({ table }) => privBefore[table] === 'absent')) {
    fail(`${PRIVATE_DB} does not have every keeper table — apply its schema first: \`pnpm --filter @vaipakam/keeper run migrate\`.`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'keeper-cutover-'));
  try {
    // 3. Export, empty, import.
    const files = [];
    for (const { table } of CUTOVER_TABLES) {
      const file = join(dir, `${table}.sql`);
      const e = wrangler(['d1', 'export', SHARED_DB, '--remote', '--no-schema', `--table=${table}`, `--output=${file}`]);
      if (e.status !== 0) fail(`export of ${table} from ${SHARED_DB} failed — nothing was changed in ${PRIVATE_DB}.`);
      files.push({ table, file });
    }
    const empty = CUTOVER_TABLES.map(({ table }) => `DELETE FROM ${table}`).join('; ');
    if (query(PRIVATE_DB, empty) === null) fail(`emptying the private tables in ${PRIVATE_DB} failed.`);
    for (const { table, file } of files) {
      let body = '';
      try {
        body = readFileSync(file, 'utf8');
      } catch {
        fail(`the export of ${table} was not written.`);
      }
      if (!/\bINSERT\b/i.test(body)) continue; // an empty table exports no rows: the verify decides
      const i = wrangler(['d1', 'execute', PRIVATE_DB, '--remote', `--file=${file}`]);
      if (i.status !== 0) fail(`import of ${table} into ${PRIVATE_DB} failed — no record written; re-run the cutover.`);
    }

    // 4. Verify every table, both sides, and that nothing wrote the old copies meanwhile.
    const after = readFingerprints(SHARED_DB);
    const priv = readFingerprints(PRIVATE_DB);
    const moved = copyVerdict(before, after);
    if (!moved.ok) fail(`${SHARED_DB} changed during the copy (${moved.why}) — a keeper is still writing it. Stop it and re-run.`);
    const copied = copyVerdict(after, priv);
    if (!copied.ok) fail(`the copy is not complete (${copied.why}) — no record written; re-run the cutover.`);

    // 5. Record, and read the record back.
    const now = Math.floor(Date.now() / 1000);
    const fingerprint = JSON.stringify(Object.fromEntries(CUTOVER_TABLES.map(({ table }) => [table, after[table]])));
    if (query(PRIVATE_DB, `INSERT INTO keeper_cutover (id, completed_at, fingerprint) VALUES (1, ${now}, '${fingerprint}')`) === null) {
      fail(`writing the cutover record to ${PRIVATE_DB} failed — the copy is complete; re-run to record it.`);
    }
    const written = readMarker();
    if (written === null || written === 'none' || JSON.stringify(written.fingerprint) !== fingerprint) {
      fail(`the cutover record in ${PRIVATE_DB} did not read back as written.`);
    }
    for (const { table } of CUTOVER_TABLES) console.log(`[cutover] ${table}: ${after[table].n} row(s) — OK`);
    console.log('[cutover] recorded. Deploy the keeper now: `pnpm --filter @vaipakam/keeper run deploy`.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
