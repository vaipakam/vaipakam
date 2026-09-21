#!/usr/bin/env node
/**
 * d1-copy-into-shared — carry the rows of another D1 database into the
 * SHARED one, and prove afterwards that both sides hold the same thing.
 *
 * WHY THIS IS A CHECKED-IN SCRIPT AND NOT A PROCEDURE IN A RUNBOOK (#2214).
 * The first copy of the archive → warm cutover was done ad hoc, reported
 * success, and had silently lost a row. Nothing about that copy was
 * reproducible: the table set, the conflict keys, the batch sizing and the
 * comparison all lived in a terminal session. A cutover whose data step
 * cannot be re-run identically is a cutover that cannot be verified, and
 * the switch requires re-running it — once more after the writers stop.
 * So the step is code, with its properties enforced rather than remembered:
 *
 *   - **The target is not an argument.** It is read from
 *     `apps/indexer/wrangler.jsonc`, the single declaration of the shared
 *     database (see check-d1-name-consistency). There is no flag that
 *     makes this script write anywhere else, which is a stronger promise
 *     than checking a flag's value: an operator cannot point the copy at
 *     the database being abandoned, because that capability is absent.
 *
 *   - **Upsert, never `INSERT OR REPLACE`.** `REPLACE` is `DELETE` +
 *     `INSERT` in SQLite, and a delete fires `ON DELETE CASCADE`. That is
 *     exactly how the first copy lost a `user_thresholds` row: tables were
 *     written alphabetically, the child landed first, and rewriting the
 *     parent `notify_state` row cascaded it away. `ON CONFLICT (…) DO
 *     UPDATE` mutates in place, fires no cascade, does not depend on the
 *     order tables happen to be named in, and is safe to run twice.
 *
 *   - **Verification compares CONTENT, not counts.** Two tables can hold
 *     the same number of rows and disagree about every one of them — which
 *     is not hypothetical here: the count check passed on `indexer_cursor`
 *     and `recycle_backing_snapshot` while both were in fact different.
 *     `digest` canonicalises each table's rows and hashes them, so equal
 *     digests mean equal contents and nothing weaker is reported as
 *     verification.
 *
 *   - **A table it cannot copy safely is NAMED, not skipped quietly.** An
 *     upsert needs a conflict target, so a table with no primary key is
 *     refused and reported, rather than copied with plain inserts that
 *     would duplicate rows on a second run.
 *
 * `d1_migrations` is deliberately never copied: the target's record of
 * which migrations have run there is its own, and overwriting it with the
 * source's would assert that migrations had run against the target which
 * never did.
 *
 * USAGE
 *
 *   # what each side holds, table by table
 *   node apps/indexer/scripts/d1-copy-into-shared.mjs digest --db vaipakam-archive
 *   node apps/indexer/scripts/d1-copy-into-shared.mjs digest --shared
 *
 *   # carry the rows in, then compare both sides
 *   node apps/indexer/scripts/d1-copy-into-shared.mjs copy --from vaipakam-archive
 *
 * `digest` is also the drain barrier the cutover runbook uses: run it
 * twice against the source with a gap, and identical digests are the
 * evidence that nothing is still writing. See
 * `docs/ops/D1CutoverArchiveToWarm.md`.
 *
 * ENVIRONMENT: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (a token
 * with D1 read+write). The script talks to the D1 HTTP API rather than
 * shelling out to `wrangler d1 execute`, because the API binds parameters:
 * a copy that builds SQL by string-formatting its values is a copy whose
 * correctness depends on quoting every type right, and this one moves
 * money-adjacent rows.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

/** The single declaration of the shared database. */
const DECLARING_FILE = 'apps/indexer/wrangler.jsonc';

/**
 * Never copied. `sqlite_*` and `_cf_*` are the engine's and the platform's
 * own (`_cf_KV` refuses to be read at all — SQLITE_AUTH); `d1_migrations`
 * is the target's own record of its own history.
 */
const NEVER_COPIED = (t) =>
  t.startsWith('sqlite_') || t.startsWith('_cf_') || t === 'd1_migrations';

/**
 * D1 caps the number of bound parameters in one statement. 90 is the
 * working headroom the archive → warm copy was sized against; rows per
 * batch is therefore floor(90 / columns), which is why wide tables go in
 * twos and narrow ones in thirties.
 */
const MAX_PARAMS = 90;

/** Rows pulled per SELECT. Bounds the response, not the total. */
const PAGE = 500;

// ---------------------------------------------------------------- plumbing

