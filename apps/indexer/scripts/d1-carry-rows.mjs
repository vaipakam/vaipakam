#!/usr/bin/env node
/**
 * d1-carry-rows — carry the rows of one D1 database into another, and
 * prove afterwards what both sides hold.
 *
 * WHY THIS IS CODE AND NOT A PROCEDURE IN A RUNBOOK (#2214). The first
 * copy of the archive → warm cutover was done ad hoc, reported success,
 * and had silently lost a row. Nothing about it was reproducible: the
 * table set, the conflict keys, the batch sizing and the comparison all
 * lived in a terminal session. A data step that cannot be re-run
 * identically cannot be verified, and the cutover re-runs it — once more
 * after the writers stop, and again after the switch.
 *
 * WHAT THIS TOOL IS SHAPED BY. Four review rounds, each finding the same
 * seam from a different side, are why it looks like this rather than like
 * a one-way copy:
 *
 *   - **One end of a carry is always the SHARED database.** Not "the
 *     destination is fixed" — an earlier revision fixed the destination,
 *     which made the tool unable to perform the ROLLBACK the functional
 *     spec requires (stop → carry rows → switch, in the other direction).
 *     The property that actually matters is that a carry cannot be aimed
 *     between two arbitrary databases: the shared one, as
 *     `apps/indexer/wrangler.jsonc` declares it, is always one end. Both
 *     directions are reachable; neither is reachable by accident.
 *
 *   - **Parents before children.** Tables are ordered by their FOREIGN
 *     KEY dependencies, not alphabetically. D1 enforces foreign keys, and
 *     alphabetical order puts `notify_state` before the `user_thresholds`
 *     row it references — so a child created between two carries would be
 *     rejected, aborting the very copy the cutover depends on. Deletes go
 *     in the reverse order for the same reason.
 *
 *   - **A deletion on the source is a difference like any other.** An
 *     upsert-only copy can never make the two sides equal once a row has
 *     been deleted on the source — live writers expire `telegram_links`,
 *     prune diagnostics and cancel offers between carries — so the
 *     destination keeps a row the source no longer has and the digest
 *     never converges. `mirror` therefore also removes destination rows
 *     whose key is absent from the source. That is only safe against an
 *     INERT destination, which the tool says out loud.
 *
 *   - **Both sides must declare the same SHAPE for a table before its
 *     rows are compared.** The two databases are kept on the same
 *     migrations, so this normally holds — but the destination is read
 *     with the source's column list, which is what makes "normally"
 *     load-bearing: a destination carrying an extra column would be
 *     reported identical while every carried row left that column at its
 *     default. A shape difference is a migration decision, not a copy, so
 *     the table is refused and both shapes are printed.
 *
 *   - **A live destination gets `--only-missing` instead.** Reconciling
 *     into a database that is being written to must not overwrite what it
 *     has: rows are inserted only where the key is absent, nothing is
 *     updated and nothing is deleted. This is the post-switch
 *     reconciliation mode, and it is the reason the cutover does not have
 *     to claim its drain barrier is a proof.
 *
 * Never carried: `sqlite_*` and `_cf_*` (the engine's and the platform's
 * own — `_cf_KV` refuses to be read at all), and `d1_migrations`, because
 * a database's record of which migrations have run against IT is its own
 * and overwriting it would assert history that never happened.
 *
 * WHAT IT DOES NOT GUARANTEE. It takes no lock. Two carries run against
 * the same pair at once will interleave their reads and writes, and the
 * manifest one writes will not describe what the other did — so a
 * reconciliation against it is meaningless. The cutover is a numbered
 * sequence one operator follows, which is why this is stated rather than
 * mechanised: a lock across an HTTP API is a larger mechanism than the
 * situation it guards, and a stated limit is honest where an unenforced
 * assumption is not.
 *
 * SCALE. Both sides are read in full, in memory, to compare them. That is
 * right for a cutover of this database — 1,384 rows across 43 tables —
 * and is stated rather than assumed: a database large enough not to fit
 * needs a different tool, not a bigger `PAGE`.
 *
 * USAGE
 *
 *   # what a database holds, table by table
 *   node apps/indexer/scripts/d1-carry-rows.mjs digest --db vaipakam-archive
 *
 *   # the cutover copy: destination inert, made identical to the source.
 *   # The manifest records what this carry saw; KEEP IT.
 *   node apps/indexer/scripts/d1-carry-rows.mjs carry \
 *     --from vaipakam-archive --to vaipakam-warm \
 *     --mirror --manifest cutover-mirror.json
 *
 *   # post-switch reconciliation: destination LIVE, nothing overwritten.
 *   # --since is what lets it tell a straggler's late write from the
 *   # destination's own progress.
 *   node apps/indexer/scripts/d1-carry-rows.mjs carry \
 *     --from vaipakam-archive --to vaipakam-warm \
 *     --only-missing --since cutover-mirror.json
 *
 * The mode is never implied and unknown arguments are refused: a mistyped
 * `--only-missing` must not fall back to mirroring over a live database.
 *
 * See `docs/ops/D1CutoverArchiveToWarm.md` for where each belongs in the
 * sequence, and for why `digest` run twice is the drain barrier.
 *
 * ENVIRONMENT: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (D1
 * read+write). The D1 HTTP API is used rather than `wrangler d1 execute`
 * because it BINDS parameters: a copy that formats its values into SQL is
 * a copy whose correctness depends on quoting every type correctly, and
 * this one moves rows a person's money position is described by.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

/** The single declaration of the shared database. */
const DECLARING_FILE = 'apps/indexer/wrangler.jsonc';

