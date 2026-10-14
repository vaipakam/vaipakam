/**
 * The keeper private D1 cutover (#2450), defined once (#2489, Codex round 1).
 *
 * Five keeper tables began life in the SHARED database and move to the
 * keeper's private `vaipakam-keeper-db`. Two scripts need the same facts about
 * that move, and both read them from here, so they cannot disagree:
 *   - `scripts/keeper-cutover.mjs` COPIES the rows, checks every table, and
 *     records a completion marker;
 *   - `scripts/deploy-keeper.mjs` REFUSES to publish unless that marker exists
 *     and still matches the shared copies.
 *
 * A table's FINGERPRINT is its row count and the latest write time any of its
 * rows carries. Every keeper write to these tables stamps one of the time
 * columns below with "now", so a write after the copy moves the fingerprint,
 * and a partial copy has the wrong count. The earlier gate looked at two of the
 * five tables and passed as soon as the private side held a single row, so a
 * partial copy (or one the old keeper wrote past) published.
 */
import { spawnSync } from 'node:child_process';
import { SUCCESSOR } from '../../../indexer/scripts/lib/cutover-databases.mjs';
import { PRIVATE_DATABASES } from '../../../indexer/scripts/lib/d1-workers.mjs';

/** Both names from their pinned registries, never spelled here. */
export const PRIVATE_DB = PRIVATE_DATABASES.find((d) => d.binding === 'KEEPER_DB').name;
export const SHARED_DB = SUCCESSOR.name;

/**
 * Every table the cutover moves, with the SQL expression for the latest write
 * time a row of it carries. All five, never a sample: the gate decides on each.
 */
export const CUTOVER_TABLES = [
  { table: 'keeper_remit_ack', at: 'MAX(COALESCE(acked_at, 0), COALESCE(last_attempt_at, 0))' },
  { table: 'keeper_remit_ack_frontier', at: 'updated_at' },
  { table: 'keeper_commitment_scan', at: 'updated_at' },
  { table: 'keeper_commitment_day', at: 'resolved_at' },
  { table: 'hf_band_state', at: 'updated_at' },
];

/** The one query that reads a table's fingerprint, on either database. */
export function fingerprintSql({ table, at }) {
  return `SELECT COUNT(*) AS n, COALESCE(MAX(${at}), 0) AS at FROM ${table}`;
}

const sh = (cmd, args, opts) => spawnSync(cmd, args, { shell: process.platform === 'win32', ...opts });

/** One statement on `db` through wrangler (from the keeper's config, which
 *  binds both databases): its result rows, or `null` when the call failed or
 *  its output could not be parsed. Never `[]` for a failure. */
export function query(db, sql) {
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

/** Parse one fingerprint row, or `null` when it is not exactly one row of two
 *  finite numbers. */
export function parseFingerprint(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const n = Number(rows[0]?.n);
  const at = Number(rows[0]?.at);
  return Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(at) && at >= 0 ? { n, at } : null;
}

/**
 * Every cutover table's fingerprint on `db`: `{ table: {n, at} }`, with
 * `'absent'` for a table that does not exist there (the shared copies once
 * retired) and `null` for one that could not be read.
 */
export function readFingerprints(db) {
  const names = CUTOVER_TABLES.map(({ table }) => `'${table}'`).join(', ');
  const present = query(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names})`);
  const out = {};
  for (const t of CUTOVER_TABLES) {
    if (present === null) out[t.table] = null;
    else if (!present.some((r) => r?.name === t.table)) out[t.table] = 'absent';
    else out[t.table] = parseFingerprint(query(db, fingerprintSql(t)));
  }
  return out;
}

/** The completion marker, read from the private database: `{ completedAt,
 *  fingerprint }`, `'none'` when no cutover was recorded, `null` when unread. */
export function readMarker(db = PRIVATE_DB) {
  const rows = query(db, 'SELECT completed_at, fingerprint FROM keeper_cutover WHERE id = 1');
  if (rows === null) return null;
  if (rows.length === 0) return 'none';
  try {
    return { completedAt: Number(rows[0].completed_at), fingerprint: JSON.parse(rows[0].fingerprint) };
  } catch {
    return null;
  }
}

const same = (a, b) => a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && a.n === b.n && a.at === b.at;

/**
 * The deploy's verdict — pure, for the tests. `shared` is
 * {@link readFingerprints} of the shared database; `marker` is
 * {@link readMarker}. Refuses on anything unread; passes with no marker only
 * when the shared copies hold no rows at all (a fresh environment, or the old
 * copies retired); otherwise the marker must exist and match EVERY table the
 * shared side still has.
 */
export function cutoverVerdict(shared, marker) {
  for (const { table } of CUTOVER_TABLES) {
    if (shared?.[table] === null || shared?.[table] === undefined) {
      return { ok: false, why: `could not read ${table}'s fingerprint in ${SHARED_DB}` };
    }
  }
  const live = CUTOVER_TABLES.map(({ table }) => table).filter((t) => shared[t] !== 'absent' && shared[t].n > 0);
  if (live.length === 0) return { ok: true };
  if (marker === null) return { ok: false, why: `could not read the cutover record in ${PRIVATE_DB}` };
  if (marker === 'none') {
    return {
      ok: false,
      why:
        `${live.join(', ')} hold rows in ${SHARED_DB} and ${PRIVATE_DB} records no cutover: ` +
        'run `pnpm --filter @vaipakam/keeper run cutover` with the keeper stopped ' +
        '(DeploymentRunbook, "Keeper private D1 — one-time cutover").',
    };
  }
  for (const { table } of CUTOVER_TABLES) {
    if (shared[table] === 'absent') continue; // retired since: nothing to compare
    if (!same(shared[table], marker.fingerprint?.[table] ?? null)) {
      return {
        ok: false,
        why:
          `${table} in ${SHARED_DB} no longer matches the cutover copy ` +
          `(now ${JSON.stringify(shared[table])}, copied ${JSON.stringify(marker.fingerprint?.[table] ?? null)}): ` +
          'a keeper wrote the old copy after the cutover, so the private one is behind. Stop it and re-run the cutover.',
      };
    }
  }
  return { ok: true };
}

/**
 * The copy's own verdict, before it may record the marker — pure, for the
 * tests. Every table must exist on both sides, be read on both, and carry the
 * SAME fingerprint: a partial import has the wrong count, and a write to the
 * shared copy during the copy moves its time.
 */
export function copyVerdict(shared, priv) {
  const bad = [];
  for (const { table } of CUTOVER_TABLES) {
    const a = shared?.[table];
    const b = priv?.[table];
    if (a === 'absent' || b === 'absent') bad.push(`${table}: missing on the ${a === 'absent' ? 'shared' : 'private'} side`);
    else if (!same(a ?? null, b ?? null)) bad.push(`${table}: shared ${JSON.stringify(a ?? null)} vs private ${JSON.stringify(b ?? null)}`);
  }
  return bad.length === 0 ? { ok: true } : { ok: false, why: bad.join('; ') };
}