function fail(msg) {
  console.error(`\n[d1-copy-into-shared] ${msg}\n`);
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

/** The shared database, as the repository declares it. Not overridable. */
function sharedDatabase() {
  const cfg = parseJsonc(
    readFileSync(join(REPO, DECLARING_FILE), 'utf8'),
    DECLARING_FILE,
  );
  const entry = (cfg.d1_databases ?? []).find((e) => e.binding === 'DB');
  if (!entry?.database_name || !entry?.database_id) {
    fail(
      `${DECLARING_FILE} has no complete "DB" d1 binding. That file is the ` +
        `single declaration of the shared database, so this script has no ` +
        `target it is willing to trust.`,
    );
  }
  return {
    name: checked(entry.database_name, DB_NAME, `${DECLARING_FILE} database_name`),
    id: checked(entry.database_id, UUID, `${DECLARING_FILE} database_id`),
  };
}

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';

/**
 * A D1 database id, as the declaration and the API both spell it. The
 * script builds request paths out of this value, so it is checked against
 * the shape rather than trusted for being in a committed file: a
 * config that has been mis-edited should fail here, naming the field,
 * rather than becoming part of a URL.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A database name, as `wrangler d1` accepts it. Same reasoning. */
const DB_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Table and column names. Values are BOUND, never spliced — but an
 * identifier cannot be bound, so every one that reaches a statement is
 * checked against this first. They come from `sqlite_master` and
 * `PRAGMA table_info` on the source database rather than from a person,
 * which makes this a guard on the source being what it claims to be
 * rather than on user input.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checked(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${what} is not a well-formed value: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * One request, against a path RELATIVE TO THE ACCOUNT. The account id is
 * joined here and nowhere else, so it cannot reach a log line: an error
 * from this function names the account-relative endpoint, which is what
 * diagnoses a failure, and the credentials and account identity stay out
 * of the diagnosis entirely.
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
    // bug in the first copy looked like a bare "HTTP 400" for as long as
    // the wrapper printed only the status.
    lastErr = new Error(
      `HTTP ${res.status} on ${subpath}\n${text.slice(0, 2000)}`,
    );
    if (res.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw lastErr;
}

/** One statement against one database. `params` are bound, never spliced. */
async function query(dbId, sql, params = []) {
  const result = await cf(`/d1/database/${checked(dbId, UUID, 'database id')}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql, params }),
  });
  return result?.[0]?.results ?? [];
}

async function resolveByName(name) {
  checked(name, DB_NAME, 'database name');
  const list = await cf(`/d1/database?name=${encodeURIComponent(name)}`);
  const hit = (list ?? []).find((d) => d.name === name);
  if (!hit) fail(`no D1 database named "${name}" in this account`);
  return { name, id: checked(hit.uuid, UUID, `id the API reports for ${name}`) };
}

// ------------------------------------------------------------ table shapes

async function tablesOf(dbId) {
  const rows = await query(
    dbId,
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  return rows
    .map((r) => checked(r.name, IDENT, 'table name from sqlite_master'))
    .filter((t) => !NEVER_COPIED(t));
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
    .map((c) => c.name);
  return { cols, key };
}

/**
 * Every row, in an order the caller does not have to trust: rows are
 * sorted here by their canonical form, so the digest is independent of
 * what order the database chose to return them in.
 */
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

function digestOf(rows, cols) {
  const lines = rows.map((r) => canonical(r, cols)).sort();
  const h = createHash('sha256');
  for (const l of lines) h.update(l).update('\n');
  return { digest: h.digest('hex').slice(0, 16), count: rows.length };
}

async function digestDatabase(db) {
  const tables = await tablesOf(db.id);
  const out = new Map();
  for (const table of tables) {
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
  console.log(`  ${'—'.repeat(32)} ${String(rows).padStart(6)}  (${map.size} tables)`);
}

// ------------------------------------------------------------------- copy

async function copyTable(src, dst, table) {
  const shape = await shapeOf(src.id, table);
  const { cols, key } = shape;
  if (key.length === 0) {
    return {
      table,
      skipped:
        'no primary key, so there is no conflict target for an upsert. ' +
        'Copying it with plain inserts would duplicate every row on a ' +
        'second run, and this script is required to be re-runnable.',
    };
  }
  const rows = await readAll(src.id, table, cols);
  if (rows.length === 0) return { table, copied: 0 };

  const nonKey = cols.filter((c) => !key.includes(c));
  const quoted = cols.map((c) => `"${c}"`).join(', ');
  const conflict = key.map((c) => `"${c}"`).join(', ');
  // A key-only table has nothing to update; `DO NOTHING` is the honest
  // upsert there, and still re-runnable.
  const update =
    nonKey.length === 0
      ? 'NOTHING'
      : `UPDATE SET ${nonKey.map((c) => `"${c}" = excluded."${c}"`).join(', ')}`;

  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    const placeholders = batch
      .map(() => `(${cols.map(() => '?').join(', ')})`)
      .join(', ');
    const params = batch.flatMap((r) => cols.map((c) => r[c] ?? null));
    await query(
      dst.id,
      `INSERT INTO "${table}" (${quoted}) VALUES ${placeholders} ` +
        `ON CONFLICT (${conflict}) DO ${update}`,
      params,
    );
  }
  return { table, copied: rows.length, perBatch };
}

// ------------------------------------------------------------------- main

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const arg = (flag) => {
    const i = rest.indexOf(flag);
    return i === -1 ? null : rest[i + 1];
  };

  if (!ACCOUNT || !TOKEN) {
    fail('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.');
  }

  const shared = sharedDatabase();

  if (mode === 'digest') {
    const db = rest.includes('--shared')
      ? shared
      : await resolveByName(arg('--db') ?? fail('digest needs --db <name> or --shared'));
    printDigest(`${db.name} (${db.id})`, await digestDatabase(db));
    return;
  }

  if (mode === 'copy') {
    const from = arg('--from');
    if (!from) fail('copy needs --from <source database name>');
    const src = await resolveByName(from);
    if (src.id === shared.id) {
      fail(
        `--from names the shared database itself (${shared.name}). The ` +
          `target is always the shared database, so this would copy it ` +
          `onto itself.`,
      );
    }
    console.log(
      `copying ${src.name} (${src.id})\n     into ${shared.name} (${shared.id}) ` +
        `— target read from ${DECLARING_FILE}, not from an argument`,
    );

    const skipped = [];
    let total = 0;
    for (const table of await tablesOf(src.id)) {
      const r = await copyTable(src, shared, table);
      if (r.skipped) {
        skipped.push(r);
        console.log(`  ${r.table.padEnd(32)} NOT COPIED — ${r.skipped}`);
        continue;
      }
      total += r.copied;
      console.log(
        `  ${r.table.padEnd(32)} ${String(r.copied).padStart(6)}` +
          (r.copied ? `  (batches of ${r.perBatch})` : ''),
      );
    }
    console.log(`copied ${total} row(s)`);

    // Verification is part of the copy, not a step someone may skip.
    const [srcD, dstD] = [
      await digestDatabase(src),
      await digestDatabase(shared),
    ];
    printDigest(`source  ${src.name}`, srcD);
    printDigest(`target  ${shared.name}`, dstD);

    const differ = [];
    for (const [table, s] of srcD) {
      const d = dstD.get(table);
      if (!d) differ.push(`${table}: absent from the target`);
      else if (d.digest !== s.digest) {
        differ.push(
          `${table}: source ${s.digest} (${s.count} rows) != target ` +
            `${d.digest} (${d.count} rows)`,
        );
      }
    }
    // Tables the target has and the source does not are reported, not
    // treated as failure: the target is a live database with a history of
    // its own, and the copy adds to it rather than replacing it.
    const extra = [...dstD.keys()].filter((t) => !srcD.has(t));

    console.log('');
    if (extra.length > 0) {
      console.log(`target-only tables (not part of this copy): ${extra.join(', ')}`);
    }
    if (skipped.length > 0) {
      console.log(
        `NOT COPIED: ${skipped.map((s) => s.table).join(', ')} — see above.`,
      );
    }
    if (differ.length > 0) {
      console.error(
        `\nVERIFICATION FAILED — ${differ.length} table(s) differ:\n` +
          differ.map((d) => `  - ${d}`).join('\n') +
          `\n\nA difference here is not always a copy fault: if the source ` +
          `still has live writers, it moves on while the copy runs. That is ` +
          `precisely why the cutover takes its final copy with the writers ` +
          `stopped — re-read the drain barrier in ` +
          `docs/ops/D1CutoverArchiveToWarm.md before deciding which of the ` +
          `two this is.\n`,
      );
      process.exit(1);
    }
    console.log(
      `VERIFIED — every table the source holds is present in ` +
        `${shared.name} with an identical content digest` +
        (skipped.length > 0 ? `, except the NOT COPIED table(s) named above` : '') +
        `.`,
    );
    return;
  }

  fail(
    'usage:\n' +
      '  d1-copy-into-shared.mjs digest --db <name>\n' +
      '  d1-copy-into-shared.mjs digest --shared\n' +
      '  d1-copy-into-shared.mjs copy   --from <name>',
  );
}

main().catch((err) => fail(err.stack ?? String(err)));