const NEVER_CARRIED = (t) =>
  t.startsWith('sqlite_') || t.startsWith('_cf_') || t === 'd1_migrations';

/**
 * D1 caps bound parameters per statement. 90 is the working headroom the
 * archive → warm carry was sized against; rows per batch is
 * floor(90 / columns), which is why wide tables go in twos.
 */
const MAX_PARAMS = 90;

/** Rows pulled per SELECT. Bounds one response, not the total. */
const PAGE = 500;

function fail(msg) {
  console.error(`\n[d1-carry-rows] ${msg}\n`);
  process.exit(1);
}

/** Strip JSONC comments without mangling string contents. */
function parseJsonc(src, file) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch (err) {
    fail(`${file}: not parseable as JSONC — ${err.message}`);
  }
}

// --------------------------------------------------------------- validation

/**
 * Ids and names are built into request paths and identifiers into
 * statements, so each is checked against its shape rather than trusted
 * for having come from a committed file or from the API: a mis-edited
 * config should fail here, naming the field, not become part of a URL.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DB_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Values are bound; an identifier cannot be, so identifiers are checked. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checked(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${what} is not a well-formed value: ${JSON.stringify(value)}`);
  }
  return value;
}

function sharedDatabase() {
  const cfg = parseJsonc(
    readFileSync(join(REPO, DECLARING_FILE), 'utf8'),
    DECLARING_FILE,
  );
  const entry = (cfg.d1_databases ?? []).find((e) => e.binding === 'DB');
  if (!entry?.database_name || !entry?.database_id) {
    fail(
      `${DECLARING_FILE} has no complete "DB" d1 binding. That file is the ` +
        `single declaration of the shared database, so this tool has no ` +
        `anchor it is willing to trust.`,
    );
  }
  return {
    name: checked(entry.database_name, DB_NAME, `${DECLARING_FILE} database_name`),
    id: checked(entry.database_id, UUID, `${DECLARING_FILE} database_id`),
  };
}

// ----------------------------------------------------------------- transport

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';

/**
 * One request against an ACCOUNT-RELATIVE path. The account id is joined
 * here and nowhere else, so it cannot reach a log line: an error names
 * the endpoint, which is what diagnoses a failure, while the credentials
 * and the account identity stay out of the diagnosis.
 */
async function cf(subpath, init = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API}/accounts/${ACCOUNT}${subpath}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.ok && body?.success) return body.result;
    // The body is the diagnosis and must never be swallowed: the batching
    // bug in the first copy looked like a bare "HTTP 400" for exactly as
    // long as the wrapper printed only the status.
    lastErr = new Error(`HTTP ${res.status} on ${subpath}\n${text.slice(0, 2000)}`);
    if (res.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

/** One statement against one database. `params` are bound, never spliced. */
async function query(dbId, sql, params = []) {
  const result = await cf(
    `/d1/database/${checked(dbId, UUID, 'database id')}/query`,
    { method: 'POST', body: JSON.stringify({ sql, params }) },
  );
  return result?.[0]?.results ?? [];
}

async function resolveByName(name) {
  checked(name, DB_NAME, 'database name');
  const list = await cf(`/d1/database?name=${encodeURIComponent(name)}`);
  const hit = (list ?? []).find((d) => d.name === name);
  if (!hit) fail(`no D1 database named "${name}" in this account`);
  return { name, id: checked(hit.uuid, UUID, `id the API reports for ${name}`) };
}

// -------------------------------------------------------------- table shapes

async function tablesOf(dbId) {
  const rows = await query(
    dbId,
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  return rows
    .map((r) => checked(r.name, IDENT, 'table name from sqlite_master'))
    .filter((t) => !NEVER_CARRIED(t));
}

/** Column order and primary key, as the table itself declares them. */
async function shapeOf(dbId, table) {
  const info = await query(dbId, `PRAGMA table_info("${table}")`);
  const cols = [...info]
    .sort((a, b) => a.cid - b.cid)
    .map((c) => checked(c.name, IDENT, `column name in ${table}`));
  const key = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => checked(c.name, IDENT, `key column in ${table}`));

  // Every OTHER uniqueness the table declares. A row can be absent by
  // primary key and still be rejected by a secondary unique index —
  // `notifications.dedup_key` is one — and an `ON CONFLICT (pk)` clause
  // does not cover that, so the insert fails with a raw constraint error
  // instead of the tool recognising a logical row that is already there.
  const uniques = [];
  for (const idx of await query(dbId, `PRAGMA index_list("${table}")`)) {
    if (idx.unique !== 1) continue;
    const parts = await query(dbId, `PRAGMA index_info("${idx.name}")`);
    const columns = [...parts]
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name)
      .filter((n) => typeof n === 'string');
    if (columns.length === 0) continue;
    if (columns.join() === key.join()) continue;
    uniques.push({
      name: idx.name,
      columns: columns.map((c) => checked(c, IDENT, `unique column in ${table}`)),
    });
  }
  return { cols, key, uniques };
}

