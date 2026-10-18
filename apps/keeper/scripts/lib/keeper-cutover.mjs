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
 * A table's FINGERPRINT is its row count, the latest write time any of its
 * rows carries, and a DIGEST of every row's contents (#2497 r1). Count and
 * time alone were not enough: they are whole seconds, so an ack attempt or a
 * band change in the same second as the table's latest write left both
 * unchanged, and a stale copy passed. The digest is SHA-256 over the rows in a
 * canonical form (each row's columns sorted by name, the rows sorted), so it
 * moves on any change to any row and is the same whether the rows were read
 * through wrangler or the D1 HTTP API. The earlier gate looked at two of the
 * five tables and passed as soon as the private side held a single row, so a
 * partial copy (or one the old keeper wrote past) published.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SUCCESSOR } from '../../../indexer/scripts/lib/cutover-databases.mjs';
import { PRIVATE_DATABASES } from '../../../indexer/scripts/lib/d1-workers.mjs';

/** Both names from their pinned registries, never spelled here. */
export const PRIVATE_DB = PRIVATE_DATABASES.find((d) => d.binding === 'KEEPER_DB').name;
/** The private database's pinned id, the one the Worker binds and the machine
 *  host binds too — never taken from host config (#2497 r4). */
export const PRIVATE_DB_ID = PRIVATE_DATABASES.find((d) => d.binding === 'KEEPER_DB').id;
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

/** The one query that reads a table's count and latest write time, on either database. */
export function fingerprintSql({ table, at }) {
  return `SELECT COUNT(*) AS n, COALESCE(MAX(${at}), 0) AS at FROM ${table}`;
}

/** The one query that reads a table's rows for its digest. */
export function rowsSql({ table }) {
  return `SELECT * FROM ${table}`;
}

/** SHA-256 over the rows in canonical form: each row as JSON of its
 *  [column, value] pairs sorted by column, the rows sorted. Order-independent,
 *  and the same for any reader that returns the same values. */
export function rowDigest(rows) {
  const canon = rows
    .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
    .sort();
  return createHash('sha256').update(canon.join('\n')).digest('hex');
}

/** One digest PER ROW, in the same canonical form, sorted (#2497 r10). The
 *  cutover record keeps them so the verdict can tell a deletion from a write:
 *  see {@link cutoverVerdict}. */
export function rowDigests(rows) {
  return rows
    .map((r) => createHash('sha256').update(JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).digest('hex'))
    .sort();
}

/** A table's whole fingerprint from its two reads, or `null` when either
 *  failed (never a partial fingerprint). */
export function fingerprintFromReads(countRows, rows) {
  const base = parseFingerprint(countRows);
  if (base === null || !Array.isArray(rows) || rows.length !== base.n) return null;
  return { ...base, digest: rowDigest(rows), rows: rowDigests(rows) };
}

/** Whether every row the shared copy holds NOW was in the copy (#2497 r10).
 *  A keeper INSERTS and UPDATES its tables; nothing but a reset or a
 *  retirement removes rows — the indexer's deployment-epoch reset deletes a
 *  redeployed chain's rows, legitimately, after the cutover. So the question
 *  "did a keeper write the old copy since?" is "is any current row not one the
 *  copy took?", and a deletion is not a write. */
const covered = (now, copied) =>
  now !== null &&
  copied !== null &&
  typeof now === 'object' &&
  typeof copied === 'object' &&
  Array.isArray(now.rows) &&
  Array.isArray(copied.rows) &&
  // A Set: the machine gate runs this every minute over the whole copy (#2497 r12).
  ((took) => now.rows.every((d) => took.has(d)))(new Set(copied.rows));

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
    else out[t.table] = fingerprintFromReads(query(db, fingerprintSql(t)), query(db, rowsSql(t)));
  }
  return out;
}

/** The completion marker, read from the private database: `{ completedAt,
 *  fingerprint }`, `'none'` when no cutover was recorded, `null` when unread. */
export function readMarker(db = PRIVATE_DB) {
  return markerFromReads(query(db, MARKER_SQL), query(db, MARKER_ROWS_SQL));
}

/** The marker's own row. */
export const MARKER_SQL = 'SELECT completed_at, fingerprint FROM keeper_cutover WHERE id = 1';
/** The per-row digests the copy took, one row each (#2497 re-cut): kept in
 *  their own table, NOT in the marker's JSON, so the record has no size
 *  ceiling — a statement on D1 is capped at 100 KB. */
export const MARKER_ROWS_SQL = 'SELECT tbl, digest FROM keeper_cutover_row';

/** The marker from its two reads: `'none'` when no cutover is recorded, `null`
 *  when either read failed or the record is malformed. Each table's
 *  fingerprint gains `rows`, its per-row digests, for {@link cutoverVerdict}.
 *  Pure; shared by the deploy and the machine's gate. */
