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
 *   2. FINGERPRINT the shared copies: per table, row count, latest write
 *      time, a digest over every row and one digest per row. Nothing to move — no table holds a row — ends here: the deploy
 *      passes a fresh environment without a marker.
 *   3. EXPORT each table from the shared database (data only), EMPTY the five
 *      private tables, and IMPORT each export. Emptying first makes a re-run
 *      after a partial import exact rather than a duplicate-key failure.
 *   4. VERIFY: every table's fingerprint is the same on both sides, and the
 *      shared side's is unchanged since step 2. A partial import has the wrong
 *      count; a keeper still writing the old copies changes the digests. Either
 *      fails here, with no marker written.
 *   5. RECORD, through one SQL file of small statements: the per-row digests
 *      (`keeper_cutover_row`), the keeper's deployment epoch seeded from the
 *      indexer's SETTLED adoptions (`lib/indexer-adoption.mjs`), and LAST the
 *      marker. REFUSE first if any chain the copied rows are keyed by has no
 *      settled adoption: the Diamond those rows belong to would be a guess,
 *      and the keeper's first tick would adopt the configured one over them
 *      (#2569 r1). Then read it all back; a record that is not complete is
 *      removed again.
 *
 * The export files hold keeper operational state; they are written to a
 * private temporary directory and removed however the run ends.
 *
 * Takes NO arguments, like the deploy: nothing it would have to interpret can
 * change which database it writes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  adoptionsDiffer,
  recordSql,
  seedVerdict,
} from './lib/keeper-cutover.mjs';
import { INDEXER_DEPLOYMENTS_SQL } from './lib/indexer-adoption.mjs';

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

  // The indexer's adoptions, read BEFORE anything moves (#2569 r2): the seed
  // for the keeper's epoch is decided from this read, and a copied chain the
  // indexer has not settled on refuses here, with nothing changed. The same
  // read is repeated after the verify; see step 5.
  const adoptionsBefore = query(SHARED_DB, INDEXER_DEPLOYMENTS_SQL);
  const seed = seedVerdict(before, adoptionsBefore);
  if (!seed.ok) fail(`${seed.why} Nothing was changed.`);

  const dir = mkdtempSync(join(tmpdir(), 'keeper-cutover-'));
  try {
    // 3. Export, empty, import — ONE export of all the tables (#2569 r4).
    // `wrangler d1 export` holds the database while it runs, and the shared
    // database serves the indexer, the agent and the app, which this
    // procedure does not stop; one export is one such window instead of one
    // per table, and the tables are snapshotted together rather than in
    // sequence. `--table` repeats, as wrangler documents it.
    const file = join(dir, 'keeper-tables.sql');
    const e = wrangler([
      'd1',
      'export',
      SHARED_DB,
      '--remote',
      '--no-schema',
      ...CUTOVER_TABLES.map(({ table }) => `--table=${table}`),
      `--output=${file}`,
    ]);
    if (e.status !== 0) fail(`export of the keeper tables from ${SHARED_DB} failed — nothing was changed in ${PRIVATE_DB}.`);
    let body = '';
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      fail(`the export was not written.`);
    }
    const empty = CUTOVER_TABLES.map(({ table }) => `DELETE FROM ${table}`).join('; ');
    if (query(PRIVATE_DB, empty) === null) fail(`emptying the private tables in ${PRIVATE_DB} failed.`);
    // An export with no row inserts nothing: the verify below decides.
    if (/\bINSERT\b/i.test(body)) {
      const i = wrangler(['d1', 'execute', PRIVATE_DB, '--remote', `--file=${file}`]);
      if (i.status !== 0) fail(`import into ${PRIVATE_DB} failed — no record written; re-run the cutover.`);
    }

    // 4. Verify every table, both sides, and that nothing wrote the old copies meanwhile.
    const after = readFingerprints(SHARED_DB);
    const priv = readFingerprints(PRIVATE_DB);
    const moved = copyVerdict(before, after);
    if (!moved.ok) fail(`${SHARED_DB} changed during the copy (${moved.why}) — a keeper is still writing it. Stop it and re-run.`);
    const copied = copyVerdict(after, priv);
    if (!copied.ok) fail(`the copy is not complete (${copied.why}) — no record written; re-run the cutover.`);

    // 5. The indexer's adoptions must not have moved since the read above
    // (#2569 r2): an adoption finished during the copy would make the seed
    // taken before it describe rows copied under the old Diamond. Refuse with
    // no record written; the copy is intact and the re-run reads afresh.
    const adoptionsAfter = query(SHARED_DB, INDEXER_DEPLOYMENTS_SQL);
    if (adoptionsDiffer(adoptionsBefore, adoptionsAfter)) {
      fail(`the indexer's adoptions in ${SHARED_DB} changed during the copy (or could not be re-read) — no record written; the copy is intact. Re-run the cutover.`);
    }
    // Then record, through ONE SQL FILE of small statements (never a single
    // --command string, whose size would grow with the copy): the per-row
    // digests, the keeper's deployment epoch seeded from the adoptions read
    // before the copy (the copied rows belong to those Diamonds), and LAST
    // the marker.
    const now = Math.floor(Date.now() / 1000);
    const recordFile = join(dir, 'record.sql');
    writeFileSync(recordFile, recordSql(after, seed.deployments, now), { mode: 0o600 });
    const rec = wrangler(['d1', 'execute', PRIVATE_DB, '--remote', `--file=${recordFile}`]);
    // Read the whole record back. Anything short of a complete record is
    // removed again, so a failed write never leaves a marker the gate would
    // refuse for good — the cutover is simply re-run.
    const written = readMarker();
    const intact =
      rec.status === 0 &&
      written !== null &&
      written !== 'none' &&
      CUTOVER_TABLES.every(({ table }) => {
        const w = written.fingerprint?.[table];
        const a = after[table];
        return w && w.n === a.n && w.at === a.at && w.digest === a.digest && JSON.stringify(w.rows) === JSON.stringify(a.rows);
      });
    if (!intact) {
      query(PRIVATE_DB, 'DELETE FROM keeper_cutover; DELETE FROM keeper_cutover_row');
      fail(`the cutover record in ${PRIVATE_DB} did not read back complete — removed; the copy is intact, re-run the cutover to record it.`);
    }
    for (const { table } of CUTOVER_TABLES) console.log(`[cutover] ${table}: ${after[table].n} row(s) — OK`);
    console.log('[cutover] recorded. Deploy the keeper now: `pnpm --filter @vaipakam/keeper run deploy`.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