/**
 * Parents before children. D1 enforces foreign keys, so insert order is
 * not free: a child whose parent has not been carried yet is rejected,
 * which would abort the carry rather than degrade it.
 */
async function orderByDependency(dbId, tables) {
  const parentsOf = new Map(tables.map((t) => [t, new Set()]));
  for (const t of tables) {
    for (const fk of await query(dbId, `PRAGMA foreign_key_list("${t}")`)) {
      const parent = fk.table;
      if (typeof parent === 'string' && parent !== t && parentsOf.has(parent)) {
        parentsOf.get(t).add(parent);
      }
    }
  }
  const state = new Map();
  const ordered = [];
  const visit = (t, stack) => {
    if (state.get(t) === 'done') return;
    if (state.get(t) === 'active') {
      fail(
        `foreign-key cycle: ${[...stack, t].join(' → ')}. No insert order ` +
          `satisfies a cycle, so this needs deferred constraints and a ` +
          `decision — it is not something this tool should guess at.`,
      );
    }
    state.set(t, 'active');
    for (const p of parentsOf.get(t)) visit(p, [...stack, t]);
    state.set(t, 'done');
    ordered.push(t);
  };
  for (const t of tables) visit(t, []);
  return ordered;
}

// -------------------------------------------------------------------- rows

async function readAll(dbId, table, cols) {
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await query(
      dbId,
      `SELECT ${quoted} FROM "${table}" ORDER BY ${quoted} LIMIT ${PAGE} OFFSET ${offset}`,
    );
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** JSON of the values in declared column order — null and "" stay distinct. */
const canonical = (row, cols) => JSON.stringify(cols.map((c) => row[c] ?? null));

/** A row's identity-independent content, short enough to store per row. */
const rowHash = (row, cols) =>
  createHash('sha256').update(canonical(row, cols)).digest('hex').slice(0, 16);

function digestOf(rows, cols) {
  const lines = rows.map((r) => canonical(r, cols)).sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l).update('\n');
  return { digest: h.digest('hex').slice(0, 16), count: rows.length };
}

async function digestDatabase(db) {
  const out = new Map();
  for (const table of await tablesOf(db.id)) {
    const { cols } = await shapeOf(db.id, table);
    out.set(table, digestOf(await readAll(db.id, table, cols), cols));
  }
  return out;
}

function printDigest(label, map) {
  console.log(`\n${label}`);
  let rows = 0;
  for (const [table, { digest, count }] of [...map].sort()) {
    rows += count;
    console.log(`  ${table.padEnd(32)} ${String(count).padStart(6)}  ${digest}`);
  }
  console.log(
    `  ${'—'.repeat(32)} ${String(rows).padStart(6)}  (${map.size} tables)`,
  );
}

// ------------------------------------------------------------------- carry

const keyOf = (row, key) => JSON.stringify(key.map((c) => row[c] ?? null));

/**
 * THE MANIFEST — what the mirror carry saw, so the reconciliation after
 * the switch has something to compare against.
 *
 * Without it, `--only-missing` can only ask "does the destination have
 * this key?", and a straggler that UPDATES an existing row — an `offers`
 * status, a cursor, a threshold — leaves the key present. Every pass then
 * does nothing, reports zero rows carried, and the reconciliation calls
 * itself finished while the destination is stale. That is the same
 * shape as counting rows instead of comparing them.
 *
 * Comparing the two databases directly cannot fix it either: after the
 * switch the destination legitimately moves on, so almost every row
 * differs and the signal is buried. What identifies a straggler is that
 * the row changed ON THE SOURCE after the mirror — which is a question
 * about the source and its own past, and the manifest is that past.
 *
 * The tool does NOT resolve a conflict it finds. It cannot know whether
 * the source's late value or the destination's newer one should win, and
 * guessing would be exactly the overwrite `--only-missing` exists to
 * prevent. It names the row and stops.
 */
function writeManifest(path, src, tables) {
  const doc = {
    source: { name: src.name, id: src.id },
    takenAt: new Date().toISOString(),
    tables,
  };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `manifest written to ${path} — keep it; the post-switch reconciliation ` +
      `needs it as --since`,
  );
}