export function markerFromReads(markerRows, digestRows) {
  if (markerRows === null || !Array.isArray(markerRows)) return null;
  if (markerRows.length === 0) return 'none';
  if (digestRows === null || !Array.isArray(digestRows)) return null;
  let fingerprint;
  try {
    fingerprint = JSON.parse(String(markerRows[0].fingerprint));
  } catch {
    return null;
  }
  const byTable = new Map();
  for (const r of digestRows) {
    const list = byTable.get(r.tbl) ?? [];
    list.push(String(r.digest));
    byTable.set(r.tbl, list);
  }
  for (const { table } of CUTOVER_TABLES) {
    const fp = fingerprint?.[table];
    if (!fp || typeof fp !== 'object') return null;
    fp.rows = (byTable.get(table) ?? []).sort();
    // A record whose digests do not account for every row it copied is
    // malformed — never read as a smaller copy.
    if (fp.rows.length !== fp.n) return null;
  }
  return { completedAt: Number(markerRows[0].completed_at), fingerprint };
}

/** Every chain the copied keyed-by-chain rows belong to (#2569 r1) — the
 *  tables whose rows the keeper's epoch reset would clear. */
export const COPIED_CHAINS_SQL =
  'SELECT chain_id FROM hf_band_state UNION SELECT chain_id FROM keeper_commitment_scan UNION SELECT chain_id FROM keeper_commitment_day';

/** Digests per INSERT in the record file: ~14 KB a statement, far under D1's
 *  100 KB statement cap whatever the row count. */
const DIGESTS_PER_STATEMENT = 200;

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * The record of a completed copy, as ONE SQL FILE for `wrangler d1 execute
 * --file` (#2497 re-cut) — never one `--command` string, whose size grows with
 * the copy. In order: the per-row digests (`keeper_cutover_row`), the
 * keeper's deployment epoch per chain seeded from the indexer's adopted
 * Diamonds (the copied rows belong to those, so a later Diamond change resets
 * them), and LAST the marker itself, carrying count, latest write and digest
 * per table. Pure; pinned by the tests.
 */
export function recordSql(fingerprints, indexerDeployments, nowSec) {
  const out = ['DELETE FROM keeper_cutover_row;'];
  for (const { table } of CUTOVER_TABLES) {
    const rows = fingerprints[table]?.rows ?? [];
    for (let i = 0; i < rows.length; i += DIGESTS_PER_STATEMENT) {
      const values = rows.slice(i, i + DIGESTS_PER_STATEMENT).map((d) => `(${sqlText(table)}, ${sqlText(d)})`);
      out.push(`INSERT INTO keeper_cutover_row (tbl, digest) VALUES ${values.join(', ')};`);
    }
  }
  for (const d of indexerDeployments) {
    out.push(
      `INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (${Number(d.chain_id)}, ${sqlText(String(d.diamond).toLowerCase())}, ${nowSec}) ` +
        'ON CONFLICT (chain_id) DO UPDATE SET diamond = excluded.diamond, adopted_at = excluded.adopted_at;',
    );
  }
  const slim = Object.fromEntries(
    CUTOVER_TABLES.map(({ table }) => {
      const { n, at, digest } = fingerprints[table];
      return [table, { n, at, digest }];
    }),
  );
  out.push(`INSERT INTO keeper_cutover (id, completed_at, fingerprint) VALUES (1, ${nowSec}, ${sqlText(JSON.stringify(slim))});`);
  return out.join('\n') + '\n';
}

const same = (a, b) =>
  a !== null &&
  b !== null &&
  typeof a === 'object' &&
  typeof b === 'object' &&
  a.n === b.n &&
  a.at === b.at &&
  typeof a.digest === 'string' &&
  a.digest === b.digest;

/**
 * The deploy's verdict — pure, for the tests. `shared` is
 * {@link readFingerprints} of the shared database; `marker` is
 * {@link readMarker}. Refuses on anything unread; passes with no marker only
 * when the shared copies hold no rows at all (a fresh environment, or the old
 * copies retired); otherwise the marker must exist, and every row each shared
 * table still holds must be one the copy took. Rows may only have gone — the
 * indexer's deployment-epoch reset deletes a redeployed chain's rows — never
 * arrived or changed (#2497 r10).
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
    if (!covered(shared[table], marker.fingerprint?.[table] ?? null)) {
      const now = shared[table];
      const copied = marker.fingerprint?.[table];
      return {
        ok: false,
        why:
          `${table} in ${SHARED_DB} no longer matches the cutover copy ` +
          `(now n=${now.n}, copied n=${copied?.n ?? '?'}; a row is not one the copy took): ` +
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