function readManifest(path, src) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read the manifest at ${path} — ${err.message}`);
  }
  if (doc?.source?.id !== src.id) {
    fail(
      `the manifest at ${path} was taken from ${doc?.source?.name} ` +
        `(${doc?.source?.id}), but --from is ${src.name} (${src.id}). ` +
        `Comparing a database against another database's past would ` +
        `report every row as a conflict.`,
    );
  }
  console.log(`  reconciling against the mirror of ${doc.takenAt}`);
  return doc.tables ?? {};
}

/** Chunk so a statement never exceeds the bound-parameter cap. */
function chunk(items, perBatch) {
  const out = [];
  for (let i = 0; i < items.length; i += perBatch) out.push(items.slice(i, i + perBatch));
  return out;
}

async function upsert(dst, table, rows, cols, key, onlyMissing) {
  if (rows.length === 0) return 0;
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  const conflict = key.map((c) => `"${c}"`).join(', ');
  const nonKey = cols.filter((c) => !key.includes(c));
  // `DO NOTHING` is what --only-missing means at the statement level: an
  // existing row is left exactly as the destination has it. A key-only
  // table has nothing to update either way.
  const action =
    onlyMissing || nonKey.length === 0
      ? 'NOTHING'
      : `UPDATE SET ${nonKey.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`;

  for (const batch of chunk(rows, Math.max(1, Math.floor(MAX_PARAMS / cols.length)))) {
    await query(
      dst.id,
      `INSERT INTO "${table}" (${quoted}) VALUES ` +
        batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ') +
        ` ON CONFLICT (${conflict}) DO ${action}`,
      batch.flatMap((r) => cols.map((c) => r[c] ?? null)),
    );
  }
  return rows.length;
}

async function deleteKeys(dst, table, keyRows, key) {
  if (keyRows.length === 0) return 0;
  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / key.length));
  for (const batch of chunk(keyRows, perBatch)) {
    const predicate = batch
      .map(() => `(${key.map((c) => `"${c}" = ?`).join(' AND ')})`)
      .join(' OR ');
    await query(
      dst.id,
      `DELETE FROM "${table}" WHERE ${predicate}`,
      batch.flatMap((r) => key.map((c) => r[c] ?? null)),
    );
  }
  return keyRows.length;
}

/**
 * The reconciliation decision table, as a pure function — no network, no
 * database — so every branch can be exercised by a test. Two of the five
 * cases below cannot be produced against the live pair during a rehearsal
 * (the destination is inert, so it deletes nothing and allocates nothing),
 * and an unexercised branch on the path that decides whether a row is
 * resurrected is not something to leave to a live run that may never
 * produce it.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function classifyForReconcile({
  table,
  cols,
  key,
  rows,
  sourceKeys,
  heldByKey,
  wasSeen,
  uniques = [],
}) {
  const conflicts = [];
  const insert = [];
  if (wasSeen === null || wasSeen === undefined) {
    conflicts.push({
      table,
      kind: 'no record',
      detail:
        'the manifest has no record of this table, so none of the cases ' +
        'below can be told apart from the destination simply moving on',
    });
    return { insert, conflicts };
  }

  /**
   * Where the destination already holds each declared unique tuple. SQLite
   * treats NULLs in a unique index as distinct, so a tuple containing one
   * cannot collide and is not indexed here.
   */
  const tupleOf = (row, columns) =>
    columns.some((c) => row[c] === null || row[c] === undefined)
      ? null
      : JSON.stringify(columns.map((c) => row[c]));
  const destUnique = uniques.map((u) => {
    const byValue = new Map();
    for (const [k, r] of heldByKey) {
      const t = tupleOf(r, u.columns);
      if (t !== null) byValue.set(t, k);
    }
    return { ...u, byValue };
  });

  for (const r of rows) {
    const k = keyOf(r, key);
    const mirrored = wasSeen[k] !== undefined;
    const destRow = heldByKey.get(k);
    const inDest = destRow !== undefined;

    // A CONFLICT IS ONLY A CONFLICT WHILE THE TWO SIDES ACTUALLY DIFFER,
    // and this rule has to come before every case that reasons about the
    // manifest — which is where it was missing twice.
    //
    // The manifest says what the mirror saw; it does not say what the two
    // databases hold now. If they agree on this row there is nothing to
    // reconcile, whatever the manifest recorded. That covers a row a
    // PREVIOUS pass of this reconciliation carried, and equally a late
    // update an operator has already RESOLVED by copying the chosen value
    // across — which is the whole point of repeat-until-clean. Comparing
    // the source against the manifest alone made both of those conflict
    // forever, so the procedure could never come clean after doing
    // anything about a finding.
    if (inDest && rowHash(destRow, cols) === rowHash(r, cols)) continue;

    if (!mirrored && inDest) {
      // The destination has a key the mirror never carried and holds a
      // DIFFERENT row under it: both sides allocate from the same
      // AUTOINCREMENT sequence once they run independently.
      conflicts.push({
        table,
        key: k,
        kind: 'key allocated on both sides',
        detail:
          'this key is new on the source since the mirror and the ' +
          'destination holds a DIFFERENT row under it — two records with ' +
          'one id, which an insert would silently drop',
      });
      continue;
    }

    if (!mirrored && !inDest) {
      // Absent by primary key is not the same as insertable. A secondary
      // unique index can already hold this row's tuple under another key,
      // and `ON CONFLICT (pk)` would not catch it — the insert would fail
      // with a raw constraint error and abort the reconciliation.
      const clash = destUnique
        .map((u) => ({ u, t: tupleOf(r, u.columns) }))
        .find(({ u, t }) => t !== null && u.byValue.has(t));
      if (clash) {
        conflicts.push({
          table,
          key: k,
          kind: 'already present under a different key',
          detail:
            `the destination holds a row with the same ${clash.u.columns.join(
              '+',
            )} under key ${clash.u.byValue.get(clash.t)} — the same logical ` +
            `row reached both sides and was numbered differently`,
        });
        continue;
      }
      insert.push(r);
      continue;
    }

    if (mirrored && inDest) {
      // The two sides differ — the equality rule above already returned
      // for the case where they agree — and the source is not what the
      // mirror saw, so a straggler wrote it after the barrier.
      conflicts.push({
        table,
        key: k,
        kind: 'changed on the source after the mirror',
        detail:
          'the destination holds a different row under that key. Resolve ' +
          'it by making the two sides agree; a later pass then passes over ' +
          'it silently',
      });
    } else if (mirrored && !inDest) {
      conflicts.push({
        table,
        key: k,
        kind: 'deleted on the destination',
        detail:
          'the mirror carried this row and the destination no longer has ' +
          'it, so it was deleted there — re-inserting it would undo that, ' +
          'and such a deletion may be a retention or privacy obligation',
      });
    }
  }

  // Keys the mirror carried that the SOURCE no longer has. These appear in
  // no row of the source, which is exactly why a loop over the source left
  // the destination holding them while the run reported VERIFIED.
  for (const k of Object.keys(wasSeen)) {
    if (sourceKeys.has(k)) continue;
    // If the destination has dropped it too, the two agree and there is
    // nothing to decide.
    if (!heldByKey.has(k)) continue;
    conflicts.push({
      table,
      key: k,
      kind: 'deleted on the source after the mirror',
      detail:
        'the destination still holds it, so it is stale there — but ' +
        'whether to delete it is a decision this tool will not make on a ' +
        'live database',
    });
  }
  return { insert, conflicts };
}

async function carry(src, dst, { onlyMissing, since }) {
  const tables = await orderByDependency(src.id, await tablesOf(src.id));
  const dstTables = new Set(await tablesOf(dst.id));

  const plan = [];
  for (const table of tables) {
    const { cols, key, uniques } = await shapeOf(src.id, table);
    if (!dstTables.has(table)) {
      plan.push({ table, refused: 'the destination has no such table' });
      continue;
    }
    if (key.length === 0) {
      plan.push({
        table,
        refused:
          'no primary key, so nothing identifies a row: an upsert has no ' +
          'conflict target and a re-run would duplicate every row',
      });
      continue;
    }
    // The two sides must agree on the table's SHAPE before its rows are
    // compared. Reading the destination with the source's column list
    // would otherwise either fail obscurely or, where the destination has
    // columns the source lacks, quietly carry rows that leave those
    // columns at their defaults while reporting the tables identical.
    const dstShape = await shapeOf(dst.id, table);
    if (
      dstShape.cols.join() !== cols.join() ||
      dstShape.key.join() !== key.join()
    ) {
      plan.push({
        table,
        refused:
          `the two sides declare different shapes — source columns ` +
          `[${cols.join(', ')}] key [${key.join(', ')}], destination ` +
          `columns [${dstShape.cols.join(', ')}] key ` +
          `[${dstShape.key.join(', ')}]. Carrying rows across a schema ` +
          `difference is a migration decision, not a copy`,
      });
      continue;
    }
    // Each side is read ONCE. Reading the destination twice would spend a
    // second round trip to ask a question already answered, and against a
    // live destination the two answers need not even agree.
    const rows = await readAll(src.id, table, cols);
    const held = await readAll(dst.id, table, cols);
    // A NULL inside a key breaks the model this tool compares rows with:
    // two such rows are equal to JSON and to `keyOf`, but `"c" = ?` in a
    // DELETE never matches NULL, so a surplus row would silently survive
    // and verification would fail afterwards with nothing to point at.
    // SQLite permits NULL in a non-INTEGER primary key, so this is checked
    // rather than assumed.
    const nullKeyed = [...rows, ...held].find((r) =>
      key.some((c) => r[c] === null || r[c] === undefined),
    );
    if (nullKeyed) {
      plan.push({
        table,
        refused:
          `a row carries NULL in its key (${key.join(', ')}). Row identity ` +
          `is what this tool compares and deletes by, and SQL equality does ` +
          `not match NULL — so such a row can be neither reliably matched ` +
          `nor removed`,
      });
      continue;
    }
    const sourceKeys = new Set(rows.map((r) => keyOf(r, key)));
    const heldKeys = new Set(held.map((r) => keyOf(r, key)));

    // What this carry saw, for the manifest a later reconciliation reads.
    const seen = {};
    for (const r of rows) seen[keyOf(r, key)] = rowHash(r, cols);

    // RECONCILIATION IS A THREE-WAY COMPARISON, and reading it as a
    // two-way one is how three separate defects got in. For a given key
    // there are three facts — was it in the MANIFEST (so the mirror
    // carried it), is it in the SOURCE now, is it in the DESTINATION now —
    // and only ONE of the eight combinations is safe to act on
    // automatically. Everything else is somebody's decision.
    //
    //   manifest source dest
    //      no      yes   no   → a straggler inserted it. CARRY IT. The
    //                          only automatic case.
    //      no      yes  yes   → both sides independently allocated the
    //                          same key after the mirror. `notifications`
    //                          and `diag_legal_hold_audit` are
    //                          AUTOINCREMENT, so this is two DIFFERENT
    //                          records wearing one id. Inserting does
    //                          nothing and the source's record is lost.
    //      yes     yes  yes   → changed on the source: a straggler's
    //         (hash differs)   write. Which value wins is a decision.
    //      yes     yes   no   → the DESTINATION deleted it. Retention
    //                          crons delete support tickets, diagnostics,
    //                          telegram links, cancelled offers — and a
    //                          deletion can be a privacy obligation.
    //                          Re-inserting would silently undo it.
    //      yes      no    *   → the SOURCE deleted it after the mirror.
    //                          It is not in `rows` at all, so a loop over
    //                          the source never sees it and the
    //                          destination keeps a row that should be
    //                          gone.
    //
    // The tool resolves none of the four conflict cases. It names the row.
    const wasSeen = since?.[table]?.rows ?? null;
    const { insert, conflicts } = onlyMissing
      ? classifyForReconcile({
          table,
          cols,
          key,
          rows,
          sourceKeys,
          heldByKey: new Map(held.map((r) => [keyOf(r, key), r])),
          wasSeen,
          uniques,
        })
      : { insert: [], conflicts: [] };

    plan.push({
      table,
      cols,
      key,
      all: rows,
      seen,
      conflicts,
      insert,
      surplus: onlyMissing
        ? []
        : held.filter((r) => !sourceKeys.has(keyOf(r, key))),
    });
  }

  // CLASSIFY EVERYTHING, THEN ACT — and if the classification is not
  // clean, do not act at all.
  //
  // The procedure promises that a conflicted run exits without applying
  // anything. An earlier revision inserted the safe rows first and failed
  // afterwards, which left a failed command having partially mutated a
  // LIVE destination — the one place a half-finished write is least
  // recoverable, because the operator now has to work out which of the
  // rows they can see this run put there. The whole plan is built above
  // before a single statement is sent, so honouring that promise is a
  // matter of checking it here rather than of unwinding anything.
  const refused = plan.filter((s) => s.refused);
  const conflicts = plan.flatMap((s) => s.conflicts ?? []);
  const manifestOf = () => {
    const m = {};
    for (const step of plan) {
      if (step.refused) continue;
      m[step.table] = { key: step.key, rows: step.seen };
    }
    return m;
  };
  if (refused.length > 0 || conflicts.length > 0) {
    for (const r of refused) {
      console.log(`  ${r.table.padEnd(32)} REFUSED — ${r.refused}`);
    }
    console.log(
      `\nnothing was written: ${refused.length} refusal(s) and ` +
        `${conflicts.length} conflict(s) were found while planning, and a ` +
        `run that cannot do all of what it was asked does none of it.`,
    );
    return { written: 0, refused, conflicts, manifest: manifestOf() };
  }

  // Deletes run children-first, which is the reverse of the insert order,
  // for the same foreign-key reason the insert order exists.
  for (const step of [...plan].reverse()) {
    if (step.surplus.length === 0) continue;
    await deleteKeys(dst, step.table, step.surplus, step.key);
  }

  let written = 0;
  for (const step of plan) {
    const rows = onlyMissing ? step.insert : step.all;
    written += await upsert(dst, step.table, rows, step.cols, step.key, onlyMissing);
    const note = onlyMissing
      ? `${step.insert.length} missing`
      : `${step.all.length} upserted, ${step.surplus.length} removed`;
    if (step.all.length || step.surplus.length) {
      console.log(`  ${step.table.padEnd(32)} ${note}`);
    }
  }
  return { written, refused, conflicts, manifest: manifestOf() };
}

/**
 * One report, one exit code, whether the run stopped at planning or after
 * verifying. Two spellings of "here is what is wrong" drift apart, and the
 * one an operator sees least is the one that goes stale.
 *
 * "problem(s)", not "table(s)": the list mixes whole-table digest
 * differences with per-ROW conflicts, and a run reporting seventeen
 * conflicting rows in ONE table once said "17 table(s)". A count naming
 * the wrong unit is a small lie in a report whose whole job is not telling
 * them.
 */
function reportProblems(problems, dst) {
  console.error(
    `\nSTOPPED — ${problems.length} problem(s):\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      `\n\nThese are of three kinds and they do not mean the same thing. A ` +
      `DIGEST difference is not always a fault: a source with live writers ` +
      `moves on while a carry runs. A REFUSED table was not carried at ` +
      `all. A CONFLICT needs somebody to decide which value is right — and ` +
      `where conflicts were found, NOTHING was written to ${dst.name}, so ` +
      `re-running after resolving them is safe. Read the sequence in ` +
      `docs/ops/D1CutoverArchiveToWarm.md before deciding which of the ` +
      `three you are looking at.\n`,
  );
  process.exit(1);
}

// -------------------------------------------------------------------- main

const USAGE =
  'usage:\n' +
  '  d1-carry-rows.mjs digest --db <name>\n' +
  '  d1-carry-rows.mjs carry  --from <name> --to <name> --mirror --manifest <path>\n' +
  '  d1-carry-rows.mjs carry  --from <name> --to <name> --only-missing --since <path>';

/**
 * Strict parsing, because the destructive mode must never be something a
 * typo falls back to. `--only-missing=true` is a conventional spelling
 * this tool does not accept, and an exact-membership test would have read
 * it as absent and mirrored instead — against a LIVE destination, which
 * deletes rows it alone holds and overwrites its newer values. An unknown
 * argument is therefore an error, and the mode is never implied.
 */
function parseArgs(argv, { flags, switches }) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (switches.includes(a)) {
      out[a] = true;
      continue;
    }
    if (flags.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value.\n\n${USAGE}`);
      out[a] = v;
      i += 1;
      continue;
    }
    fail(
      `unrecognised argument "${a}". This tool refuses arguments it does ` +
        `not know rather than ignoring them, because an ignored mode flag ` +
        `falls back to the destructive mode.\n\n${USAGE}`,
    );
  }
  return out;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  if (!ACCOUNT || !TOKEN) {
    fail('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.');
  }
  const shared = sharedDatabase();

  if (mode === 'digest') {
    const opts = parseArgs(rest, { flags: ['--db'], switches: [] });
    const name = opts['--db'];
    if (!name) fail(`digest needs --db <name>\n\n${USAGE}`);
    const db = name === shared.name ? shared : await resolveByName(name);
    printDigest(`${db.name} (${db.id})`, await digestDatabase(db));
    return;
  }

  if (mode !== 'carry') fail(USAGE);

  const opts = parseArgs(rest, {
    flags: ['--from', '--to', '--manifest', '--since'],
    switches: ['--mirror', '--only-missing'],
  });
  const fromName = opts['--from'];
  const toName = opts['--to'];
  if (!fromName || !toName) {
    fail(`carry needs both --from <name> and --to <name>\n\n${USAGE}`);
  }
  if (fromName === toName) fail('--from and --to name the same database');
  // The guarantee is not "the destination is fixed" — that version of this
  // tool could not perform the rollback the functional spec requires. It is
  // that a carry always has the shared database at one end, so rows cannot
  // be moved between two databases this repository does not account for.
  if (fromName !== shared.name && toName !== shared.name) {
    fail(
      `neither --from "${fromName}" nor --to "${toName}" is the shared ` +
        `database (${shared.name}, per ${DECLARING_FILE}). One end of a ` +
        `carry is always the shared database.`,
    );
  }

  const src = fromName === shared.name ? shared : await resolveByName(fromName);
  const dst = toName === shared.name ? shared : await resolveByName(toName);

  // The mode is stated, never defaulted. Neither is an error; both is an
  // error; and the destructive one is not what a missing flag means.
  const wantMirror = opts['--mirror'] === true;
  const onlyMissing = opts['--only-missing'] === true;
  if (wantMirror === onlyMissing) {
    fail(
      `carry needs exactly one of --mirror or --only-missing. The mode is ` +
        `never implied: --mirror deletes destination rows the source no ` +
        `longer has and overwrites the rest, which against a live ` +
        `destination destroys its own newer values.\n\n${USAGE}`,
    );
  }

  // A mirror RECORDS what it carried; a reconciliation READS that record.
  // Without it, "the destination already has this key" cannot distinguish
  // a row a straggler changed on the source after the mirror from one the
  // destination has legitimately moved on from — see `reconcile`.
  const manifestPath = opts['--manifest'];
  const sincePath = opts['--since'];
  if (wantMirror && !manifestPath) {
    fail(
      `--mirror needs --manifest <path>: the reconciliation that follows a ` +
        `cutover is only meaningful against a record of what this carry ` +
        `saw, and writing it afterwards from memory is how the first copy ` +
        `of this database went unverified.\n\n${USAGE}`,
    );
  }
  if (onlyMissing && !sincePath) {
    fail(
      `--only-missing needs --since <path>, the manifest the mirror wrote. ` +
        `Without it this mode can insert rows the destination lacks but ` +
        `CANNOT tell a late change on the source from the destination's ` +
        `own progress — so it would report "reconciled" having checked ` +
        `nothing of the kind.\n\n${USAGE}`,
    );
  }

  console.log(
    `carrying ${src.name} (${src.id})\n` +
      `     into ${dst.name} (${dst.id})\n` +
      (onlyMissing
        ? `     mode: only-missing — rows absent from the destination are ` +
          `inserted; nothing it already holds is updated or removed, so a ` +
          `LIVE destination is safe. Rows the source changed since ` +
          `${sincePath} are reported as conflicts, not resolved`
        : `     mode: mirror — the destination is made identical to the ` +
          `source, INCLUDING removing rows the source no longer has. Run ` +
          `this only against a destination nothing is writing to`),
  );

  const since = onlyMissing ? readManifest(sincePath, src) : null;
  const { written, refused, conflicts, manifest } = await carry(src, dst, {
    onlyMissing,
    since,
  });
  if (wantMirror) writeManifest(manifestPath, src, manifest);
  console.log(`wrote ${written} row(s)`);

  // A run that wrote nothing has nothing to verify, so it says what it
  // found and stops. Digesting both databases takes minutes, and doing it
  // here would make an operator wait through them for a conflict list that
  // was decided before any of it started — during a cutover window, and
  // reporting state read long after the decision it describes.
  if (refused.length > 0 || conflicts.length > 0) {
    reportProblems(
      [
        ...refused.map((r) => `${r.table}: NOT CARRIED — ${r.refused}`),
        ...conflicts.map((c) =>
          c.key === undefined
            ? `${c.table}: cannot be reconciled — ${c.detail}`
            : `${c.table} ${c.key}: ${c.kind} — ${c.detail}.`,
        ),
      ],
      dst,
    );
  }

  // Verification is part of the carry, not a step someone may skip.
  const [srcD, dstD] = [await digestDatabase(src), await digestDatabase(dst)];
  printDigest(`source  ${src.name}`, srcD);
  printDigest(`target  ${dst.name}`, dstD);

  const refusedNames = new Set(refused.map((r) => r.table));
  const problems = [];
  for (const [table, s] of srcD) {
    if (refusedNames.has(table)) continue;
    const d = dstD.get(table);
    if (!d) {
      problems.push(`${table}: absent from the destination`);
    } else if (!onlyMissing && d.digest !== s.digest) {
      problems.push(
        `${table}: source ${s.digest} (${s.count} rows) != destination ` +
          `${d.digest} (${d.count} rows)`,
      );
    } else if (onlyMissing && d.count < s.count) {
      problems.push(
        `${table}: destination holds ${d.count} rows, fewer than the ` +
          `source's ${s.count} — rows are still missing`,
      );
    }
  }

  // A REFUSED table is not a footnote. It is a table this carry did not
  // move and cannot vouch for, so it FAILS — an earlier revision printed
  // it and then exited zero with "VERIFIED", which would let an operator,
  // or a script reading the exit code, carry the cutover forward having
  // silently omitted an entire table.
  for (const r of refused) problems.push(`${r.table}: NOT CARRIED — ${r.refused}`);

  // Likewise a conflict: the source changed a row the destination already
  // has, and which value should win is a decision, not a default.
  // A conflict names the TABLE and the KEY, and nothing else. It used to
  // print the first 300 characters of the row, which for `support_tickets`
  // is the user's message and email — the schema puts them straight after
  // the key — and for `diag_errors` whatever a stack trace carried. A
  // cutover's terminal output gets pasted into run logs and issues, so a
  // routine reconciliation conflict would have copied private content into
  // places nobody chose to put it. An operator who needs the value queries
  // for it deliberately, which is a decision with a record.
  for (const c of conflicts) {
    problems.push(
      c.key === undefined
        ? `${c.table}: cannot be reconciled — ${c.detail}`
        : `${c.table} ${c.key}: ${c.kind} — ${c.detail}.`,
    );
  }

  console.log('');
  if (problems.length > 0) reportProblems(problems, dst);
  console.log(
    onlyMissing
      ? `VERIFIED — every table the source holds is present in ${dst.name} ` +
        `with at least as many rows. This mode deliberately does not claim ` +
        `the two sides are identical: the destination is live and its own ` +
        `newer values are left alone.`
      : `VERIFIED — every table the source holds is present in ${dst.name} ` +
        `with an identical content digest.`,
  );
}

// Only run when invoked as a command. A test that imports the decision
// table must not thereby start carrying rows between live databases.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err.stack ?? String(err)));
}
