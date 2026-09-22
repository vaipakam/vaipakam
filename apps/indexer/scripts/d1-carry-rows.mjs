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
 *   - **BOTH ends are pinned**, as constants in this file — the shared
 *     database and its recorded predecessor, by id as well as name.
 *     Neither is read from a Worker binding: a binding says what the
 *     Workers are attached to right now, and the barrier this tool runs
 *     behind deliberately removes all three. Either direction between those
 *     two is allowed, which is what leaves the documented ROLLBACK
 *     performable; nothing else is, in either direction. Two weaker
 *     versions of this came first and both are worth remembering:
 *     fixing the DESTINATION made the rollback impossible to perform,
 *     and requiring only that the shared database be ONE end permitted an
 *     unrelated account database to be mirrored over the live shared data
 *     — while being described as the restriction that prevented it. See
 *     `PREDECESSOR`.
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
 *   - **Nothing is ever written to a LIVE database.** `carry --mirror`
 *     writes, and runs only against a destination nothing is writing to.
 *     The post-switch step is `reconcile`, which READS BOTH SIDES AND
 *     REPORTS — it has no write path at all.
 *
 *     That is a deliberate reduction. `reconcile` was `carry
 *     --only-missing`, which inserted the rows the destination lacked, and
 *     review found the insert unsafe from a new direction every round: a
 *     secondary unique index can be filled between the preflight read and
 *     the statement, and no preflight closes that — a check against a live
 *     database is a statement about the moment it read, not a lock. Rather
 *     than a better preflight, the write is gone. The one case that used
 *     to be applied mechanically is now reported with the rest, and a
 *     person applies it. For a straggler count expected to be zero, that
 *     is a better trade than a race nobody can close.
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
 *   # post-switch: destination LIVE. READ ONLY — reports, never writes.
 *   # --since is what lets it tell a straggler's late write from the
 *   # destination's own progress.
 *   node apps/indexer/scripts/d1-carry-rows.mjs reconcile \
 *     --from vaipakam-archive --to vaipakam-warm \
 *     --since cutover-mirror.json
 *
 * The mode is never implied and unknown arguments are refused: a mistyped
 * flag must not fall back to mirroring over a live database.
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

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PREDECESSOR, SUCCESSOR } from "./lib/cutover-databases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

/**
 * BOTH ENDPOINTS come from one pinned pair — see
 * `lib/cutover-databases.mjs` for why they are pinned by id as well as
 * name, and why they are not read from a Worker binding. Either direction
 * between the two is allowed, which is what leaves the documented ROLLBACK
 * performable; nothing else is, in either direction.
 */
const NEVER_CARRIED = (t) =>
  t.startsWith("sqlite_") || t.startsWith("_cf_") || t === "d1_migrations";

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
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
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
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
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
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${what} is not a well-formed value: ${JSON.stringify(value)}`);
  }
  return value;
}

function sharedDatabase() {
  return {
    name: checked(SUCCESSOR.name, DB_NAME, "SUCCESSOR.name"),
    id: checked(SUCCESSOR.id, UUID, "SUCCESSOR.id"),
  };
}

// ----------------------------------------------------------------- transport

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const API = "https://api.cloudflare.com/client/v4";

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
          "Content-Type": "application/json",
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
  const result = await cf(
    `/d1/database/${checked(dbId, UUID, "database id")}/query`,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
  return result?.[0]?.results ?? [];
}

async function resolveByName(name) {
  checked(name, DB_NAME, "database name");
  const list = await cf(`/d1/database?name=${encodeURIComponent(name)}`);
  const hit = (list ?? []).find((d) => d.name === name);
  if (!hit) fail(`no D1 database named "${name}" in this account`);
  return {
    name,
    id: checked(hit.uuid, UUID, `id the API reports for ${name}`),
  };
}

// -------------------------------------------------------------- table shapes

async function tablesOf(dbId) {
  const rows = await query(
    dbId,
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
  );
  return rows
    .map((r) => checked(r.name, IDENT, "table name from sqlite_master"))
    .filter((t) => !NEVER_CARRIED(t));
}

/** Column order and primary key, as the table itself declares them. */
/**
 * Why this tool cannot reproduce a declared uniqueness — or `null` if it
 * can, which is the ordinary case.
 *
 * `idx` is a `PRAGMA index_list` row and `terms` its `PRAGMA index_xinfo`
 * key terms. Both are readings rather than parses of the declaration,
 * which is the point: enumerating what a CREATE INDEX can say is the
 * unbounded predicate this codebase keeps being bitten by, and SQLite
 * will answer the question directly.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function unsupportedUniqueReason(idx, terms) {
  if (idx.partial === 1)
    return "it is a PARTIAL index, so it constrains only some rows";
  if (terms.some((c) => typeof c.name !== "string")) {
    return "it indexes an EXPRESSION, which has no column to compare";
  }
  const collated = [
    ...new Set(
      terms
        .map((c) => c.coll)
        .filter((c) => typeof c === "string" && c.toUpperCase() !== "BINARY"),
    ),
  ];
  if (collated.length > 0) {
    return (
      `it uses collation(s) ${collated.join(", ")}, under which values ` +
      `this tool would read as different are the same row`
    );
  }
  return null;
}

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
  //
  // A UNIQUENESS THIS TOOL CANNOT REPRODUCE IS NAMED, NOT SIMPLIFIED
  // (#2267 r41). `PRAGMA index_info` answers with bare column names,
  // which quietly discards three things that change what the index
  // actually rejects:
  //
  //   - a COLLATION. `UNIQUE(name COLLATE NOCASE)` makes `ALICE` and
  //     `alice` the same row to the destination and different rows to a
  //     comparison over raw values, so a row would be reported as
  //     plainly missing and then rejected on insert.
  //   - a PARTIAL predicate. `UNIQUE(x) WHERE archived = 0` constrains
  //     only some rows, so treating it as total invents collisions that
  //     the destination would not raise — the inverse error.
  //   - an EXPRESSION term. `UNIQUE(lower(email))` has no column name at
  //     all, and the old filter dropped those terms and kept the rest,
  //     which is worse than dropping the index: a two-term index became
  //     a one-term index and reported collisions on the wrong tuple.
  //
  // `index_xinfo` gives the collation per term and `index_list` gives
  // `partial`, both verified against the live D1, so this is a reading
  // rather than a parse of the declaration. Anything outside what the
  // tuple comparison can honestly reproduce is returned with a reason
  // and reported by the caller.
  const uniques = [];
  const unsupportedUniques = [];
  for (const idx of await query(dbId, `PRAGMA index_list("${table}")`)) {
    if (idx.unique !== 1) continue;
    const parts = await query(dbId, `PRAGMA index_xinfo("${idx.name}")`);
    // `key: 0` rows are the rowid/auxiliary terms every index carries,
    // not part of the constraint.
    const terms = [...parts]
      .filter((c) => c.key === 1)
      .sort((a, b) => a.seqno - b.seqno);
    const why = unsupportedUniqueReason(idx, terms);
    const columns = terms
      .map((c) => c.name)
      .filter((n) => typeof n === "string");
    if (why !== null) {
      // A PRIMARY KEY RESTATED ELSEWHERE is already how rows are
      // matched, so an unusable duplicate of it is not a loss and is not
      // worth reporting. The test is only sound when every term has a
      // name: for an expression index `columns` is the NAMED subset, and
      // `UNIQUE(id, lower(email))` on a table keyed by `id` would reduce
      // to exactly the key and be dropped silently — the same
      // partial-list mistake this whole change is about, one level up
      // (self-review, #2267 r41).
      const fullyNamed = columns.length === terms.length;
      if (!fullyNamed || columns.join() !== key.join()) {
        unsupportedUniques.push({ name: idx.name, why });
      }
      continue;
    }
    if (columns.length === 0) continue;
    if (columns.join() === key.join()) continue;
    uniques.push({
      name: idx.name,
      columns: columns.map((c) =>
        checked(c, IDENT, `unique column in ${table}`),
      ),
    });
  }
  // THE DECLARATION ITSELF, not a list of the parts of it we remembered
  // to look at. Two revisions of this compared column names, then column
  // names plus unique tuples plus some foreign-key fields — and each time
  // review named something else that differs while those match: column
  // types, nullability, defaults, CHECK constraints, triggers, foreign-key
  // update and deferral semantics. Enumerating schema features is the same
  // unbounded predicate as enumerating writers, and it fails the same way:
  // a list that reads complete and is not.
  //
  // So the comparison is over the CREATE statements SQLite itself stores,
  // for the table and for every index on it. Whitespace is normalised
  // because it is not semantic; nothing else is. Anything the two sides
  // declare differently shows up, including things nobody thought of.
  const ddl = await declarationOf(dbId, table);
  return { cols, key, uniques, unsupportedUniques, ddl };
}

/**
 * Collapse runs of whitespace, EXCEPT inside quoted text.
 *
 * The comparison exists so two schemas that differ anywhere show up, and a
 * blanket `\s+ → ' '` quietly exempted the contents of every string
 * literal: SQLite keeps `DEFAULT 'a  b'` and `DEFAULT 'a b'` as different
 * declarations, and this made them the same string (#2267 r25). Defaults,
 * CHECK constraint values and trigger bodies all live inside quotes, so
 * the one thing the normaliser must not touch is the one place a
 * difference can hide while everything around it matches.
 *
 * Single quotes delimit SQL string literals, double quotes and backticks
 * delimit identifiers, and a delimiter is escaped by doubling it — which
 * needs no special case here, since the closing quote of the first pair
 * simply opens the next.
 */
export function collapseOutsideLiterals(sql) {
  let out = "";
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (!out.endsWith(" ")) out += " ";
      continue;
    }
    out += ch;
  }
  return out.trim();
}

/**
 * The normalised `CREATE TABLE` / `CREATE INDEX` text for a table, as
 * `sqlite_master` holds it. Indexes are sorted by name so the comparison
 * does not depend on creation order.
 */
async function declarationOf(dbId, table, { fresh = false } = {}) {
  const all = await declarations(dbId, { fresh });
  return all.get(table) ?? "";
}

/**
 * Every table's declaration, in ONE query per database, cached.
 *
 * It was one query PER TABLE, and per side — 43 tables × 2 databases is
 * 86 round trips added to a step that runs inside the cutover window with
 * the writers stopped. The whole of `sqlite_master` is a few kilobytes
 * here; asking for it once is the same information at 1/86th the latency,
 * and the window is the scarce thing.
 */
const _declCache = new Map();
/**
 * `fresh` bypasses the cache, and a stability pass MUST pass it (#2281
 * r3). The cache is right for a window where the writers are stopped and
 * the same declaration is asked for repeatedly. It is exactly wrong for
 * a second reading taken to detect a change: the "second" read returned
 * the first read's answer, so the revalidation added a round earlier
 * could not fail — an inert check, of precisely the kind this PR has
 * been catching elsewhere, in my own fix for it.
 */
async function declarations(dbId, { fresh = false } = {}) {
  const hit = _declCache.get(dbId);
  if (hit && !fresh) return hit;
  const rows = await query(
    dbId,
    `SELECT type, name, tbl_name, sql FROM sqlite_master ` +
      `WHERE sql IS NOT NULL ORDER BY type, name`,
  );
  const byTable = new Map();
  for (const r of rows) {
    if (typeof r.sql !== "string" || typeof r.tbl_name !== "string") continue;
    const line = `${r.type} ${r.name}: ${collapseOutsideLiterals(r.sql)}`;
    byTable.set(r.tbl_name, [...(byTable.get(r.tbl_name) ?? []), line]);
  }
  const out = new Map();
  for (const [t, lines] of byTable) out.set(t, lines.sort().join("\n"));
  _declCache.set(dbId, out);
  return out;
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
      if (typeof parent === "string" && parent !== t && parentsOf.has(parent)) {
        parentsOf.get(t).add(parent);
      }
    }
  }
  const state = new Map();
  const ordered = [];
  const visit = (t, stack) => {
    if (state.get(t) === "done") return;
    if (state.get(t) === "active") {
      fail(
        `foreign-key cycle: ${[...stack, t].join(" → ")}. No insert order ` +
          `satisfies a cycle, so this needs deferred constraints and a ` +
          `decision — it is not something this tool should guess at.`,
      );
    }
    state.set(t, "active");
    for (const p of parentsOf.get(t)) visit(p, [...stack, t]);
    state.set(t, "done");
    ordered.push(t);
  };
  for (const t of tables) visit(t, []);
  return ordered;
}

// -------------------------------------------------------------------- rows

/**
 * A PAGED READ IS NOT A SNAPSHOT, and this tool must not treat one as if
 * it were.
 *
 * Each `LIMIT/OFFSET` page is a separate statement against a database that
 * may be changing. A row inserted between pages whose sort position falls
 * into a page already read is never returned by any of them — it is
 * skipped entirely, silently, and the caller cannot tell. `activity_events`
 * holds 1,125 rows against a `PAGE` of 500, so this table really does
 * page, and a straggler inserting an older event is precisely the row the
 * reconciliation exists to find.
 *
 * Raising `PAGE` past the table size would hide it until the data grew.
 * Keyset paging does not fix it either: a row inserted behind the cursor
 * is still missed. What is actually available is to READ TWICE AND
 * COMPARE — if two complete passes agree, nothing moved across them and
 * the result is a consistent view; if they disagree, the database is
 * moving and any conclusion drawn from one pass is unsound.
 *
 * Against the quiesced source the cutover requires, the second pass agrees
 * first time and costs one extra read. Against a moving database it fails
 * loudly, which is the correct outcome: `reconcile` reporting "clean" from
 * a read that may have skipped a row is exactly the false pass this whole
 * change keeps removing.
 *
 * `run` is the statement executor, injectable so the moving-database case
 * can be driven deliberately — a rehearsal against a quiesced source
 * agrees on the first comparison every time and therefore demonstrates
 * nothing. `apps/indexer/test/d1Reconcile.test.ts` inserts a row between
 * two pages, at a sort position the first pass has already read, and
 * asserts it is in the result.
 */
export async function readAll(
  dbId,
  table,
  cols,
  run = query,
  { key = null, live = false } = {},
) {
  const quoted = cols.map((c) => `"${c}"`).join(", ");

  // A LIVE SIDE CANNOT BE ASKED TO HOLD STILL, AND DOES NOT HAVE TO
  // (#2267 r42).
  //
  // The two-pass gate below is the right instrument for the SOURCE of a
  // mirror: it is supposed to be stopped, and a disagreement means the
  // barrier is not closed. Pointing it at the destination of the weekly
  // reconciliation asks a database taking writes every minute to stop —
  // which the runbook explicitly does not do — so a busy paged table
  // like `activity_events` would abort the run and tell the operator to
  // close a barrier that is not supposed to exist. A check that cannot
  // pass, once more, arrived at from the other side.
  //
  // What the gate is really protecting against is OFFSET paging: delete
  // a row from an earlier page and every later row shifts up into a page
  // already read, so a row that was there for the whole read is missed
  // with no sign. Paging by the primary key instead removes that, which
  // is why this is a different read rather than the same read with the
  // check turned off. Every row present for the whole read is returned
  // exactly once; a row created or deleted DURING it may or may not
  // appear, which for a live destination is not an error but a fact
  // about the question.
  //
  // Row-value comparison (`(a, b) > (?, ?)`) is SQLite ≥3.15 and was
  // verified against the live D1 before being relied on.
  if (live) {
    if (key === null || key.length === 0) {
      fail(
        `readAll("${table}") was asked for a live read without a key to ` +
          `page by. Without one the only paging available is OFFSET, ` +
          `which a concurrent DELETE tears silently — the exact failure ` +
          `the stability gate exists to catch, with the gate turned off.`,
      );
    }
    const keyCols = key.map((c) => `"${c}"`).join(", ");
    const lhs = key.length === 1 ? keyCols : `(${keyCols})`;
    const rhs = key.length === 1 ? "?" : `(${key.map(() => "?").join(", ")})`;
    const out = [];
    let cursor = null;
    for (;;) {
      const where = cursor === null ? "" : `WHERE ${lhs} > ${rhs} `;
      const rows = await run(
        dbId,
        `SELECT ${quoted} FROM "${table}" ${where}ORDER BY ${keyCols} LIMIT ${PAGE}`,
        cursor ?? [],
      );
      out.push(...rows);
      if (rows.length < PAGE) return out;
      const last = rows[rows.length - 1];
      cursor = key.map((c) => last[c]);
    }
  }

  const onePass = async () => {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await run(
        dbId,
        `SELECT ${quoted} FROM "${table}" ORDER BY ${quoted} LIMIT ${PAGE} OFFSET ${offset}`,
      );
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  };

  // A table read by ONE statement cannot be torn by paging at all, so the
  // second pass is only needed once paging actually happened — and fewer
  // than PAGE rows in total IS that test, not an approximation of it: the
  // loop continues only when a page came back full, so any pass that
  // issued a second statement has already collected PAGE rows from the
  // first. `< PAGE` and "one statement" are the same condition here.
  let first = await onePass();
  if (first.length < PAGE) return first;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const second = await onePass();
    if (digestOf(second, cols).digest === digestOf(first, cols).digest) {
      return second;
    }
    first = second;
  }
  fail(
    `"${table}" changed while it was being read, three times running. It ` +
      `spans more than one page (${PAGE} rows), so a row inserted between ` +
      `pages can fall into a page already read and be skipped without any ` +
      `sign — which would let a reconciliation report "clean" having never ` +
      `seen it.\n\nThis is what a source that has NOT stopped looks like. ` +
      `Close the barrier (check-live-d1-bindings.mjs --writers-held) and ` +
      `run again.`,
  );
}

/**
 * A COLUMN THE ROW'S TABLE DOES NOT HAVE, which is not the same fact as a
 * column holding NULL (#2267 r39).
 *
 * It matters only on one side of one comparison — the destination's row,
 * projected onto the manifest's columns, in the weekly reconciliation —
 * and there it matters a lot. A post-cutover migration can DROP a column
 * the retained source still has; `row[c] ?? null` then reports the same
 * value for "this table no longer has that column" and for "a straggler
 * set it to NULL", so a late write of NULL reads as the two sides
 * agreeing and is never reported.
 *
 * An object cannot collide with any value D1 returns — those are JSON
 * scalars — and its serialisation cannot collide with a string either,
 * since a string holding this same text serialises quoted.
 */
const ABSENT_COLUMN = { __columnNotInTable: true };

/**
 * JSON of the values in declared column order — null and "" stay distinct.
 *
 * `present`, when given, is the set of columns the row's own table has;
 * anything outside it serialises as absent rather than as NULL. Callers
 * that are comparing rows from ONE table leave it out.
 */
const canonical = (row, cols, present = null) =>
  JSON.stringify(
    cols.map((c) =>
      present !== null && !present.has(c) ? ABSENT_COLUMN : (row[c] ?? null),
    ),
  );

/** A row's identity-independent content, short enough to store per row. */
const rowHash = (row, cols, present = null) =>
  createHash("sha256")
    .update(canonical(row, cols, present))
    .digest("hex")
    .slice(0, 16);

function digestOf(rows, cols) {
  const lines = rows.map((r) => canonical(r, cols)).sort();
  const h = createHash("sha256");
  for (const l of lines) h.update(l).update("\n");
  return { digest: h.digest("hex").slice(0, 16), count: rows.length };
}

/**
 * A sequence high-water mark, or a refusal — never a rounded one.
 *
 * `sqlite_sequence.seq` is a 64-bit integer and this file compares
 * those marks for EQUALITY to decide whether anything was allocated
 * during an interval. Past 2^53 a JavaScript number cannot hold every
 * one of them: 9007199254740993 becomes 9007199254740992, so a mark
 * that MOVED compares equal to one that did not, and a reconstruction
 * taken after that allocation can be promoted and license the rollback
 * (#2281 r11).
 *
 * Refusing is the honest answer rather than a shortcoming. Reaching
 * this range takes nine quadrillion allocations, so no real database
 * arrives here — but a comparison that silently equates two different
 * values is a check that has stopped checking, and this file's whole
 * subject is not doing that. The alternative, carrying exact decimal
 * strings end to end, would change the manifest format that artifacts
 * already on disk are written in, for a case that cannot occur.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function exactSequence(raw) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || String(n) !== String(raw).trim()) {
    return null;
  }
  return n;
}

/**
 * Is this the specific error that means "nothing has ever allocated"?
 *
 * It has to be exactly that and nothing near it. `\b` is what keeps
 * `sqlite_sequence_nope` — or any other table whose name merely starts
 * the same way — from being read as the one case it is safe to treat as
 * empty. A missing application table, a network failure or an auth
 * failure must all still propagate: a check that could not run is not a
 * check that passed, which is the rule this whole tool is built on.
 *
 * The shape is the live one, confirmed against the D1 API on 2026-09-21:
 * `{"code":7500,"message":"no such table: <name>: SQLITE_ERROR"}`, which
 * `cf()` re-throws with the response body in the message.
 */
export function isMissingSequenceTable(err) {
  return /no such table: sqlite_sequence\b/.test(String(err?.message ?? err));
}

/**
 * AUTOINCREMENT tables promise never to reuse an identifier, and rows
 * alone do not carry that promise.
 *
 * `sqlite_sequence` holds the highest id ever allocated, which stays above
 * `MAX(rowid)` once the highest row is deleted — a retention prune on
 * `notifications` does exactly that. Carrying the surviving rows advances
 * the destination's sequence only to their maximum, so the destination
 * goes on to REISSUE identifiers the source promised were spent (#2267
 * r25). After the switch those are new records wearing old ids; on a
 * rollback they are the `key-collision` case, one id and two different
 * records.
 *
 * THIS REPORTS AND DOES NOT REPAIR, deliberately. Raising a destination's
 * sequence means writing SQLite's own bookkeeping table, and the only
 * thing that could otherwise raise it is inserting rows that do not
 * exist. Which identifiers a database may allocate is an allocation
 * decision, not a copy — the same reason a schema difference is refused
 * here rather than migrated around.
 *
 * Measured 2026-09-21: archive and warm both hold `notifications` at
 * seq=46, max(rowid)=46, and `diag_legal_hold_audit` has never allocated.
 * So there is no gap today, and this check exists for the prune that
 * happens between now and the window.
 */
async function sequenceProblems(src, dst) {
  const read = async (db) => {
    const out = new Map();
    let rows;
    try {
      rows = await query(db.id, "SELECT name, seq FROM sqlite_sequence");
    } catch (err) {
      // SQLite creates `sqlite_sequence` on the first AUTOINCREMENT
      // allocation and not before, so a database where none has ever
      // happened does not have the table at all and the query is an
      // error rather than an empty result. That case is genuinely "no
      // identifiers promised", so it is empty — but ONLY that case. Any
      // other failure here is a failure to check, and this tool does not
      // report a check it could not perform as a check that passed.
      if (!isMissingSequenceTable(err)) throw err;
      return out;
    }
    for (const r of rows) {
      if (NEVER_CARRIED(r.name)) continue;
      out.set(r.name, Number(r.seq));
    }
    return out;
  };
  const [a, b] = [await read(src), await read(dst)];
  const problems = [];
  for (const [table, seq] of a) {
    const held = b.get(table);
    if (held !== undefined && held >= seq) continue;
    problems.push(
      `${table}: the source has allocated identifiers up to ${seq}, the ` +
        `destination ${held === undefined ? "has allocated none" : `only to ${held}`}` +
        `.\n      Rows carry values, not the promise that an identifier is ` +
        `spent, so the destination would reissue ${
          held === undefined ? 1 : held + 1
        }..${seq} to different records. Raising it is an allocation ` +
        `decision for a person, not something this tool does on its own.`,
    );
  }
  return problems;
}

/**
 * Did the SOURCE allocate past what the mirror recorded?
 *
 * This is the reconcile-side counterpart of `sequenceProblems`. A row
 * inserted after the mirror and then deleted leaves no trace in the rows
 * — both sides match again — while `sqlite_sequence` on the source has
 * moved. The destination is free to issue that identifier to a different
 * record, and a later rollback would then have one id and two records,
 * which is the `key-collision` case arriving by a route nothing looks
 * at.
 *
 * Reported, never repaired, like everything else this mode finds.
 */
async function sequenceAdvances(src, dst, since) {
  if (!since) return [];
  const read = async (db) => {
    const out = new Map();
    try {
      for (const r of await query(
        db.id,
        "SELECT name, seq FROM sqlite_sequence",
      )) {
        if (!NEVER_CARRIED(r.name)) out.set(r.name, Number(r.seq));
      }
    } catch (err) {
      if (!isMissingSequenceTable(err)) throw err;
    }
    return out;
  };
  return compareSequences(await read(src), since, await read(dst));
}

/**
 * The comparison, separated from the read so it can be tested.
 *
 * A manifest written before this field existed has no `seq`, and a table
 * the mirror did not carry has no entry at all. Neither is a comparison,
 * and treating either as zero would report every allocation the source
 * has ever made as a late one — which on the first weekly run would bury
 * the real signal under 43 lines of noise.
 */
export function compareSequences(now, since, held = new Map()) {
  const problems = [];
  for (const [table, seq] of now) {
    const then = since?.[table]?.seq;
    if (then === undefined || then === null) continue;
    if (seq <= then) continue;
    // NUMERICAL CATCH-UP IS NOT EVIDENCE OF RESOLUTION, and treating it
    // as such was wrong (#2267 r39, reversing r38).
    //
    // r38 skipped the report once the destination's own sequence reached
    // the source's, reasoning that applying the late row advances it. It
    // does — but so does the LIVE destination allocating an identifier of
    // its own, for an unrelated record, which is the ordinary case for a
    // database taking writes every minute. The two are indistinguishable
    // by number, and the second is not resolution: it is the state where
    // one identifier names two different records, which a reverse mirror
    // would then collapse. Bought convergence, sold the claim.
    //
    // So the advance is REPORTED, and the destination's own value is
    // reported with it as context rather than as an answer. What would
    // actually resolve it is a record that a person reviewed this
    // allocation — which is #2279, the same missing decision record that
    // leaves three row situations unable to come clean. Until it exists
    // this line repeats, and the runbook says so where it asserts the
    // two-clean-runs rule.
    //
    // This does not make ordinary runs noisy. The source of a
    // reconciliation is the database the writers LEFT, so its sequence
    // only moves if a straggler allocated on it after the mirror — the
    // exact event worth a standing line until somebody decides about it.
    const there = held.get(table);
    problems.push(
      `${table}: the source has allocated identifiers up to ${seq}, and ` +
        `the mirror recorded ${then}.\n      Something inserted ${seq - then} ` +
        `row(s) here after the mirror. If they are still present they are ` +
        `reported above; if they are NOT, they were inserted and deleted, ` +
        `and the identifiers are spent on the source while the destination ` +
        `still considers them free.\n      The destination has ` +
        `${there === undefined ? "never allocated here" : `reached ${there}`}` +
        `, which is CONTEXT and not resolution: it advances on its own ` +
        `writes, so reaching the same number says nothing about whether ` +
        `this allocation was ever applied (#2279).`,
    );
  }
  return problems;
}

/**
 * `live` reads a database that is still taking writes — paged by key,
 * with no demand that it hold still (#2267 r42). The weekly
 * reconciliation's destination is exactly that, and the verdict's digest
 * of it was asking for the same quiescence the row read was, so fixing
 * only the row read would have moved the impossible demand rather than
 * removed it.
 *
 * A digest of a moving database describes a moment, which is all the
 * reconciliation's verdict uses it for: whether the destination holds at
 * least as many rows as the source, and whether the SOURCE moved while
 * the run was working. Neither claims the destination stood still.
 */
async function digestDatabase(
  db,
  { live = false, only = null, skipped = null } = {},
) {
  const out = new Map();
  for (const table of await tablesOf(db.id)) {
    // `only` is the source's table list: digesting a table the verdict
    // will not look at costs a full read of a live database and can
    // only raise new ways to fail (#2267 r43). The reconciliation's
    // verdict ignores destination-only tables entirely — they cannot
    // hold a late write from the source — so it does not ask for them.
    if (only !== null && !only.has(table)) continue;
    const { cols, key } = await shapeOf(db.id, table);
    if (live && key.length === 0) {
      // NOT SILENTLY DEGRADED TO THE GATED READ. Turning `live` off here
      // would put the quiescence demand back on a database that is not
      // going to stop — the abort this whole change removed, reachable
      // through a keyless table. It is skipped and named instead; the
      // verdict treats an absent destination digest as nothing to say
      // when reconciling, which is exactly right for a table it cannot
      // read coherently.
      if (skipped !== null) skipped.push(table);
      continue;
    }
    const rows = await readAll(db.id, table, cols, query, {
      key: live ? key : null,
      live,
    });
    out.set(table, {
      ...digestOf(rows, cols),
      shape: shapeFingerprint(key, cols),
    });
  }
  return out;
}

function printDigest(label, map, runId = null) {
  console.log(`\n${label}`);
  let rows = 0;
  const shapes = [];
  for (const [table, { digest, count, shape }] of [...map].sort()) {
    rows += count;
    if (shape) shapes.push(`  shape ${table.padEnd(28)} ${shape}`);
    console.log(
      `  ${table.padEnd(32)} ${String(count).padStart(6)}  ${digest}`,
    );
  }
  console.log(
    `  ${"—".repeat(32)} ${String(rows).padStart(6)}  (${map.size} tables)` +
      (runId ? ` run:${runId}` : ""),
  );
  // AFTER the count line, so the line that closes the table-set reading
  // still does (#2281 r13). These say how each table keys and projects
  // its rows — the part of a manifest that content equality cannot
  // speak for.
  for (const line of shapes) console.log(line);
}

// ------------------------------------------------------------------- carry

const keyOf = (row, key) => JSON.stringify(key.map((c) => row[c] ?? null));

/**
 * A PRIMARY KEY CAN ITSELF BE A CREDENTIAL, and this tool prints keys.
 *
 * Conflict reports deliberately name the row and not its contents,
 * because these get pasted into run logs and issues. That reasoning
 * missed one case: `telegram_links` is keyed BY the six-digit handshake
 * code, which is live for ten minutes and is the only thing stopping
 * another Telegram caller from redirecting a wallet's alerts
 * (#2267 r26-missed). Withholding the row while printing the key
 * published the secret and kept the harmless part.
 *
 * So the key is fingerprinted for declared columns: a reader can still
 * tell two conflicts apart, correlate across runs, and ask for the row
 * deliberately — which is the same trade the contents rule makes.
 *
 * This is a DECLARED list because "is this value a secret" is semantic
 * and nothing in the schema says it. What keeps it honest is
 * `assertRedactionsApply`: if a declared table exists and the declared
 * column does not, the run stops rather than silently printing in
 * clear. A rename is exactly how a redaction stops applying.
 *
 * THE LIST WAS AUDITED, NOT GUESSED (2026-09-21). Every primary key on
 * all 43 carried tables was read from the live schema and judged. This
 * is the only one, and the near misses are worth recording so the
 * boundary is legible:
 *
 *   - `diag_legal_holds.wallet_hash` — already a hash, so there is
 *     nothing a fingerprint would add.
 *   - `notify_state.wallet`, `user_thresholds.wallet`,
 *     `reward_day_user.user` — wallet addresses are public identifiers
 *     on a public chain, not credentials. Naming one in a report tells a
 *     reader nothing the chain does not.
 *   - `support_tickets.ticket_id` — random (`VPK-` + 40 bits), which
 *     reads like a bearer token and is not one: nothing reads a ticket
 *     by id, the only query against that table is a retention DELETE.
 *     If a lookup-by-id surface is ever added, this becomes one.
 *   - `signed_offers.order_hash`,
 *     `prepay_listing_match_breadcrumbs.tx_hash` — public on-chain
 *     values.
 *
 * A new table whose key is a secret has to be added here. That is the
 * residue of a declared list and it is stated rather than implied.
 */
const CREDENTIAL_KEY_COLUMNS = new Map([
  [
    "telegram_links",
    {
      columns: ["code"],
      why:
        "the primary key IS the six-digit handshake code, live for ten " +
        "minutes, and whoever holds it can bind that wallet to their own " +
        "Telegram chat",
    },
  ],
]);

/**
 * A HASH OF A SIX-DIGIT CODE IS NOT A REDACTION, it is an encoding.
 *
 * The first version of this was an unsalted sha256, on the reasoning
 * that a hash is non-reversible and a stable one lets a reader correlate
 * the same row across runs. Both halves were wrong for this input: the
 * whole domain of a six-digit code is a million candidates, so anyone
 * holding the report enumerates it in about a second and has the live
 * credential (#2267 r33, demonstrated). And stability across runs is
 * exactly what makes an offline table reusable.
 *
 * So it is an HMAC under a key generated fresh for each run and never
 * printed. Within a run the same value fingerprints identically, which
 * is what a reader needs to match the lines of one report to each other.
 * Across runs it does not, and that is the point: a low-entropy secret
 * can only be protected by something the reader of the report does not
 * have.
 *
 * Cross-run correlation is therefore given up DELIBERATELY for these
 * columns. For `telegram_links` it was worth little anyway — the code is
 * live for ten minutes, so a conflict that survives to the next
 * reconciliation is a conflict about an expired credential.
 *
 * THE PLATFORM ALREADY HAD THIS RIGHT, which is the part worth carrying
 * forward: `apps/agent/src/diagHash.ts` pseudonymises wallets as
 * `HMAC(wallet, DIAG_WALLET_HMAC_KEY)`, under a Secrets Store secret,
 * for the same reason. This tool reinvented a weaker version of an
 * existing convention rather than looking for it.
 *
 * The one difference is deliberate. That key is long-lived because the
 * platform must match a pseudonym to the same wallet across requests;
 * this one is per-run because nothing here needs to, and a key that
 * never persists cannot leak from anywhere it is stored.
 */
const RUN_FINGERPRINT_KEY = randomBytes(32);

export function makeFingerprinter(key) {
  return (v) =>
    `fp:${createHmac("sha256", key).update(String(v)).digest("hex").slice(0, 12)}`;
}

const fingerprint = makeFingerprinter(RUN_FINGERPRINT_KEY);

/**
 * The key as it may be PRINTED. Values in declared credential columns
 * become fingerprints; everything else is unchanged.
 */
export function safeKey(table, keyCols, k) {
  const declared = CREDENTIAL_KEY_COLUMNS.get(table);
  if (!declared) return k;
  let values;
  try {
    values = JSON.parse(k);
  } catch {
    return `fp:unparseable-key`;
  }
  return JSON.stringify(
    values.map((v, i) =>
      declared.columns.includes(keyCols[i]) && v !== null ? fingerprint(v) : v,
    ),
  );
}

/**
 * A declared redaction that no longer matches the schema is a redaction
 * that has stopped happening. Checked against the table's real columns
 * rather than assumed.
 */
function assertRedactionsApply(table, cols) {
  const declared = CREDENTIAL_KEY_COLUMNS.get(table);
  if (!declared) return;
  const missing = declared.columns.filter((c) => !cols.includes(c));
  if (missing.length === 0) return;
  fail(
    `"${table}" is declared as having credential-bearing key column(s) ` +
      `${missing.map((c) => `"${c}"`).join(", ")}, and the table does not ` +
      `have ${missing.length > 1 ? "them" : "it"} any more.\n\n` +
      `${declared.why}.\n\nA renamed or dropped column means the ` +
      `redaction silently stopped applying, and this tool prints keys. ` +
      `Update CREDENTIAL_KEY_COLUMNS in this file to match the schema.`,
  );
}

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
/**
 * Exported for `test/d1Reconcile.test.ts`: the atomicity is the point of
 * the function, and a promise the runbook makes to an operator during a
 * cutover is not one to leave unexercised.
 */
export function writeManifest(path, src, tables, provenance = null, opts = {}) {
  const doc = {
    source: { name: src.name, id: src.id },
    takenAt: new Date().toISOString(),
    // PROVENANCE IS PART OF THE ARTIFACT, not of a run log that can be
    // separated from it (#2281 r1). A manifest the MIRROR wrote observes
    // the moment it describes. A manifest taken afterwards observes a
    // LATER moment and only stands in for the earlier one — and which of
    // the two a reader has in front of them changes what its contents
    // mean. Leaving that distinction to a file kept somewhere else is a
    // recovery artifact making a claim about itself that may be false.
    provenance: provenance ?? {
      producer: "carry --mirror",
      observes: "the moment this manifest was taken",
      standsFor: null,
    },
    tables,
  };
  // 0600, because of what is in it. The manifest keys every row by its
  // PRIMARY KEY VALUES — wallet addresses, support-ticket ids, Telegram
  // handshake codes — so it is a complete key inventory of the platform's
  // off-chain data, written by a command the runbook tells an operator to
  // run from the repository root. The documented paths are gitignored for
  // the same reason; a routine `git add .` would otherwise commit it.
  // `mode` applies only when the file is CREATED. A re-run against an
  // existing 0644 manifest would truncate it, leave it 0644, and print
  // "mode 0600" underneath — so the mode is set explicitly afterwards
  // rather than requested at open. A cutover re-runs its steps; a
  // protection that only holds the first time is not one.
  //
  // WRITTEN BESIDE AND RENAMED OVER, never truncated in place (#2267
  // r47). `writeFileSync` opens for truncation first, so an interrupted
  // or failed write — a full disk, a cancelled run — leaves the previous
  // manifest destroyed and the new one incomplete. This file is the ONLY
  // baseline a later reconciliation and the documented rollback have,
  // and the runbook promises in as many words that a failed mirror
  // leaves the last good one intact. A rename within the same directory
  // is atomic, so the path holds either the old manifest or the new one
  // and never half of either.
  //
  // The temporary file carries the same 0600 for the same reason the
  // final one does — it holds the identical key inventory for as long as
  // it exists — and is removed if the rename cannot happen.
  //
  // AND THE REFUSAL TO REPLACE HAS TO BE PART OF THE PUBLICATION, not a
  // test taken before it (#2281 r8). The manifest verb checks that its
  // `--out` is free and then reads a remote database table by table,
  // which takes minutes; a rename at the end of that replaces whatever
  // is at the path by then. If the original manifest was restored from a
  // backup in the meantime — precisely the thing the operator would be
  // doing while a reconstruction runs — the reconstruction destroys the
  // one artifact that observed the moment it describes, and the refusal
  // printed in the help text was true only of the instant it was made.
  //
  // `link` fails with EEXIST rather than replacing, and it is the same
  // atomic same-directory operation the rename was chosen for. Falling
  // back to a replace when a filesystem cannot link would defeat the
  // point, so a link that fails for any other reason is surfaced.
  const noReplace = opts.noReplace === true;
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    if (noReplace) {
      linkSync(tmp, path);
      unlinkSync(tmp);
    } else {
      renameSync(tmp, path);
    }
  } catch (err) {
    if (noReplace && err?.code === "EEXIST") {
      try {
        unlinkSync(tmp);
      } catch {
        // The manifest at `path` is what matters, and it is untouched.
      }
      fail(
        `${path} was created while this manifest was being read, and ` +
          `this verb will not replace it.\n\nThe read takes minutes. A ` +
          `file that appeared during it is newer than the check that ` +
          `found the path free — and if it is the original manifest, ` +
          `restored, then replacing it with a reconstruction destroys ` +
          `the only baseline that was ever a direct observation.\n\n` +
          `The reconstruction was NOT written. Re-run it against a new ` +
          `path if you still need one.`,
      );
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or nothing we can do about it — the point
      // of this handler is the manifest at `path`, which is untouched.
    }
    throw err;
  }
  chmodSync(path, 0o600);
  console.log(
    `manifest written to ${path} (mode 0600) — it is what --since reads, ` +
      `and it keys every row by its primary key, so treat it as data: do ` +
      `not commit it.\n\nKEEP IT UNTIL THE ROLLBACK WINDOW CLOSES, not ` +
      `until the cutover finishes. The rollback reconciles against this ` +
      `same manifest BEFORE its reverse mirror, and reconcile refuses to ` +
      `run without --since — so deleting it at the end of the cutover ` +
      `removes the only baseline the documented rollback needs while the ` +
      `predecessor is still being retained for exactly that purpose. The ` +
      `window closes when the predecessor is deleted; the manifest goes ` +
      `then, with it.`,
  );
}

function readManifest(path, src) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
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
  // SAY WHICH KIND OF BASELINE THIS IS. Calling a reconstruction "the
  // mirror of <date>" is the artifact's false provenance claim repeated
  // by the tool that reads it (#2281 r1).
  const prov = doc.provenance ?? { producer: "carry --mirror" };
  if (prov.producer === "carry --mirror") {
    console.log(`  reconciling against the mirror of ${doc.takenAt}`);
  } else {
    const read =
      prov.readStartedAt && prov.readCompletedAt
        ? `between ${prov.readStartedAt} and ${prov.readCompletedAt}`
        : `at ${doc.takenAt}`;
    console.log(
      `  reconciling against a RECONSTRUCTED baseline, read from ` +
        `${doc.source?.name} ${read} — NOT the record the mirror wrote.\n` +
        `  It stands for: ${prov.standsFor}\n` +
        `  Interval since the mirror: ${prov.interval ?? "NOT STATED"}\n` +
        `  A write that committed before that reading is part of this ` +
        `baseline and cannot be reported as late by any run using it.` +
        (prov.interval === "covered"
          ? // WHAT THE PROMOTION STANDS ON, HERE TOO (#2281 r14). This is
            // the surface an operator consults before the rollback, and
            // "covered" alone conceals a coverage that never established
            // row identity — leaving the distinction in a JSON field
            // somebody has to know to open. A dimension not compared is
            // disclosed wherever the verdict is reported, not only where
            // it was decided.
            `\n  Covered on: ${(prov.coveredDimensions ?? ["rows", "sequences"]).join(", ")}` +
            ((prov.coveredDimensions ?? []).includes("run-pairing")
              ? ""
              : `\n  NOT ESTABLISHED: that the table set and the ` +
                `allocation marks in the evidence came from the SAME ` +
                `"digest" run. Halves from two runs describe two ` +
                `moments, and an identifier allocated and released ` +
                `between them is absorbed into this baseline.`) +
            ((prov.coveredDimensions ?? []).includes("shape")
              ? ""
              : `\n  NOT ESTABLISHED: how each table keys and projects ` +
                `its rows at the mirror. The evidence carried no "shape" ` +
                `lines, so a table recreated with a different primary ` +
                `key over the same column-order values reads identical ` +
                `to this baseline — and this run classifies rows by ` +
                `exactly those fields.`)
          : `\n  BECAUSE THAT INTERVAL IS ${(prov.interval ?? "not stated").toUpperCase()}, ` +
            `a clean result here does NOT license the rollback's reverse ` +
            `mirror. A late write absorbed into this baseline reads as ` +
            `\`destination-moved\`, reports no conflict, and the reverse ` +
            `mirror would then destroy the only copy of it.`),
    );
  }
  return doc.tables ?? {};
}

/** Chunk so a statement never exceeds the bound-parameter cap. */
function chunk(items, perBatch) {
  const out = [];
  for (let i = 0; i < items.length; i += perBatch)
    out.push(items.slice(i, i + perBatch));
  return out;
}

async function upsert(dst, table, rows, cols, key, onlyMissing) {
  if (rows.length === 0) return 0;
  const quoted = cols.map((c) => `"${c}"`).join(", ");
  const conflict = key.map((c) => `"${c}"`).join(", ");
  const nonKey = cols.filter((c) => !key.includes(c));
  // `DO NOTHING` is what --only-missing means at the statement level: an
  // existing row is left exactly as the destination has it. A key-only
  // table has nothing to update either way.
  const action =
    onlyMissing || nonKey.length === 0
      ? "NOTHING"
      : `UPDATE SET ${nonKey.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`;

  for (const batch of chunk(
    rows,
    Math.max(1, Math.floor(MAX_PARAMS / cols.length)),
  )) {
    await query(
      dst.id,
      `INSERT INTO "${table}" (${quoted}) VALUES ` +
        batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ") +
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
      .map(() => `(${key.map((c) => `"${c}" = ?`).join(" AND ")})`)
      .join(" OR ");
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
/**
 * THE THREE FACTS, AS ONE NAME. Did the mirror carry this key, does the
 * source still hold this row, does the destination hold the same row —
 * and what situation is that.
 *
 * This exists because the questions were being asked inline, in an
 * if/else chain, and two separate simplifications each dropped one of
 * them: once so a conflict an operator had resolved reported forever,
 * once so every row the live destination advanced reported forever. Both
 * were invisible at the point of the edit and both broke the same
 * property — that repeating the reconciliation can eventually come clean.
 *
 * Asking all three in one place, and naming the answer, is what makes a
 * dropped question impossible to write: there is one expression to read,
 * and its caller handles every name it can return or throws.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function situationOf({
  mirroredHash,
  sourceHash,
  sourceRow = null,
  destRow,
  cols,
  destCols = null,
}) {
  const mirrored = mirroredHash !== undefined;
  if (destRow === undefined) {
    if (!mirrored) return "new-on-source";
    // THE SOURCE'S OWN STATE STILL MATTERS WHEN THE DESTINATION HAS
    // DELETED THE ROW, and asking only about the destination hid half of
    // it (#2267 r27). If the source ALSO changed the row after the
    // mirror, a report naming only the deletion — and warning that
    // restoring it may undo a retention or privacy obligation — reads as
    // "leave this alone", and the late source value is discarded on the
    // way to a clean pass.
    return mirroredHash === sourceHash
      ? "destination-deleted"
      : "destination-deleted-source-changed";
  }
  // THE DESTINATION'S ROW IS PROJECTED AS ITS OWN TABLE ACTUALLY IS
  // (#2267 r39). `destCols` is the destination's column set when the two
  // sides may declare the table differently — which after the first
  // post-cutover migration they may. A column it has dropped serialises
  // as absent, never as NULL, so "the destination no longer carries this
  // field" cannot be mistaken for "a straggler set this field to NULL"
  // and reported as the two sides agreeing.
  //
  // THE SENTINEL BELONGS TO THE MANIFEST-BACKED QUESTION ONLY, and using
  // it for both cost a self-review round to notice. Where the mirror
  // carried this key, the manifest can say whether the SOURCE moved, so
  // treating a dropped column as a difference is free: the answer falls
  // through to `destination-moved` when the source has not moved and to
  // `source-changed` when it has, both correct.
  //
  // Where the mirror did NOT carry it there is no manifest hash to fall
  // through to, so the same sentinel would make a row an operator had
  // applied by hand look like two records wearing one id — permanently,
  // since nothing can ever make a dropped column match. For those rows
  // the comparison is over the columns BOTH sides have, which is the
  // best evidence that exists. Two different records alike on every
  // shared column and differing only on one the destination has dropped
  // would read as agreement; that distinction is unrecoverable at the
  // destination anyway.
  if (mirrored) {
    if (rowHash(destRow, cols, destCols) === sourceHash) return "agreed";
  } else {
    const shared =
      destCols === null ? cols : cols.filter((c) => destCols.has(c));
    if (
      sourceRow !== null &&
      canonical(destRow, shared) === canonical(sourceRow, shared)
    ) {
      return "agreed";
    }
    if (sourceRow === null && rowHash(destRow, cols) === sourceHash)
      return "agreed";
    return "key-collision";
  }
  return mirroredHash === sourceHash ? "destination-moved" : "source-changed";
}

/**
 * Which of a destination's unique indexes this run can actually evaluate,
 * and which it can only warn about.
 *
 * The tuple being looked up is built from a SOURCE row, so an index naming
 * a column the source does not have cannot be evaluated at all. Dropping
 * such an index silently would leave the run reporting a row as plainly
 * missing while the destination's own constraint already holds it — so the
 * caller names them instead, and the operator knows the comparison is
 * narrower than the destination's real constraints.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function splitUniquesByEvaluability(uniques, sourceCols) {
  const has = new Set(sourceCols);
  const usable = [];
  const unevaluable = [];
  for (const u of uniques)
    (u.columns.every((c) => has.has(c)) ? usable : unevaluable).push(u);
  return { usable, unevaluable };
}

/**
 * Does this run report and stop, or report and carry on verifying?
 *
 * A CARRY stops: it wrote nothing, so there is nothing to verify, and the
 * digests it would otherwise run take minutes out of a cutover window to
 * describe a decision made before they started.
 *
 * A RECONCILE never stops here, and that is the whole point of the
 * predicate existing (#2267 r39). Its two late-write checks — the sequence
 * comparison and the re-read that notices the source moved — sit AFTER
 * this point, and #2279 means a reconciliation can carry a conflict
 * permanently. Stopping on a conflict would therefore switch both checks
 * off for good, on the one procedure still looking for late writes.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function stopsBeforeVerification({
  reconciling,
  refused = [],
  conflicts = [],
}) {
  return !reconciling && (refused.length > 0 || conflicts.length > 0);
}

/**
 * What can still be said about a table the DESTINATION no longer has.
 *
 * A migration that drops a table leaves the retained source holding it
 * and the reconciliation with nothing to compare against — but not with
 * nothing to ask. The manifest recorded what the mirror carried, so the
 * source can still be compared with its own past, and that is exactly
 * the question the weekly run exists for: did anything write here after
 * the mirror.
 *
 * It reports ONE finding for the table rather than one per row. Every
 * row would otherwise come back as the destination having deleted it,
 * whose message warns about undoing a retention prune — true of a row a
 * cron removed, misleading about a table a migration dropped. And the
 * counts are what an operator actually needs: whether anything arrived
 * here after the switch, and how much.
 *
 * Rows and keys are deliberately absent from the finding. There is
 * nowhere to apply them, and cutover output is pasted into run logs.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function classifyAgainstManifestOnly({
  table,
  cols,
  key,
  rows,
  wasSeen,
  // Why the destination is out of the comparison, in the operator's
  // terms. Two situations reach here and they are NOT the same fact: a
  // table a migration dropped, and one whose key it dropped — the second
  // still holds the data, which changes what the operator does next.
  why = "the destination has since DROPPED this table, so nothing here can be applied where the data now lives",
}) {
  if (wasSeen === null || wasSeen === undefined) {
    return {
      insert: [],
      conflicts: [
        {
          table,
          kind: "no record",
          detail:
            "the destination no longer has this table and the manifest " +
            "has no record of it either, so nothing can be said about " +
            "what the source holds here",
        },
      ],
    };
  }
  let added = 0;
  let changed = 0;
  const present = new Set();
  for (const r of rows) {
    const k = keyOf(r, key);
    present.add(k);
    const seen = wasSeen[k];
    if (seen === undefined) added += 1;
    else if (seen !== rowHash(r, cols)) changed += 1;
  }

  // A DELETION IS A LATE WRITE TOO, and iterating the source's CURRENT
  // rows can never see one (#2267 r45). The row is in no row — only the
  // manifest remembers it — which is the same blind spot the main
  // decision table needed a separate manifest pass for.
  //
  // It matters most in the case that reaches here: a destination whose
  // key was dropped still HOLDS the row, so a deletion the source made
  // for a retention or privacy reason has not happened there, and the
  // one report that would have said so said nothing.
  let deleted = 0;
  for (const k of Object.keys(wasSeen)) if (!present.has(k)) deleted += 1;

  if (added === 0 && changed === 0 && deleted === 0)
    return { insert: [], conflicts: [] };
  return {
    insert: [],
    conflicts: [
      {
        table,
        kind: "written to after the mirror, in a table this run cannot compare",
        detail:
          `${added} row(s) added, ${changed} changed and ${deleted} ` +
          `DELETED on the source since the mirror, and ${why}. Decide ` +
          `whether those writes matter — the source's copy of them ` +
          `exists only while it is retained, and a deletion it made may ` +
          `still be undone on the destination`,
      },
    ],
  };
}

export function classifyForReconcile({
  table,
  cols,
  key,
  rows,
  sourceKeys,
  heldByKey,
  wasSeen,
  uniques = [],
  destCols = null,
}) {
  const conflicts = [];
  const insert = [];
  if (wasSeen === null || wasSeen === undefined) {
    conflicts.push({
      table,
      kind: "no record",
      detail:
        "the manifest has no record of this table, so none of the cases " +
        "below can be told apart from the destination simply moving on",
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
    const situation = situationOf({
      mirroredHash: wasSeen[k],
      sourceHash: rowHash(r, cols),
      sourceRow: r,
      destRow: heldByKey.get(k),
      cols,
      destCols,
    });

    // Every situation is NAMED and every name is HANDLED — see
    // `situationOf`. An if/else chain over three booleans is what this
    // replaces, and it had lost a condition twice while being simplified:
    // once making a resolved conflict report forever, once making every
    // live destination row report forever. Both were the same shape — a
    // branch that stopped asking one of the three questions — and neither
    // was visible at the point of the edit.
    switch (situation) {
      case "agreed":
        // The two sides hold the same row. Whatever the manifest says,
        // there is nothing to reconcile: this covers a row a previous
        // pass carried and a conflict an operator has already resolved.
        break;

      case "destination-moved":
        // The source is exactly as the mirror saw it, so only the
        // destination changed — which after the switch is the live
        // database doing its job, `indexer_cursor` advancing every
        // minute. Not a conflict.
        break;

      case "new-on-source": {
        // Absent by primary key is not the same as insertable: a
        // secondary unique index can already hold this row's tuple under
        // another key, and `ON CONFLICT (pk)` would not catch it.
        const clash = destUnique
          .map((u) => ({ u, t: tupleOf(r, u.columns) }))
          .find(({ u, t }) => t !== null && u.byValue.has(t));
        if (clash) {
          conflicts.push({
            table,
            key: safeKey(table, key, k),
            kind: "already present under a different key",
            // THE OTHER KEY IS A KEY TOO (#2267 r41). It was interpolated
            // raw while this finding's own key went through `safeKey`,
            // which is the same defect the redaction exists to prevent,
            // one field along: `telegram_links` is keyed by the live
            // handshake code, so a collision there printed a working
            // credential into output that gets pasted into run logs.
            detail:
              `the destination holds a row with the same ${clash.u.columns.join(
                "+",
              )} under key ${safeKey(table, key, clash.u.byValue.get(clash.t))} — ` +
              `the same logical row reached both sides and was numbered ` +
              `differently`,
          });
          break;
        }
        insert.push(r);
        break;
      }

      case "key-collision":
        conflicts.push({
          table,
          key: safeKey(table, key, k),
          kind: "key allocated on both sides",
          detail:
            "this key is new on the source since the mirror and the " +
            "destination holds a DIFFERENT row under it — two records " +
            "with one id, which an insert would silently drop",
        });
        break;

      case "source-changed":
        conflicts.push({
          table,
          key: safeKey(table, key, k),
          kind: "changed on the source after the mirror",
          detail:
            "the destination holds a different row under that key. " +
            "Resolve it by making the two sides agree; a later pass then " +
            "passes over it silently",
        });
        break;

      case "destination-deleted":
        conflicts.push({
          table,
          key: safeKey(table, key, k),
          kind: "deleted on the destination",
          detail:
            "the mirror carried this row and the destination no longer " +
            "has it, so it was deleted there — re-inserting it would undo " +
            "that, and such a deletion may be a retention or privacy " +
            "obligation",
        });
        break;

      case "destination-deleted-source-changed":
        conflicts.push({
          table,
          key: safeKey(table, key, k),
          kind: "deleted on the destination, and CHANGED on the source",
          detail:
            "the destination deleted this row — which may be a retention " +
            "or privacy obligation — AND the source has changed it since " +
            "the mirror, so there is a late source value here that no " +
            "reading of the destination will show. Both facts belong in " +
            "the decision: restoring the row undoes a deliberate deletion, " +
            "and leaving it discards the newer value",
        });
        break;

      default:
        // Unreachable by construction, and loud rather than silent if a
        // later edit invents a situation and forgets to handle it. A
        // fall-through here would mean a row quietly neither carried nor
        // reported, which is the one outcome this tool must never have.
        throw new Error(
          `unhandled situation "${situation}" for ${table} ${k} — every ` +
            `situation situationOf() can return must be handled here`,
        );
    }
  }

  // Keys the mirror carried that the SOURCE no longer has. These appear in
  // no row of the source, which is exactly why a loop over the source left
  // the destination holding them while the run reported VERIFIED.
  for (const k of Object.keys(wasSeen)) {
    if (sourceKeys.has(k)) continue;
    // If the destination has dropped it too, the two agree and there is
    // nothing to decide.
    const held = heldByKey.get(k);
    if (held === undefined) continue;

    // "STALE" IS A CLAIM ABOUT THE DESTINATION'S ROW, so it has to be
    // checked against that row and not merely against its key (#2267
    // r26). The destination is live, and several of these keys are
    // NATURAL and reusable — `user_thresholds` is keyed by the setting
    // itself, not by an allocated id — so between the mirror and now the
    // source may have deleted the row while the destination UPDATED it or
    // created it afresh. Reporting that as "stale there" invites an
    // operator to delete a newer setting a user has just changed.
    //
    // The manifest is what tells the two apart: if the destination still
    // holds the row the mirror carried, the source deleted it and the
    // destination merely has not; if it holds something else, both sides
    // moved and neither value is obviously right.
    const unchangedSinceMirror = rowHash(held, cols) === wasSeen[k];
    conflicts.push({
      table,
      key: safeKey(table, key, k),
      kind: unchangedSinceMirror
        ? "deleted on the source after the mirror"
        : "deleted on the source, and CHANGED on the destination",
      detail: unchangedSinceMirror
        ? "the destination still holds the row the mirror carried, so it " +
          "is stale there — but whether to delete it is a decision this " +
          "tool will not make on a live database"
        : "the source deleted it and the destination now holds a " +
          "DIFFERENT row under the same key, so the destination has its " +
          "own newer value. Deleting it would discard that; this is a " +
          "decision, not a stale row",
    });
  }
  return { insert, conflicts };
}

/**
 * A fingerprint of a table's ROW IDENTITY and PROJECTION.
 *
 * Coverage compared contents and allocations and nothing else, so it
 * never established that a reconstruction keys and projects its rows the
 * way the mirror-time baseline did (#2281 r13). A migration after the
 * mirror can rename a column, or recreate a table with a different
 * primary key over the same column-order values: `digestOf` reads the
 * same bytes in the same order and returns the same digest, the
 * sequence need not move, and the artifact is promoted with different
 * `key` and `cols` than the mirror would have written. Reconciliation
 * then classifies rows by those fields and licenses a reverse mirror on
 * the strength of it.
 *
 * Content equality is not manifest equality, and this is the part of a
 * manifest that content cannot speak for.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function shapeFingerprint(key, cols) {
  return createHash("sha256")
    .update(JSON.stringify({ key: key ?? [], cols: cols ?? [] }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The container a manifest's tables go in — prototype-free, always.
 *
 * A TABLE MAY BE CALLED `__proto__` (#2281 r10). It is a legal SQLite
 * identifier and it matches every table-name pattern in this file.
 * Assigned onto a plain object it invokes the legacy prototype setter
 * instead of creating an own property, so the table is read and
 * digested and then vanishes: `Object.keys`, `Object.entries` and
 * `JSON.stringify` all skip it, and the baseline is written without it
 * and without a refusal naming it — a silently incomplete record of
 * what a database held, which is the one thing this artifact must not
 * be.
 *
 * It is a named function rather than two `Object.create(null)` calls so
 * the rule has one home, and a third place that builds a manifest
 * cannot quietly reintroduce a plain object.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function newManifestTables() {
  return Object.create(null);
}

/**
 * ONE PER-TABLE MANIFEST ENTRY, built in one place because there are now
 * two producers of it — the mirror, and `manifest` — and a baseline whose
 * shape depends on which verb wrote it is a baseline the reconciliation
 * cannot read (#2281).
 *
 * `seq` is the allocation high-water mark, so a later reconciliation can
 * see the source allocate past it (#2267 r36). ZERO AND NULL MEAN
 * DIFFERENT THINGS (#2267 r37): a table that has never allocated has a
 * KNOWN baseline of zero, while `null` means the baseline is unknown and
 * the comparison skips it. A straggler inserting and then deleting the
 * FIRST row of `diag_legal_hold_audit` is exactly the case that
 * distinction catches.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function manifestEntry({ key, cols, seq, rows, digest = undefined }) {
  // `digest` is the content digest of the reading this entry was built
  // from. The mirror does not record one (its own verification covers
  // it); a reconstruction does, because promoting it to "covered" means
  // comparing it with what was recorded at the mirror, and that
  // comparison has to be possible from the artifact alone (#2281 r3).
  return digest === undefined
    ? { key, cols, seq, rows }
    : { key, cols, seq, rows, digest };
}

/**
 * Take a manifest from ONE database, writing to none.
 *
 * WHY THIS EXISTS (#2281). A manifest is a record of what a database held
 * at a moment, and nothing about that requires a write. Until now the
 * only thing that produced one was `carry --mirror` — so the baseline
 * that `reconcile` refuses to run without, and that the documented
 * rollback consumes before its reverse mirror, could only be obtained by
 * writing to a destination. After the cutover that destination is LIVE,
 * which makes re-taking a lost baseline strictly worse than the problem:
 * a mirror would roll the live database's newer rows back to the retained
 * source's stale ones.
 *
 * That left the baseline an irreplaceable artifact in the middle of a
 * recovery procedure, which is the kind of thing that should not be
 * irreplaceable. This makes it reproducible.
 *
 * WHAT IT DOES NOT KNOW, and says so rather than implying otherwise: it
 * records the source AS IT IS NOW. That is a valid substitute for the
 * mirror's baseline only if the source has not changed since the mirror —
 * true of a retained predecessor that no Worker binds any more, and NOT
 * something this tool can establish on its own. Establishing it is what
 * the digest comparison is for, and the caller is told to do it.
 *
 * The read is the same two-pass gate the mirror uses, so a source that is
 * still moving fails here rather than producing a baseline that describes
 * no moment at all.
 */
/**
 * Parse the evidence file `cover` checks a reconstruction against.
 *
 * It is whatever the operator recorded AT the mirror, pasted in: lines of
 * `<table> <digest>` and lines of `seq <table> <n>`. Anything else — row
 * counts, prose, the run log's own headings — is ignored, because the
 * file people actually have is a copy-paste of a terminal, not a format
 * anyone designed.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function parseEvidence(text) {
  const digests = new Map();
  // Every shape line anywhere, so a disagreement between runs is still
  // a conflict. What `cover` COMPARES against comes from paired
  // readings only — see `shapes` below.
  const shapeLines = new Map();
  let openRun = null;
  // A RUN LOG HOLDS SEVERAL READINGS, AND THEY MAY DISAGREE (#2281 r4).
  // The documented barrier takes two digests ten minutes apart and a
  // third after the carry, so pasting the log in means repeated table
  // names. Taking the LAST silently prefers the reading that agrees with
  // the reconstruction — which is precisely backwards when a straggler
  // changed a row during the mirror: the earlier reading differs, the
  // later one matches, and coverage would be granted over the top of the
  // recorded disagreement. Identical repeats are fine and expected; a
  // disagreement is evidence in itself and is kept as one.
  const conflicts = [];
  const put = (map, kind, table, value) => {
    const had = map.get(table);
    if (had !== undefined && had !== value) {
      conflicts.push(
        `${table}: the evidence gives two different ${kind} readings — ` +
          `${had} and ${value}. Something changed between them, so ` +
          `neither can stand for the mirror on its own`,
      );
      return;
    }
    map.set(table, value);
  };

  // THREE THINGS ARE BEING READ OUT OF ONE PASTED LOG, AND THEY HAVE
  // THEIR OWN BOUNDARIES (#2281 r9 — the root of rounds 5 through 9).
  //
  // Every round since r5 has found another way for this parser to reach
  // a clean verdict over a log that records a change, and every one was
  // the same underlying mistake: ONE block structure, delimited by the
  // sequence marker, doing duty for three separate questions. A digest
  // block whose count line is present but whose `seq-listing complete`
  // is missing merged into the next run and overwrote its count. A
  // digest block with no count line, closed by a sequence marker, was
  // neither an enumeration nor "trailing", so the tables it named
  // stopped counting as named at all. Patching either in place would
  // have left the other, and the next one after that.
  //
  // So the text is read as three things that do not share a delimiter:
  //
  //   ENUMERATIONS — digest lines closed by `printDigest`'s own
  //     rule-and-count line. Nothing else closes one. An enumeration is
  //     a reading of the WHOLE table set, so what it does not name was
  //     not there; that is the only thing in this file that can say so.
  //     A count that disagrees with the lines present means a part
  //     paste, and it is reported and not used.
  //
  //   SEQUENCE READINGS — `seq` lines closed by `seq-listing complete`.
  //     Within one, a table the evidence names anywhere and this
  //     reading does not is a known zero.
  //
  //   APPEARANCES — every table named by any line anywhere, closed
  //     block or not, digest line or sequence line. Each one names a
  //     table that was there when the line was written.
  //
  // The asymmetry from r7 is now the whole rule, and it needs no cases:
  // a table that APPEARS anywhere and is MISSING from any enumeration is
  // a table set that changed between two moments in the log. It does not
  // matter which came first — either direction is a change — so there is
  // no ordering to get wrong, and no "trailing" special case to forget.
  const enumerations = [];
  const seqReadings = [];
  const unterminatedSeqs = [];
  let openDigests = new Map();
  let openSeqs = new Map();
  let sawAnyComplete = false;
  const mentioned = new Set();

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Closes a SEQUENCE reading, and only that.
    if (line.startsWith("seq-listing complete")) {
      const id = /\brun:([0-9a-f]{6,64})\b/.exec(line);
      seqReadings.push({ seqs: openSeqs, run: id ? id[1] : null });
      openSeqs = new Map();
      openRun = null;
      sawAnyComplete = true;
      continue;
    }
    // Closes a DIGEST reading. `printDigest` prints this line at the end
    // of every run, including when the count is zero — which is why an
    // empty enumeration is still an enumeration.
    //
    // AND IT MARKS THE START OF A RUN'S SEQUENCE SECTION (#2281 r10).
    // One `digest` run prints its digests, then this line, then its
    // `seq` lines, then `seq-listing complete`. So a count line can only
    // appear once a NEW run's output has begun — and any sequence block
    // still open at that point belongs to a previous run whose closing
    // marker is not in the file.
    //
    // Left merged, the two runs' sequence lines become one map that the
    // NEXT marker closes as a single complete reading. A table at 5 in
    // the first run and omitted from the second — a known zero, which is
    // a RESET — then reads as one reading of 5, and a reconstruction
    // sitting at 5 passes over a log that proves the sequence moved.
    const tot =
      /^[—–\-]{3,}\s+\d+\s+\((\d+)\s+tables?\)(?:\s+run:([0-9a-f]{6,64}))?$/.exec(
        line,
      );
    if (tot) {
      const entry = {
        digests: openDigests,
        declared: Number(tot[1]),
        run: tot[2] ?? null,
        shapes: new Map(),
      };
      enumerations.push(entry);
      openRun = entry;
      openDigests = new Map();
      if (openSeqs.size > 0) {
        // Never closed, so it contributes its values and no zeros.
        unterminatedSeqs.push(openSeqs);
        openSeqs = new Map();
      }
      continue;
    }
    // `shape <table> <16-hex>` — how that table keyed and projected its
    // rows at the moment of the reading (#2281 r13). It is a value like
    // the digest, not a boundary: it closes nothing.
    const shp = /^shape\s+([A-Za-z_][A-Za-z0-9_]*)\s+([0-9a-f]{16})$/.exec(
      line,
    );
    if (shp) {
      mentioned.add(shp[1]);
      // A SHAPE BELONGS TO THE RUN THAT PRINTED IT (#2281 r16). Stored
      // in one global map, a shape line from a later cropped run stood
      // in for the mirror-time run that never carried one — and `cover`
      // then recorded `shape` as a covered dimension on the strength of
      // a reading taken after the migration it was supposed to detect.
      // A dimension counts as established only from the paired reading,
      // so the line is bound to the enumeration whose count line
      // preceded it.
      //
      // `put` still runs, so two runs disagreeing about a table's shape
      // is a conflict wherever they sit — that is evidence either way.
      put(shapeLines, "shape", shp[1], shp[2]);
      if (openRun !== null) openRun.shapes.set(shp[1], shp[2]);
      continue;
    }
    const seq = /^seq\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)$/.exec(line);
    if (seq) {
      mentioned.add(seq[1]);
      // EXACTLY, or not at all (#2281 r11) — the same rule the manifest
      // reader holds to. A mark this file cannot tell apart from its
      // neighbour must not be compared as though it could.
      const value = exactSequence(seq[2]);
      if (value === null) {
        conflicts.push(
          `${seq[1]}: the evidence records a sequence of ${seq[2]}, which ` +
            `is outside the range this tool can compare exactly. Two ` +
            `different marks in that range read as the same number here, ` +
            `so it cannot stand for the mirror`,
        );
        continue;
      }
      const had = openSeqs.get(seq[1]);
      if (had !== undefined && had !== value) {
        conflicts.push(
          `${seq[1]}: one sequence listing gives it twice, as ${had} and ` +
            `${seq[2]}`,
        );
      }
      openSeqs.set(seq[1], value);
      continue;
    }
    // `<table> [rowcount] <16-hex>` — the digest command prints a count
    // between them, and a hand-kept note may not.
    const dig = /^([A-Za-z_][A-Za-z0-9_]*)\s+(?:\d+\s+)?([0-9a-f]{16})$/.exec(
      line,
    );
    if (dig) {
      mentioned.add(dig[1]);
      openDigests.set(dig[1], dig[2]);
      put(digests, "digest", dig[1], dig[2]);
    }
  }
  // Whatever is still open was never closed, so it names tables — which
  // `mentioned` already holds — and says nothing by omission.
  if (openSeqs.size > 0) unterminatedSeqs.push(openSeqs);

  // A declared count that does not match the lines present means the
  // block was pasted in part. It is then not a reading of the table set
  // either, and it says so rather than being quietly downgraded.
  const readings = enumerations.filter((e, i) => {
    if (e.declared === e.digests.size) return true;
    conflicts.push(
      `complete reading ${i + 1} declares ${e.declared} table(s) but ` +
        `carries ${e.digests.size} digest line(s). Part of it is ` +
        `missing, so what it does not name cannot be read as a table ` +
        `that was not there`,
    );
    return false;
  });

  // THE TABLE SET, in one rule: named anywhere, missing from a reading
  // of the whole set.
  for (const table of mentioned) {
    const missing = readings.filter((e) => !e.digests.has(table)).length;
    if (missing === 0) continue;
    conflicts.push(
      `${table}: the evidence has ${readings.length} complete reading(s) ` +
        `of the table set and this table is missing from ${missing} of ` +
        `them, while being named elsewhere in the same evidence. A table ` +
        `that comes or goes between readings is a database that changed, ` +
        `whatever the digests say`,
    );
  }

  // PAIRING IS STATED, NOT INFERRED (#2281 r15). Rounds 12 through 15
  // each found another crop that joined one run's tables to another
  // run's allocations, and each fix read the boundary off a line that
  // happened to be present — a digest line, a repeated shape line.
  // There was always another crop, because the boundary was never IN
  // the evidence. It is now: both lines that close a run carry the same
  // `run:<id>`, and halves pair when they agree on it.
  //
  // Evidence recorded before the identifier existed carries none. That
  // pairing cannot be established at all — a single enumeration and a
  // single sequence listing look identical whether they came from one
  // run or two — so it is reported as unestablished rather than
  // guessed. The caller decides what to do about it; this function does
  // not pretend to know.
  const runsWithIds = new Set(
    [...readings, ...seqReadings].map((r) => r.run).filter(Boolean),
  );
  const paired = [...runsWithIds].filter(
    (id) =>
      readings.some((e) => e.run === id) &&
      seqReadings.some((r) => r.run === id),
  );
  const unidentified =
    readings.filter((e) => !e.run).length +
    seqReadings.filter((r) => !r.run).length;

  const seqs = new Map();
  for (const table of mentioned) {
    // ONE RULE OVER EVERY BLOCK (#2281 r10). A CLOSED reading always
    // observes a value — no line inside one means zero. An UNTERMINATED
    // block observes a value only where it has a line, because its
    // silences may be a truncated paste rather than a zero. There can be
    // several unterminated blocks now that a digest summary parks one,
    // so this is a fold over observations rather than a closed pass with
    // a trailing special case bolted on.
    const seen = [
      ...seqReadings.map((r) => (r.seqs.has(table) ? r.seqs.get(table) : 0)),
      ...unterminatedSeqs.filter((r) => r.has(table)).map((r) => r.get(table)),
    ];
    let agreed;
    for (const value of seen) {
      if (agreed === undefined) {
        agreed = value;
      } else if (agreed !== value) {
        conflicts.push(
          `${table}: the evidence gives two different sequence readings — ` +
            `${agreed} and ${value}. Something allocated between them, so ` +
            `neither can stand for the mirror on its own`,
        );
        agreed = undefined;
        break;
      }
    }
    if (agreed !== undefined) seqs.set(table, agreed);
  }

  // WHAT `cover` COMPARES SHAPE AGAINST: only readings that are part of
  // a paired run (#2281 r16). A shape from an unpaired or unidentified
  // reading was not observed in the run the coverage rests on, and
  // treating it as though it were is how `shape` got recorded as
  // established from a post-migration crop.
  const shapes = new Map();
  for (const e of readings) {
    if (!e.run || !paired.includes(e.run)) continue;
    for (const [t, v] of e.shapes) shapes.set(t, v);
  }

  return {
    digests,
    shapes,
    shapeLines,
    seqs,
    seqListingComplete: sawAnyComplete,
    // HOW MANY CLOSED READINGS THERE WERE, so a caller can tell an
    // evidence file that says nothing from one that says the database
    // was empty (#2281 r9). Both have empty maps.
    readings: {
      tableSets: readings.length,
      sequences: seqReadings.length,
      // How many runs closed BOTH halves, with the enumeration still
      // valid — the only kind of reading that describes one moment.
      paired: paired.length,
      // Halves that CARRY an identifier and did not find their partner.
      // Each is a run whose other half is missing from the file.
      unpaired:
        readings.filter((e) => e.run && !paired.includes(e.run)).length +
        seqReadings.filter((r) => r.run && !paired.includes(r.run)).length,
      // Halves that carry NO identifier, so nothing about them can be
      // paired or refuted. Evidence recorded before `run:<id>` existed
      // is entirely of this kind.
      unidentified,
    },
    conflicts,
  };
}

/**
 * Does this evidence substantiate this reconstruction?
 *
 * BOTH DIMENSIONS OR NEITHER (#2281 r3). Row digests alone are not
 * enough: a straggler that inserts an AUTOINCREMENT row after the mirror
 * and deletes it again leaves every row digest and count identical while
 * `sqlite_sequence` has advanced. A reconstruction absorbs that advanced
 * value, and promoting it on row evidence alone would make
 * `compareSequences` treat the late allocation as original — switching
 * off the one check written for exactly that case.
 *
 * So a table with no sequence evidence is not covered, even when its
 * rows agree. Saying "the rows match, so it is fine" is the whole
 * mistake this function exists to prevent.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function coverageProblems(tables, evidence) {
  // A disagreement inside the evidence is reported before anything is
  // compared against it: there is no single reading to compare with.
  const problems = [...(evidence.conflicts ?? [])];
  for (const [table, entry] of Object.entries(tables)) {
    const expectedDigest = evidence.digests.get(table);
    if (expectedDigest === undefined) {
      problems.push(`${table}: the evidence records no digest for it`);
    } else if (entry.digest === undefined) {
      problems.push(
        `${table}: this artifact records no digest, so nothing can be ` +
          `compared — it predates the field and cannot be promoted`,
      );
    } else if (entry.digest !== expectedDigest) {
      problems.push(
        `${table}: the evidence says ${expectedDigest}, this baseline ` +
          `read ${entry.digest} — the source CHANGED between the two`,
      );
    }
    // A table that never allocated has no line in the listing at all, so
    // absence reads as zero ONLY when the listing says it is whole.
    // Otherwise it means "not recorded", and that is not coverage.
    const expectedSeq = evidence.seqs.has(table)
      ? evidence.seqs.get(table)
      : evidence.seqListingComplete
        ? 0
        : undefined;
    if (expectedSeq === undefined) {
      problems.push(
        `${table}: the evidence records no sequence high-water mark, and ` +
          `does not say the listing is complete. An identifier allocated ` +
          `and released after the mirror leaves every row identical, so ` +
          `rows alone cannot cover it`,
      );
    } else if ((entry.seq ?? 0) !== expectedSeq) {
      problems.push(
        `${table}: the evidence says sequence ${expectedSeq}, this ` +
          `baseline read ${entry.seq ?? 0} — something allocated in ` +
          `between`,
      );
    }
    // SHAPE, WHERE THE EVIDENCE CARRIES IT (#2281 r13). Contents and
    // allocations cannot speak for row identity: a migration that
    // renames a column, or recreates a table with a different primary
    // key over the same column-order values, leaves the digest and the
    // sequence untouched while `key` and `cols` differ from what the
    // mirror would have written — and reconciliation classifies rows by
    // exactly those fields.
    const expectedShape = evidence.shapes?.get(table);
    if (expectedShape !== undefined) {
      const mine = shapeFingerprint(entry.key, entry.cols);
      if (mine !== expectedShape) {
        problems.push(
          `${table}: the evidence records shape ${expectedShape}, this ` +
            `baseline keys and projects its rows as ${mine} — the table ` +
            `was REDECLARED between the mirror and this reading, so its ` +
            `rows are not identified the same way`,
        );
      }
    }
  }
  // BOTH MAPS, NOT JUST THE DIGESTS (#2281 r5). A `seq <table> <n>` line
  // for a table the baseline does not contain is the evidence itself
  // saying the mirror held state this reconstruction does not represent
  // — and checking only the digest side let that pass. At the limit an
  // empty baseline plus one sequence line produced no findings at all.
  for (const table of new Set([
    ...evidence.digests.keys(),
    ...evidence.seqs.keys(),
  ])) {
    // OWN PROPERTY, not `in` — `"__proto__" in {}` and
    // `"toString" in {}` are both true, so `in` would read an inherited
    // name as a table this baseline represents (#2281 r10).
    if (!Object.hasOwn(tables, table)) {
      problems.push(
        `${table}: the evidence names it and this baseline does not`,
      );
    }
  }
  return problems;
}

/**
 * WHAT THE STABILITY PASS BELOW DOES AND DOES NOT ESTABLISH (#2281 r8).
 *
 * It is CHANGE DETECTION over the read, not a snapshot of the database
 * at one instant — D1 offers this tool no such instant, and a check
 * that cannot be had should be described rather than implied.
 *
 * Caught: any change to the table set, to any table's declaration or
 * shape, to the identifier counters, or to any table between its two
 * readings. Those span the whole read, so most concurrent writing shows
 * up somewhere.
 *
 * NOT caught, and this is now the only one: a change to the CONTENTS of
 * a table whose second reading has already happened, made while later
 * tables are still being read. That table's rows are not read again,
 * and an UPDATE, a DELETE or an INSERT with a natural key moves neither
 * the table set, nor any declaration, nor a counter.
 *
 * The SHAPE version of that race is closed rather than disclosed
 * (#2281 r11): the per-table checks are themselves sequential, so a
 * terminal reading of the whole schema follows all of them — one query
 * over `sqlite_master` — and catches an ALTER landing on a table whose
 * own check has already passed.
 *
 * Which is why the procedure runs this against a database nothing is
 * writing to. These checks are here to catch that precondition having
 * failed — they do not replace it, and a caller that treats a clean run
 * as proof the database was frozen is claiming more than was measured.
 */
async function takeManifest(db) {
  const readSequences = async () => {
    const seen = new Map();
    try {
      for (const r of await query(
        db.id,
        "SELECT name, seq FROM sqlite_sequence",
      )) {
        if (NEVER_CARRIED(r.name)) continue;
        const exact = exactSequence(r.seq);
        if (exact === null) {
          fail(
            `"${r.name}" has a sequence high-water mark of ${r.seq}, which ` +
              `is outside the range this tool can compare EXACTLY.\n\n` +
              `Coverage turns on whether that mark moved during an ` +
              `interval, and past 2^53 two different marks compare equal ` +
              `here — so a baseline recording one could be promoted over ` +
              `an allocation that really happened. It refuses rather than ` +
              `recording a value it cannot tell apart from its neighbour.`,
          );
        }
        seen.set(r.name, exact);
      }
    } catch (err) {
      if (!isMissingSequenceTable(err)) throw err;
    }
    return seen;
  };

  // THE INTERVAL STARTS BEFORE THE FIRST READ (#2281 r16). Stamped
  // after the opening sequence, schema and table-set queries, the
  // artifact claimed a window that excluded observations the baseline
  // is built on — so an operator correlating it against a write or
  // migration log was given a narrower interval than was actually
  // looked at. The window has to contain every reading that went into
  // the record, not merely the row reads.
  const readStartedAt = new Date().toISOString();
  const before = await readSequences();
  // THE WHOLE SCHEMA AS IT WAS, not just the carried tables' share of it
  // (#2281 r12). The terminal comparison below is whole-to-whole, so
  // both sides have to be whole: `ddlAtRead` is filled only inside the
  // carried-table loop, and `declarations` returns every object with a
  // declaration — `d1_migrations`, views, anything `tablesOf` excludes —
  // so comparing one against the other reported a difference on every
  // ordinary database and aborted the run.
  //
  // Whole-to-whole is also the stronger check: a migration applied while
  // this manifest is being taken changes `d1_migrations`, and that is a
  // database that moved, whatever it did to the carried tables.
  const ddlWholeAtRead = new Map(await declarations(db.id, { fresh: true }));
  const tables = await tablesOf(db.id);
  const manifest = newManifestTables();
  const refused = [];
  const digestAtRead = new Map();
  const ddlAtRead = new Map();

  for (const table of tables) {
    const { cols, key } = await shapeOf(db.id, table);
    ddlAtRead.set(table, await declarationOf(db.id, table));
    if (key.length === 0) {
      // Same rule as the carry: without a key nothing identifies a row,
      // so there is nothing to record it under.
      refused.push(`${table}: no primary key, so no row here can be keyed`);
      continue;
    }
    const rows = await readAll(db.id, table, cols);
    const nullKeyed = rows.find((r) =>
      key.some((c) => r[c] === null || r[c] === undefined),
    );
    if (nullKeyed) {
      refused.push(
        `${table}: a row carries NULL in its key (${key.join(", ")}), which ` +
          `SQL equality never matches, so it cannot be recorded or later ` +
          `looked up`,
      );
      continue;
    }
    const seen = {};
    for (const r of rows) seen[keyOf(r, key)] = rowHash(r, cols);
    digestAtRead.set(table, digestOf(rows, cols).digest);
    manifest[table] = manifestEntry({
      key,
      cols,
      seq: before.get(table) ?? 0,
      rows: seen,
      digest: digestOf(rows, cols).digest,
    });
  }

  // A SECOND READING OF EVERY TABLE, because the sequence check does not
  // cover the rows and `readAll`'s gate does not cover the database
  // (#2281 r1).
  //
  // The first version claimed a moving source would fail here, and that
  // was wrong three ways. `readAll` repeats only tables that PAGE, so a
  // table under one page is read once. An UPDATE, a DELETE, and an
  // INSERT under a natural key all leave `sqlite_sequence` untouched.
  // And the tables are read one after another, so a baseline can be
  // assembled from moments that never coexisted even when every
  // individual read was clean.
  //
  // D1 offers this tool no snapshot, so the honest substitute is to read
  // everything again and require it to agree. Nothing here makes that a
  // proof — two identical readings around a change and back would pass —
  // but it is the same standard the cutover's own drain barrier uses,
  // and it fails loudly on the ordinary case rather than quietly.
  //
  // THE SHAPE IS RE-READ TOO, not only the rows (#2281 r2). A migration
  // that ADDS a column and populates it changes neither digest, because
  // both passes project onto the columns the first `shapeOf` saw — and a
  // reconciliation later projects onto the columns the manifest
  // recorded, so a write confined to that new column is invisible
  // forever while every run reports VERIFIED. Comparing the stored
  // declaration is what catches it, the same instrument the carry uses
  // for the same reason.
  // A FRESH declaration read, not the cached one the first pass filled
  // (#2281 r3). Taken once for the whole database, so the per-table
  // comparisons below all read the same new snapshot.
  await declarations(db.id, { fresh: true });
  const tablesNow = await tablesOf(db.id);
  if (
    JSON.stringify([...tablesNow].sort()) !== JSON.stringify([...tables].sort())
  ) {
    fail(
      `the SET OF TABLES changed while this manifest was being taken.\n\n` +
        `A baseline assembled from a moving database describes no moment ` +
        `that ever existed.`,
    );
  }
  for (const [table, entry] of Object.entries(manifest)) {
    // THE COLUMNS TOO, because the first pass can be internally mixed
    // (#2281 r4). `shapeOf` reads `PRAGMA table_info` and the
    // declaration separately; a migration committing between them gives
    // an entry with the OLD columns and the NEW declaration. The
    // declaration then compares equal here, and the rows are re-read
    // through those same old columns, so both checks pass while a newly
    // added and populated column is omitted from the baseline forever.
    const shapeNow = await shapeOf(db.id, table);
    if (
      JSON.stringify(shapeNow.cols) !== JSON.stringify(entry.cols) ||
      JSON.stringify(shapeNow.key) !== JSON.stringify(entry.key)
    ) {
      fail(
        `"${table}" changed COLUMNS or KEY while this manifest was being ` +
          `taken.\n      recorded: cols ${entry.cols.join(", ")} | key ` +
          `${entry.key.join(", ")}\n      now:      cols ` +
          `${shapeNow.cols.join(", ")} | key ${shapeNow.key.join(", ")}\n\n` +
          `A baseline built from one reading's columns and another's ` +
          `contents describes no moment that ever existed, and a column ` +
          `added in that window would be absent from it permanently.`,
      );
    }
    const ddlNow = await declarationOf(db.id, table);
    if (ddlNow !== ddlAtRead.get(table)) {
      fail(
        `"${table}" was REDECLARED while this manifest was being taken.\n\n` +
          `A column added and populated in that window changes no digest ` +
          `here — both passes project onto the columns the first reading ` +
          `saw — and the manifest would then record a projection that ` +
          `hides every write to the new column, permanently, while later ` +
          `runs report clean.`,
      );
    }
    const rows = await readAll(db.id, table, entry.cols);
    const now = digestOf(rows, entry.cols).digest;
    if (now !== digestAtRead.get(table)) {
      fail(
        `"${table}" CHANGED while this manifest was being taken: it read ` +
          `${digestAtRead.get(table)} and now reads ${now}.\n\nA baseline ` +
          `assembled from a moving database describes no moment that ever ` +
          `existed. This is what a source that has NOT stopped looks like.`,
      );
    }
  }

  // AND ONE MORE SCHEMA READING, AFTER THE ROWS (#2281 r6).
  //
  // Every check above happens BEFORE its table's rows are re-read, so a
  // migration that adds and populates a column in the gap between them
  // still slips through: the row query projects `entry.cols`, which no
  // longer describes the table, and its digest is unchanged precisely
  // because the new column is not in it. Nothing later looks again.
  //
  // So the row reads are BRACKETED. A schema read before them and
  // another after, both fresh, both required to agree with what was
  // recorded — which is the same shape as the two-pass row read, applied
  // to the thing the row read depends on.
  await declarations(db.id, { fresh: true });
  // THE TABLE SET AFTER THE ROWS TOO, not only the shapes (#2281 r9).
  // The loop below walks the manifest, so it can only ever re-examine
  // tables the first pass already found. A table CREATED and populated
  // while the existing tables were being read is in none of them: the
  // shapes it would fail are not consulted, and if it is keyed
  // naturally there is no sequence row to move either. The baseline is
  // then accepted without it, and every later reconciliation reads that
  // table's entire contents as original.
  const tablesAfterRows = await tablesOf(db.id);
  if (
    JSON.stringify([...tablesAfterRows].sort()) !==
    JSON.stringify([...tables].sort())
  ) {
    fail(
      `the SET OF TABLES changed while the rows were being re-read.\n\n` +
        `A table created in that window is in no part of this baseline, ` +
        `and nothing later would look for it — every row it holds would ` +
        `read as original for as long as this manifest is used.`,
    );
  }
  for (const [table, entry] of Object.entries(manifest)) {
    const after = await shapeOf(db.id, table);
    const ddlAfter = await declarationOf(db.id, table);
    if (
      ddlAfter !== ddlAtRead.get(table) ||
      JSON.stringify(after.cols) !== JSON.stringify(entry.cols) ||
      JSON.stringify(after.key) !== JSON.stringify(entry.key)
    ) {
      fail(
        `"${table}" was REDECLARED after its rows were re-read.\n\nThe ` +
          `rows above were selected over the columns recorded for this ` +
          `table, so a column added and populated in that gap changes ` +
          `neither the projection nor its digest — the baseline would ` +
          `simply not contain it, permanently, while every check passed.`,
      );
    }
  }

  // AND ONE WHOLE-SCHEMA READING AFTER ALL OF THEM (#2281 r11). The
  // loop above is itself sequential: it checks one table, then the
  // next, so an ALTER landing on a table it has already passed — while
  // it is still working through the rest — is seen by nothing. The
  // table set is unchanged, the sequences are unchanged, and the
  // per-table check for that table already ran.
  //
  // `sqlite_master` is a few kilobytes and `declarations` reads the
  // whole of it in ONE query, so a terminal comparison costs one round
  // trip and closes the schema race for the entire read rather than
  // per table. What it cannot close is the ROW race — a table already
  // read twice, changed while later tables are still being read — and
  // that limitation is stated rather than implied, here and in the
  // release note.
  // THE WINDOW CLOSES BEFORE THE TERMINAL READS ARE ISSUED (#2281 r13).
  // Stamping this after the schema response ARRIVES leaves the flight
  // time inside the claimed window: SQLite executes the query, an ALTER
  // commits, the response comes back describing the older schema, and
  // the change precedes a completion time that nothing observed.
  //
  // Taken first, every terminal observation happens after it, so the
  // window is bounded by a moment both of them are later than. It is
  // the conservative endpoint rather than the latest defensible one,
  // which is the right direction for a claim an artifact makes about
  // itself.
  const readCompletedAt = new Date().toISOString();
  const ddlFinal = await declarations(db.id, { fresh: true });
  for (const name of new Set([...ddlWholeAtRead.keys(), ...ddlFinal.keys()])) {
    if ((ddlFinal.get(name) ?? null) !== (ddlWholeAtRead.get(name) ?? null)) {
      fail(
        `"${name}" was REDECLARED before this read finished.\n\nThe ` +
          `per-table checks run one after another, so a change landing ` +
          `on a table they have already passed is caught only here — by ` +
          `one reading of the whole schema, taken after all of them.`,
      );
    }
  }

  // AND the sequences, which the row digests cannot see: an identifier
  // allocated and released leaves no row behind.
  const after = await readSequences();
  // THE UNION, not just the later reading (self-review). Iterating only
  // `after` asks "did anything move up", and a table present in the
  // first reading and absent from the second would answer that with
  // silence — the one direction a check written as a loop over the new
  // values cannot see.
  for (const table of new Set([...before.keys(), ...after.keys()])) {
    const seq = after.get(table) ?? 0;
    if ((before.get(table) ?? 0) !== seq) {
      fail(
        `"${table}" allocated identifiers WHILE this manifest was being ` +
          `taken: ${before.get(table) ?? 0} before, ${seq} now.\n\nA ` +
          `baseline taken across a moving database describes no moment ` +
          `that ever existed. This is what a source that has NOT stopped ` +
          `looks like.`,
      );
    }
  }

  // THE DIGESTS THIS READ ACCEPTED are returned, because the procedure
  // asks the operator to compare them with what was recorded at the
  // mirror — and running `digest` separately afterwards observes a
  // DIFFERENT interval, so it is not evidence about the rows in this
  // artifact (#2281 r2).
  return {
    manifest,
    refused,
    digests: digestAtRead,
    readStartedAt,
    readCompletedAt,
  };
}

async function carry(src, dst, { onlyMissing, since, reportOnly = false }) {
  const tables = await orderByDependency(src.id, await tablesOf(src.id));
  const dstTables = new Set(await tablesOf(dst.id));

  const plan = [];

  const classifiedSource = new Map();

  // Schema-drift notes raised before a table is classified. They cannot
  // go into `conflicts` at that point: that is a const computed from
  // `plan` further down, so pushing to it from here is a reference into
  // the temporal dead zone. They are concatenated where `conflicts` is
  // built instead.
  const driftNotes = [];

  // The source's allocation high-water marks, read once and recorded in
  // the manifest so a later reconciliation can see the source allocate
  // past them. Declared AND populated here — a map that is only ever
  // read is the inert-fix shape this PR has hit twice.
  const readSequences = async () => {
    const seen = new Map();
    try {
      for (const r of await query(
        src.id,
        "SELECT name, seq FROM sqlite_sequence",
      )) {
        if (!NEVER_CARRIED(r.name)) seen.set(r.name, Number(r.seq));
      }
    } catch (err) {
      if (!isMissingSequenceTable(err)) throw err;
      // No `sqlite_sequence` at all means nothing has ever allocated,
      // which is a known baseline of zero for every table — not an
      // unknown one.
    }
    return seen;
  };
  const sequenceAtMirror = reportOnly ? new Map() : await readSequences();
  const sequenceBaselineKnown = !reportOnly;

  // EVERY RETURN FROM HERE GOES THROUGH ONE CONSTRUCTOR, and that is a
  // fix for a defect rather than tidiness (#2267 r26).
  //
  // There are three exits — reconcile's read-only report, the refusal
  // exit, and the completed carry — and each used to hand-list the fields
  // it returned. `classifiedSource` was added to the last one only, which
  // is the one reconcile NEVER reaches: so the source-change check added
  // to protect reconcile received `undefined`, fell back to its empty
  // default, and was disabled on the single path it was written for. It
  // could not have been caught by reading the check, only by reading the
  // exit it never came through.
  // Tables whose rows this run could NOT match across the two sides, and
  // compared against the manifest alone instead. The verdict has to know:
  // a count comparison between two sides that were never lined up is not
  // evidence of anything (#2267 r46).
  const manifestOnly = new Set();

  const result = (written) => ({
    written,
    refused,
    conflicts,
    pending,
    classifiedSource,
    manifestOnly,
    manifest: manifestOf(),
  });

  // A destination table the source does not have is refused BEFORE any
  // write, not merely reported afterwards. A mirror that proceeded would
  // leave the destination holding a table it had not examined while
  // claiming the two sides are identical.
  //
  // AND IT IS DRIFT, NOT A REFUSAL, WHEN REPORTING (#2267 r42). The r39
  // fix stopped `verdictProblems` from failing on a destination-only
  // table and stopped there — while this loop went on adding a REFUSAL
  // for the same table, and a refusal becomes a fatal problem two
  // functions later. So the trapdoor was still open by the other door:
  // one post-cutover migration that creates a table and the weekly
  // reconciliation exits non-zero forever.
  //
  // Half a fix on a convergence bug is worth recording as its own
  // lesson. The property to check was "can this run come clean", and
  // checking it at the verdict did not answer it for a value that enters
  // the verdict from somewhere else.
  for (const table of dstTables) {
    if (tables.includes(table)) continue;
    if (reportOnly) {
      driftNotes.push({
        table,
        detail:
          `only the destination has this table, which is what a migration ` +
          `creating one looks like from the retained source's side. ` +
          `Nothing here can hold a late write from the source, so there ` +
          `is nothing for this run to compare`,
      });
      continue;
    }
    plan.push({
      table,
      refused:
        "the destination has this table and the source does not. That is " +
        "a schema difference, so it is a migration decision — this tool " +
        "will not drop it and will not carry rows while it exists",
    });
  }

  for (const table of tables) {
    const { cols, key, uniques, ddl } = await shapeOf(src.id, table);
    assertRedactionsApply(table, cols);
    // A TABLE THE DESTINATION NO LONGER HAS STILL HAS A QUESTION TO
    // ANSWER, and refusing it threw the question away (#2267 r40).
    //
    // For a carry the refusal is right: there is nowhere to put the rows.
    // For the weekly reconciliation it is the check-that-can-never-pass
    // shape a fourth time — a migration that DROPS a table makes every
    // later run emit the same generic refusal, so a straggler writing
    // into that table on the retained source is indistinguishable from
    // the schema drift everyone already knows about, forever.
    //
    // The destination is simply out of the comparison here. What is left
    // is the source against the MANIFEST, which is still a real question
    // and the only one that matters: did anything write here after the
    // mirror. That is answered below rather than refused.
    const destTableGone = !dstTables.has(table);
    if (destTableGone && !reportOnly) {
      plan.push({ table, refused: "the destination has no such table" });
      continue;
    }
    if (key.length === 0) {
      plan.push({
        table,
        refused:
          "no primary key, so nothing identifies a row: an upsert has no " +
          "conflict target and a re-run would duplicate every row",
      });
      continue;
    }
    // THE DECLARATION IS THE SHAPE, so comparing declarations is the
    // whole comparison — and it is one lookup per side rather than a
    // fistful of PRAGMAs.
    //
    // Column names and primary key are not the whole shape: a destination
    // with the same columns but MISSING `notifications`' deduplication
    // index, or `notify_state`'s cascading foreign key, would pass a
    // name-only check and then permit duplicate notifications or retain
    // child rows the source would have cascaded away — while the digest
    // reported the two sides identical. Comparing the stored CREATE text
    // for the table and every index on it covers that, and covers types,
    // nullability, defaults, CHECK constraints and triggers with it,
    // without anyone having to enumerate which features matter.
    //
    // It also means the destination's own PRAGMAs are redundant: equal
    // declarations imply equal columns, key and unique indexes, so the
    // source's are used for both sides. That is 43 fewer round trips per
    // run, inside the window where the writers are stopped.
    const dstDdl = destTableGone
      ? ddl
      : ((await declarations(dst.id)).get(table) ?? "");
    if (destTableGone) {
      driftNotes.push({
        table,
        detail:
          `the destination no longer has this table, which is what a ` +
          `migration dropping it looks like from the retained source's ` +
          `side. Rows here are compared against the MANIFEST alone — a ` +
          `late write is still reported, though there is nowhere to ` +
          `apply it`,
      });
    }

    // A DDL DIFFERENCE REFUSES A CARRY. IT MUST NOT REFUSE A REPORT
    // (#2267 r36).
    //
    // Parity matters because writing rows into a differently-shaped
    // table is unsound — that is the carry's concern. `reconcile` writes
    // nothing, and the weekly run this procedure now requires happens
    // against an archive that receives no migrations after the switch,
    // so from the FIRST post-cutover migration onward a refusal here
    // would silence the only thing still looking for late writes. A
    // check that switches itself off exactly when the thing it guards
    // starts drifting is worse than no check, because the run still
    // exits reporting something.
    //
    // So in report-only mode the difference is REPORTED and the table is
    // still classified, over the manifest's column projection — which is
    // the right basis anyway, since those are the columns its hashes
    // were taken over. A key-projection change still refuses below:
    // without a shared key there is nothing to match rows by at all.
    if (dstDdl !== ddl && reportOnly) {
      driftNotes.push({
        table,
        detail:
          `the two sides DECLARE this table differently, which is ` +
          `EXPECTED once the destination has taken a migration the ` +
          `retained source has not. Rows below are still compared, over ` +
          `the columns the manifest recorded. Reported so the drift is ` +
          `visible rather than silent`,
      });
    }
    if (dstDdl !== ddl && !reportOnly) {
      plan.push({
        table,
        refused:
          `the two sides DECLARE this table differently. Compared is the ` +
          `stored CREATE text for the table and every index on it, so ` +
          `this covers types, nullability, defaults, CHECK constraints, ` +
          `foreign-key semantics and triggers, not a list of features ` +
          `someone remembered to check.\n` +
          `      source:      ${ddl.replace(/\n/g, "\n                   ")}\n` +
          `      destination: ${dstDdl.replace(/\n/g, "\n                   ")}\n` +
          `      Carrying rows across a schema difference is a migration ` +
          `decision, not a copy`,
      });
      continue;
    }
    // Each side is read ONCE. Reading the destination twice would spend a
    // second round trip to ask a question already answered, and against a
    // live destination the two answers need not even agree.
    const rows = await readAll(src.id, table, cols);
    // THE DESTINATION IS READ WITH ITS OWN COLUMNS WHEN REPORTING
    // (#2267 r38). Using the source's list is right for a mirror, where
    // parity has already been required. For the weekly reconciliation it
    // is fatal: a post-cutover migration that DROPS or renames a column
    // leaves the retained source holding it, and `SELECT "gone" FROM t`
    // against the destination fails with `no such column` before the
    // drift can even be reported — killing the only check still looking
    // for late writes. The projection check cannot catch this either,
    // since it compares the manifest against the SOURCE.
    //
    // Read each side as it actually is; the comparison below projects
    // both onto the manifest's columns, so a column the destination no
    // longer has reads as absent and shows up as a difference to look
    // at rather than as a crash.
    const heldShape =
      reportOnly && !destTableGone ? await shapeOf(dst.id, table) : null;
    const heldCols = heldShape ? heldShape.cols : cols;
    const missingKey = destTableGone
      ? []
      : key.filter((c) => !heldCols.includes(c));
    // A THIRD WAY THE DESTINATION LEAVES THE COMPARISON, and it was
    // still taking the refusal path (#2267 r45). Without the key columns
    // there, rows cannot be matched across the two sides — that part of
    // the refusal was right. What was wrong is stopping: the SOURCE and
    // the MANIFEST are untouched by a destination-side migration, so
    // "did anything write here after the mirror" is still fully
    // answerable, and answering it is the entire purpose of the weekly
    // run. A refusal instead made every week emit the same generic line,
    // in which a genuine late write is indistinguishable from the schema
    // drift everyone already knows about.
    const destKeyColumnsGone = reportOnly && missingKey.length > 0;
    if (destKeyColumnsGone) {
      driftNotes.push({
        table,
        detail:
          `the destination no longer has key column(s) ` +
          `${missingKey.map((c) => `"${c}"`).join(", ")}, so its rows ` +
          `cannot be matched to the source's at all. The source is still ` +
          `compared against the manifest below, so a late write here is ` +
          `still reported`,
      });
    } else if (missingKey.length > 0) {
      plan.push({
        table,
        key,
        cols,
        refused:
          `the destination no longer has key column(s) ` +
          `${missingKey.map((c) => `"${c}"`).join(", ")}.\n      Rows here ` +
          `cannot be matched to the source at all without them, so ` +
          `nothing this run said about this table would mean anything`,
      });
      continue;
    }
    // WHOSE UNIQUE INDEXES DECIDE. When reporting, the destination's —
    // it is the database that would reject the insert an operator makes
    // on the strength of this run. When mirroring, the two declarations
    // have already been required to match, so the source's are the same
    // list and cost no extra round trip.
    //
    // An index is only usable here if the SOURCE row can be projected
    // onto it, since that is the tuple being looked up. One naming a
    // column the source does not have is named in the report rather
    // than dropped quietly — the operator is then told the comparison
    // is narrower than the destination's real constraints, instead of
    // being left to infer it.
    const { usable: evaluableUniques, unevaluable } =
      splitUniquesByEvaluability(heldShape ? heldShape.uniques : uniques, cols);
    // Uniqueness the tuple comparison cannot honestly reproduce —
    // collated, partial or over an expression. Named rather than
    // silently simplified, on whichever side judges the insert.
    //
    // REPORTED WHERE IT CHANGES AN ANSWER, which is the reconciliation
    // (self-review, #2267 r41). A mirror matches rows by primary key and
    // makes the destination identical; it never consults a secondary
    // index to decide anything, so noting one it cannot model would be
    // noise in the window where output is read most carefully. It would
    // also have been sourced from the SOURCE's shape while the sentence
    // said "the destination".
    const unsupported = heldShape ? heldShape.unsupportedUniques : [];
    if (unsupported.length > 0) {
      driftNotes.push({
        table,
        detail:
          `the destination declares uniqueness this run cannot check — ` +
          unsupported.map((u) => `"${u.name}" (${u.why})`).join("; ") +
          `. A row reported as missing here may still be rejected, or ` +
          `accepted, by a rule this comparison does not reproduce`,
      });
    }
    if (unevaluable.length > 0) {
      driftNotes.push({
        table,
        detail:
          `the destination declares unique index(es) ` +
          `${unevaluable.map((u) => `"${u.name}"`).join(", ")} over ` +
          `column(s) the source does not have, so this run cannot say ` +
          `whether a row it reports as missing would collide there. ` +
          `Check before applying one`,
      });
    }
    // The destination of a reconciliation is the LIVE database and is
    // read as one: paged by key, with no demand that it hold still. For
    // a mirror it is inert and read the same way as the source.
    //
    // PAGED BY THE DESTINATION'S OWN KEY, MAPPED BY THE SOURCE'S
    // (#2267 r43). Those are two different jobs and this was using one
    // key for both. The cursor has to be unique in the database being
    // READ or paging skips rows — and the source's key is exactly what a
    // re-keying migration may have stopped being unique there. Two rows
    // sharing an old key across a page boundary would then be read as
    // one, so the duplicate check below — which exists to catch that
    // very migration — would see nothing to catch. A guard defeated by
    // the read that feeds it.
    //
    // The destination's own key is unique by construction, so every row
    // is read and the duplicates become visible. Matching rows to the
    // source still uses the source's key, unchanged.
    const heldPagingKey = heldShape ? heldShape.key : key;
    const destKeyless =
      reportOnly && !destTableGone && heldPagingKey.length === 0;
    if (destKeyless) {
      // NO KEY ON THE LIVE SIDE IS A BLIND SPOT, AND IT IS NAMED AS ONE.
      // Without a unique cursor there, the only paging left is OFFSET,
      // which a concurrent write tears silently; the alternative — the
      // stability gate — asks a live database to stop, which is the
      // demand r42 removed. Neither is acceptable, so the table is
      // reported as uncomparable rather than compared badly or made to
      // abort the run.
      driftNotes.push({
        table,
        detail:
          `the destination has no primary key here, so there is no unique ` +
          `cursor to read it by while it is live. Its rows cannot be ` +
          `compared with the source's — but the source is still compared ` +
          `against the manifest below, so a late write here is still ` +
          `reported. Restoring a key on the destination is what closes ` +
          `the rest`,
      });
    }
    // THE DESTINATION IS OUT OF THE COMPARISON; THE QUESTION IS NOT
    // (#2267 r44). Two ways that happens — a migration dropped the table,
    // or it dropped the key this run needs to read the live table
    // coherently — and both leave the SOURCE and the MANIFEST, which is
    // where a late write actually shows up.
    //
    // The keyless case used to `continue` here, which threw the
    // answerable question away with the unanswerable one: the run printed
    // a note and then said VERIFIED — no unresolved late write was found,
    // having not looked. A blind spot that is merely printed is not a
    // blind spot that is handled.
    const destOutOfComparison =
      destTableGone || destKeyless || destKeyColumnsGone;
    if (destOutOfComparison) manifestOnly.add(table);
    const held = destOutOfComparison
      ? []
      : await readAll(dst.id, table, heldCols, query, {
          key: reportOnly ? heldPagingKey : null,
          live: reportOnly,
        });
    // THE SOURCE AS THIS RUN CLASSIFIED IT. The verdict re-reads the
    // source afterwards, and in reconcile mode it only asks whether the
    // destination has at least as many rows — which an UPDATE does not
    // change. So a straggler that updates an archive row after its table
    // was classified produced no conflict, left the count equal, and
    // printed VERIFIED without ever reporting the late value (#2267 r25).
    // Keeping what was classified lets the verdict notice that the ground
    // it decided on has moved.
    classifiedSource.set(table, digestOf(rows, cols).digest);
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
          `a row carries NULL in its key (${key.join(", ")}). Row identity ` +
          `is what this tool compares and deletes by, and SQL equality does ` +
          `not match NULL — so such a row can be neither reliably matched ` +
          `nor removed`,
      });
      continue;
    }
    const sourceKeys = new Set(rows.map((r) => keyOf(r, key)));
    const heldKeys = new Set(held.map((r) => keyOf(r, key)));

    // TWO DESTINATION ROWS UNDER ONE SOURCE KEY IS NOT SOMETHING TO
    // OVERWRITE QUIETLY (#2267 r41). Destination rows are indexed by the
    // SOURCE's key so the two sides can be matched at all. If a
    // post-cutover migration re-keyed the table and left the old columns
    // without a uniqueness constraint, that mapping is no longer a
    // function: building it with a Map keeps whichever row came last,
    // and the run then reports agreement about a row while another row
    // with the same source identity sits beside it, unexamined.
    //
    // Proven by OBSERVATION rather than by comparing declared keys. The
    // declaration changing is not the problem — values staying unique
    // under the old key is perfectly possible, and refusing on the
    // declaration alone would stop the weekly run permanently at a
    // migration that broke nothing.
    const duplicateHeldKeys = held.length - heldKeys.size;
    const heldByKey = new Map(held.map((r) => [keyOf(r, key), r]));

    // What this carry saw, for the manifest a later reconciliation reads.
    const seen = {};
    for (const r of rows) seen[keyOf(r, key)] = rowHash(r, cols);

    // RECONCILIATION IS A THREE-WAY COMPARISON, and reading it as a
    // two-way one is how three separate defects got in. For a given key
    // there are three facts — was it in the MANIFEST (so the mirror
    // carried it), is it in the SOURCE now, is it in the DESTINATION now.
    // The three answers are what let each case be NAMED correctly.
    //
    // NONE of them is applied. `reconcile` runs with `reportOnly`, reads
    // both databases and writes to neither, so every case below is
    // reported for a person to act on — including the simplest. This
    // comment said "only ONE is safe to act on automatically" until
    // #2267 r29, describing the write path r14 removed, and it is the
    // surface a maintainer reads before the runbook.
    //
    //   manifest source dest
    //      no      yes   no   → a straggler inserted it. The simplest
    //                          case, and still REPORTED, not carried.
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

    // THE MANIFEST'S HASHES WERE COMPUTED OVER THE COLUMNS THAT EXISTED
    // AT THE MIRROR, and comparing them against hashes over today's
    // columns compares two different functions (#2267 r26-missed).
    //
    // The rollback makes this concrete: its step 0 applies pending
    // migrations to the rollback target, and step 2b then consumes this
    // manifest. A migration that touched columns would make every row
    // whose value never changed hash differently, so `source-changed`
    // would be reported for the whole table and the mandatory pre-mirror
    // gate could never come clean.
    //
    // Columns ADDED since the mirror are recoverable — they cannot have
    // altered what the old columns held — so the comparison is made over
    // the RECORDED projection. Columns removed or renamed are not: the
    // old value is simply gone, and inventing one would be the tool
    // guessing at a migration.
    const mirroredCols = since?.[table]?.cols ?? null;
    let hashCols = cols;
    if (wasSeen !== null && mirroredCols !== null) {
      const lost = mirroredCols.filter((c) => !cols.includes(c));
      if (lost.length > 0) {
        plan.push({
          table,
          key,
          cols,
          refused:
            `the manifest recorded ${mirroredCols.length} column(s) and ` +
            `${lost.map((c) => `"${c}"`).join(", ")} no longer exist(s).\n` +
            `      Its row hashes were computed over columns this table ` +
            `does not have, so every row would compare as changed. Take a ` +
            `fresh mirror as the baseline before reconciling across a ` +
            `schema change — that is a migration decision, not a copy`,
        });
        continue;
      }
      hashCols = mirroredCols;
    }

    // THE SAME ARGUMENT APPLIES TO THE KEY, and the columns check alone
    // did not cover it (#2267 r31). Every row in the manifest is indexed
    // by a key serialised from the columns the mirror used. If a
    // migration changed which columns form the primary key, today's rows
    // are indexed under a different serialisation, so the manifest scan
    // for keys the source no longer has looks them up under a key nobody
    // uses — finds nothing, concludes the destination dropped them too,
    // and lets the run pass while a stale row survives for the reverse
    // mirror to keep.
    const mirroredKey = since?.[table]?.key ?? null;
    if (
      wasSeen !== null &&
      mirroredKey !== null &&
      JSON.stringify(mirroredKey) !== JSON.stringify(key)
    ) {
      plan.push({
        table,
        key,
        cols,
        refused:
          `the manifest keyed this table by ` +
          `${mirroredKey.map((c) => `"${c}"`).join(", ")} and it is now ` +
          `keyed by ${key.map((c) => `"${c}"`).join(", ")}.\n      Every ` +
          `row in the manifest is indexed under the old serialisation, so ` +
          `nothing here can be matched against it. Take a fresh mirror as ` +
          `the baseline — a primary-key change is a migration decision, ` +
          `not a copy`,
      });
      continue;
    }
    // WITH THE DESTINATION OUT OF THE COMPARISON, two of the three facts
    // remain and they still answer the question this run exists to ask.
    // Reporting per row would be wrong here and not merely noisy: every
    // row would come back `destination-deleted`, whose whole message is
    // a warning about undoing a retention prune, when what actually
    // happened is that a migration dropped the table. So the table is
    // reported ONCE, with counts, and the counts are what an operator
    // needs to decide whether anything was lost (#2267 r40).
    if (duplicateHeldKeys > 0) {
      plan.push({
        table,
        key,
        cols,
        refused:
          `${duplicateHeldKeys} destination row(s) share a key with ` +
          `another under the source's key (${key.join(", ")}), so that ` +
          `key no longer identifies a single row there.\n      Every ` +
          `comparison this tool makes matches rows by it, so anything ` +
          `said about this table would be about whichever duplicate was ` +
          `read last. A re-keying migration that leaves the old columns ` +
          `non-unique is a migration decision, not something to resolve ` +
          `by picking one`,
      });
      continue;
    }
    const { insert, conflicts } = destOutOfComparison
      ? classifyAgainstManifestOnly({
          table,
          cols: hashCols,
          key,
          rows,
          wasSeen,
          why: destTableGone
            ? `the destination has since DROPPED this table, so nothing ` +
              `here can be applied where the data now lives`
            : destKeyColumnsGone
              ? `the destination still HAS this table but no longer has ` +
                `the column(s) its rows were matched by, so nothing there ` +
                `can be lined up with these — they may or may not already ` +
                `be present under whatever identity it now uses`
              : `the destination still HAS this table but has dropped its ` +
                `primary key, so its rows cannot be read coherently while ` +
                `it is live — these writes may or may not already be there`,
        })
      : onlyMissing
        ? classifyForReconcile({
            table,
            // The projection the manifest's hashes were taken over, which
            // is today's columns unless a migration added some since.
            cols: hashCols,
            key,
            rows,
            sourceKeys,
            heldByKey: heldByKey,
            wasSeen,
            // THE UNIQUENESS THAT WOULD ACTUALLY JUDGE THE INSERT IS THE
            // DESTINATION'S (#2267 r39). The source's list is the right one
            // for a mirror, where parity is required before anything is
            // written. For the weekly reconciliation the two sides may
            // legitimately differ, and it is the destination that would
            // reject — or silently duplicate — a row the operator applies.
            // Using the retained source's indexes there reports a row as
            // plainly missing when the destination's own new index already
            // holds it under another key, and points the operator at an
            // insert that fails.
            uniques: evaluableUniques,
            // What the destination's table actually has, so a column it
            // dropped is compared as absent rather than as NULL.
            destCols: heldShape ? new Set(heldCols) : null,
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
  // DRIFT IS CONTEXT, NOT A CONFLICT (#2267 r37). Merging it into
  // `conflicts` made every expected DDL difference a permanent failure:
  // `main()` exits through `reportProblems` whenever that array is
  // non-empty, so after the first post-cutover migration the weekly
  // reconciliation could never reach either of the two consecutive clean
  // runs the procedure requires. That is the previous round's defect one
  // level in — the check ran, and could never pass.
  const conflicts = plan.flatMap((s) => s.conflicts ?? []);
  for (const n of driftNotes) {
    console.log(`  ${n.table.padEnd(32)} schema drift — ${n.detail}`);
  }
  const manifestOf = () => {
    const m = newManifestTables();
    for (const step of plan) {
      if (step.refused) continue;
      m[step.table] = manifestEntry({
        key: step.key,
        cols: step.cols,
        seq: sequenceBaselineKnown
          ? (sequenceAtMirror.get(step.table) ?? 0)
          : null,
        rows: step.seen,
      });
    }
    return m;
  };
  // Rows the source has and the destination does not. In a mirror these
  // are carried; in a reconciliation they are REPORTED, because reconcile
  // writes nothing at all.
  const pending = reportOnly
    ? plan.flatMap((s) =>
        (s.insert ?? []).map((row) => ({ table: s.table, row, key: s.key })),
      )
    : [];

  if (reportOnly) {
    for (const r of refused) {
      console.log(`  ${r.table.padEnd(32)} REFUSED — ${r.refused}`);
    }
    console.log(
      `\nnothing was written, and nothing would have been: reconcile is ` +
        `read-only. ${refused.length} refusal(s), ${conflicts.length} ` +
        `conflict(s), ${pending.length} row(s) present on the source and ` +
        `absent from the destination.`,
    );
    return result(0);
  }

  if (refused.length > 0 || conflicts.length > 0) {
    for (const r of refused) {
      console.log(`  ${r.table.padEnd(32)} REFUSED — ${r.refused}`);
    }
    console.log(
      `\nnothing was written: ${refused.length} refusal(s) and ` +
        `${conflicts.length} conflict(s) were found while planning, and a ` +
        `run that cannot do all of what it was asked does none of it.`,
    );
    return result(0);
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
    written += await upsert(
      dst,
      step.table,
      rows,
      step.cols,
      step.key,
      onlyMissing,
    );
    const note = onlyMissing
      ? `${step.insert.length} missing`
      : `${step.all.length} upserted, ${step.surplus.length} removed`;
    if (step.all.length || step.surplus.length) {
      console.log(`  ${step.table.padEnd(32)} ${note}`);
    }
  }

  // THE BASELINE IS READ TWICE, FOR THE REASON EVERYTHING ELSE HERE IS
  // (#2267 r42). Taken once before classification, it can be stale by
  // the time the rows are read: a straggler that allocates in between
  // has its row CARRIED and verified, while the manifest still records
  // the older high-water mark — so every later reconciliation reports a
  // permanent "allocated after the mirror" about a row that was in the
  // mirror. A false standing finding on the one check that is supposed
  // to mean something.
  //
  // Recording the later reading instead would be worse in the other
  // direction: an identifier allocated and released after classification
  // would be written into the baseline as though it had been accounted
  // for, and the one thing the sequence comparison exists to catch would
  // be hidden by the record of the catch.
  //
  // So: read it again and require the two to agree. A disagreement means
  // the source moved during the mirror, which this tool already has a
  // verdict for — re-run it. Same rule as the two-pass row read and the
  // source re-read at the verdict: a conclusion is only as good as the
  // reading it was drawn from.
  const sequenceAfter = await readSequences();
  for (const [table, seq] of sequenceAfter) {
    const before = sequenceAtMirror.get(table) ?? 0;
    if (seq !== before) {
      fail(
        `"${table}" allocated identifiers WHILE this mirror was running: ` +
          `${before} before it started, ${seq} now.\n\nThe rows carried ` +
          `above were classified against the earlier reading, so the ` +
          `baseline this run would record does not describe what it ` +
          `carried — and a reconciliation reading it would report a late ` +
          `allocation that was never late, or miss one that was.\n\nThis ` +
          `is what a source that has NOT stopped looks like. Close the ` +
          `barrier (check-live-d1-bindings.mjs --writers-held) and run ` +
          `again.`,
      );
    }
  }
  return result(written);
}

/**
 * THE VERDICT, as a pure function — no network, no database.
 *
 * It is extracted because of how the crash in r15 got in and how long it
 * survived: the success path of this tool had NEVER EXECUTED. Every live
 * run had conflicts and left on the failure path, so three stale
 * references sat in the branch that prints VERIFIED, and the live-run
 * evidence reported round after round covered only half the code.
 *
 * Reaching that branch against the real pair requires a source that is
 * holding still, which is the cutover condition itself — so waiting for a
 * live run to exercise it means discovering a defect there DURING the
 * cutover. A test can reach it today.
 *
 * Exported for `test/d1Reconcile.test.ts`.
 */
export function verdictProblems({
  srcD,
  dstD,
  refused = [],
  conflicts = [],
  reconciling,
  classifiedSource = new Map(),
  // Tables whose rows were never matched across the two sides — the
  // destination dropped the table, its key, or the columns this run
  // matches by — and which were therefore compared against the manifest
  // alone. Their late writes are already reported by that comparison;
  // what must NOT happen is a second verdict drawn from putting the two
  // sides' row counts next to each other (#2267 r46).
  manifestOnly = new Set(),
}) {
  const refusedNames = new Set(refused.map((r) => r.table));
  const problems = [];

  // A table the DESTINATION has and the source does not. Nothing above
  // looks at it — the loop below walks the source — so a mirror could
  // print VERIFIED while the destination still held an unexamined table
  // and its rows, which for this database means user-facing records.
  //
  // `carry --mirror` says it makes the destination IDENTICAL to the
  // source, and that claim is simply false while such a table exists.
  // `reconcile` compares against a manifest taken when the two were in
  // parity, so an extra table means that premise no longer holds. Either
  // way it is a schema difference, which this tool treats as a migration
  // decision rather than something to resolve on its own — it will not
  // drop the table, and it will not pass over it in silence.
  //
  // A RECONCILIATION IS THE ONE CASE WHERE THIS IS EXPECTED (#2267 r39).
  // After the switch the destination keeps taking migrations and the
  // retained source never will, so the first migration that CREATES a
  // table puts the two permanently in this state — and a table the
  // source does not have cannot hold a late source write, which is the
  // only thing a reconciliation is looking for. Failing on it would end
  // the weekly run for good at the first schema change, which is the
  // check-that-can-never-pass shape again. It is reported as drift by
  // the caller instead, so it stays visible without being fatal.
  for (const table of dstD.keys()) {
    if (srcD.has(table) || refusedNames.has(table) || reconciling) continue;
    problems.push(
      `${table}: present on the destination and ABSENT from the source. ` +
        `This tool does not drop tables — that is a migration decision — ` +
        `but it will not report agreement while one side has a table the ` +
        `other does not.`,
    );
  }

  for (const [table, s] of srcD) {
    if (refusedNames.has(table)) continue;
    const d = dstD.get(table);
    if (!d) {
      // THE MIRROR'S FAILURE, NOT THE RECONCILIATION'S (#2267 r40). A
      // source table the destination lacks means a mirror did not finish
      // its job. In a reconciliation it means a migration dropped the
      // table, which is permanent — so failing here would end the weekly
      // run for good, the same trapdoor as the destination-only table
      // above. The reconciliation has already said what it can about
      // that table: the drift note names it, and the source is compared
      // against the manifest so a late write there is still reported.
      if (!reconciling) problems.push(`${table}: absent from the destination`);
    } else if (!reconciling && d.digest !== s.digest) {
      problems.push(
        `${table}: source ${s.digest} (${s.count} rows) != destination ` +
          `${d.digest} (${d.count} rows)`,
      );
    } else if (reconciling && d.count < s.count && !manifestOnly.has(table)) {
      // THE COUNT COMPARISON ASSUMES THE TWO SIDES WERE LINED UP, and
      // for a manifest-only table they never were. A migration that
      // re-keyed the destination — or filtered rows as it went, or a
      // retention cron since — leaves it legitimately holding fewer,
      // and reading that as "rows are still missing" fails the weekly
      // run every week over a difference this run has already said it
      // cannot interpret.
      //
      // The dropped-table and keyless paths avoided it only by having
      // no destination digest at all. That was luck, not a rule, and
      // this is the rule.
      problems.push(
        `${table}: destination holds ${d.count} rows, fewer than the ` +
          `source's ${s.count} — rows are still missing`,
      );
    }

    // THE SOURCE-MOVED CHECK IS NOT PART OF THAT CHAIN, and it was
    // (#2267 r40, self-review). Every branch above is a statement about
    // the DESTINATION; this one is about the source reading differently
    // now than when it was classified. Sitting at the end of an else-if
    // meant any destination-side finding suppressed it — including, as
    // of this round, a table the destination has dropped, which is
    // exactly a table whose late writes are the only thing left to look
    // for. Nothing about the destination should gate a question about
    // the source.
    if (
      reconciling &&
      classifiedSource.has(table) &&
      classifiedSource.get(table) !== s.digest
    ) {
      // THE SOURCE MOVED BETWEEN CLASSIFICATION AND THE VERDICT, so the
      // report above describes a database that no longer exists and the
      // count check cannot see it: an UPDATE leaves the count equal, so
      // a late straggler's value was neither carried nor reported while
      // the run printed VERIFIED (#2267 r25).
      //
      // This is the same rule as the two-pass read one level up — a
      // conclusion is only as good as the reading it was drawn from —
      // and reconcile is where losing it costs most, because a clean
      // reconcile is what licenses deleting the source.
      problems.push(
        `${table}: the source CHANGED while this run was working. It was ` +
          `classified as ${classifiedSource.get(table)} and now reads ` +
          `${s.digest} (${s.count} rows).\n      Every decision above ` +
          `about this table was made against the earlier reading, and a ` +
          `late UPDATE leaves the row count identical — so nothing else ` +
          `here would have noticed. Run it again.`,
      );
    }
  }

  // A REFUSED table is not a footnote. It is a table this carry did not
  // move and cannot vouch for, so it FAILS — an earlier revision printed
  // it and then exited zero with "VERIFIED", which would let an operator,
  // or a script reading the exit code, carry the cutover forward having
  // silently omitted an entire table.
  for (const r of refused)
    problems.push(`${r.table}: NOT CARRIED — ${r.refused}`);

  // Likewise a conflict, and it names the TABLE and the KEY and nothing
  // else: `support_tickets` puts the user's message and email immediately
  // after the key, `diag_errors` carries whatever a stack trace held, and
  // cutover output gets pasted into run logs and issues.
  for (const c of conflicts) {
    problems.push(
      c.key === undefined
        ? `${c.table}: cannot be reconciled — ${c.detail}`
        : `${c.table} ${c.key}: ${c.kind} — ${c.detail}.`,
    );
  }
  return problems;
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
      problems.map((p) => `  - ${p}`).join("\n") +
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
  "usage:\n" +
  "  d1-carry-rows.mjs digest    --db <name>\n" +
  "  d1-carry-rows.mjs manifest  --db <name> --out <path> --stands-for <text>\n" +
  "      READ ONLY. Takes a baseline from one database; writes no database.\n" +
  "      Always written UNCOVERED: it cannot know what happened before it ran.\n" +
  "  d1-carry-rows.mjs cover     --manifest <path> --expect <path>\n" +
  "      Promotes a reconstruction to covered, and ONLY by comparing its\n" +
  "      recorded digests AND sequences with evidence from the mirror.\n" +
  "  d1-carry-rows.mjs carry     --from <n> --to <n> --mirror --manifest <path>\n" +
  "      WRITES. Only ever against a destination nothing is writing to.\n" +
  "  d1-carry-rows.mjs reconcile --from <n> --to <n> --since <path>\n" +
  "      READ ONLY. Reports every difference; writes nothing, ever.";

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
      if (v === undefined || v.startsWith("--"))
        fail(`${a} needs a value.\n\n${USAGE}`);
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

  // `cover` RUNS BEFORE THE CREDENTIAL CHECK, because it touches no
  // database (#2281 r4). It reads a manifest and an evidence file, both
  // local, and rewrites the manifest. Requiring an API token to do that
  // would block the recovery promotion for exactly the operator this
  // path exists for: someone holding the retained artifacts, later, in a
  // session with no live access.
  if (mode === "cover") {
    const opts = parseArgs(rest, {
      flags: ["--manifest", "--expect"],
      switches: [],
    });
    const path = opts["--manifest"];
    const expect = opts["--expect"];
    if (!path || !expect) {
      fail(`cover needs --manifest <path> and --expect <path>\n\n${USAGE}`);
    }
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      fail(`could not read the manifest at ${path} — ${err.message}`);
    }
    // THE SAME LEGACY DEFAULT `readManifest` USES (#2281 r10). A
    // manifest written before provenance existed carries none, and
    // `readManifest` reads that absence as the mirror — correctly,
    // because the mirror was the only thing that wrote one. Reading it
    // as `{}` here let a zero-table mirror artifact be promoted and
    // rewritten with `interval: "covered"` and no producer, after which
    // every later run reads the one direct observation as a
    // reconstruction. The absence has to mean the same thing in both
    // places or the artifact changes identity by being read.
    const prov = doc?.provenance ?? { producer: "carry --mirror" };
    if (prov.producer === "carry --mirror") {
      fail(
        `${path} was written by the mirror. It observed the moment it ` +
          `describes, so there is no interval to cover and nothing here ` +
          `to promote.`,
      );
    }
    if (prov.interval === "covered") {
      fail(`${path} is already marked covered.`);
    }
    const evidence = parseEvidence(readFileSync(expect, "utf8"));
    // A DATABASE WITH NO TABLES PRODUCES EXACTLY THIS, and it is not the
    // same as an empty file (#2281 r9). `digest` over a source carrying
    // no application tables prints `(0 tables)` and `seq-listing
    // complete` and nothing else — a complete reading of a table set
    // that is empty, and a complete reading of an empty sequence table.
    // Both value maps come back empty, so a guard that looks only at
    // them reads valid evidence as no evidence, and the matching empty
    // reconstruction could never be promoted. A rollback path that
    // cannot be followed on a legitimate database state is a check that
    // can never pass, which is the shape this PR exists to remove.
    // AND IT HAS TO CARRY A READING OF EACH KIND (#2281 r10). Warning
    // the operator that a missing count line disables the table-set
    // check was the wrong shape: it left a silent, unannounced downgrade
    // reachable by a paste that drops one line, and the thing it
    // licenses is the reverse mirror.
    //
    // Cropping `--expect` so that one mirror-time table's digest lines
    // AND the count line are gone leaves a digest map that agrees, a
    // complete sequence listing, and no name for the missing table — so
    // `coverageProblems` has nothing to compare and promotes. If that
    // table is naturally keyed and also absent from the reconstruction,
    // nothing anywhere establishes that the two table sets match.
    //
    // So a promotion requires evidence that actually read each side:
    // one valid enumeration of the table set, and one complete sequence
    // listing. Refusing is cheap — re-paste the block — and the failure
    // it prevents is not recoverable.
    if (evidence.readings.tableSets === 0) {
      fail(
        `${expect} carries no complete reading of the table set, so it ` +
          `cannot establish that the mirror held the same tables as this ` +
          `reconstruction.\n\nPaste the whole of a "digest" run, ` +
          `including the rule-and-count line that closes it — the ` +
          `\`———…  (N tables)\` line. Without it the digests still ` +
          `compare and a table missing from BOTH the evidence and the ` +
          `reconstruction is simply never named, which is exactly what ` +
          `coverage is supposed to rule out.`,
      );
    }
    if (evidence.readings.sequences === 0) {
      fail(
        `${expect} carries no complete sequence listing, so a table with ` +
          `no "seq" line cannot be read as a known zero rather than as a ` +
          `line that was not pasted.\n\nPaste the whole of a "digest" ` +
          `run, including the "seq-listing complete" line that closes ` +
          `its sequence section.`,
      );
    }
    // AND BOTH HALVES FROM THE SAME RUN (#2281 r12). Counting the two
    // kinds of reading separately accepted one of each from DIFFERENT
    // runs, which is two moments presented as one. An early block that
    // kept its count line but lost its sequence section, followed by a
    // whole block recorded after an AUTOINCREMENT insert-and-delete,
    // gives unchanged row digests and only the later, advanced
    // sequence — no conflict anywhere, and a reconstruction carrying
    // that late allocation is promoted with no mirror-time sequence
    // evidence at all.
    // A HALF THAT NAMES ITS RUN AND FINDS NO PARTNER IS A REFUSAL; a
    // half that names no run at all is a DISCLOSURE (#2281 r15).
    //
    // Identified halves can be checked, so they are: an unpaired one is
    // a run recorded without its other half, and the run beside it
    // would answer in its place. Unidentified halves cannot be checked
    // in either direction — a lone enumeration and a lone sequence
    // listing look the same whether they came from one run or two — and
    // that is the state of every record made before `run:<id>` existed,
    // including the one covering the retained database now. Refusing
    // those would make the documented rollback unfollowable for exactly
    // the artifact this verb rebuilds, which is the defect this PR
    // removes rather than adds. So it says so instead, here and in the
    // artifact and in every later `reconcile`.
    if (evidence.readings.unpaired > 0) {
      fail(
        `${expect} does not hold a whole "digest" run: ` +
          `${evidence.readings.paired} run(s) closed both halves and ` +
          `${evidence.readings.unpaired} half-run(s) are recorded ` +
          `without their other half.\n\nEach half describes the moment ` +
          `its own run was taken, so halves from different runs describe ` +
          `two moments. A run recorded WITHOUT its sequence section is ` +
          `the dangerous shape: the row digests still agree, the run ` +
          `beside it answers for the sequences in its place, and if that ` +
          `other run was taken after an AUTOINCREMENT insert-and-delete ` +
          `it carries an allocation the mirror never saw. One unpaired ` +
          `half is enough for that, which is why every closed reading ` +
          `has to belong to a run and not merely one of them.\n\nPaste ` +
          `each "digest" run whole: its digests, its rule-and-count ` +
          `line, its "seq" lines, and its "seq-listing complete".`,
      );
    }
    const saidSomething =
      evidence.digests.size > 0 ||
      evidence.seqs.size > 0 ||
      evidence.readings.tableSets > 0 ||
      evidence.readings.sequences > 0;
    if (!saidSomething) {
      fail(
        `nothing usable was found in ${expect}. It should hold what was ` +
          `recorded AT the mirror: lines of "<table> <digest>" — the ` +
          `digest command's own output pastes in as-is — and lines of ` +
          `"seq <table> <n>" for the allocation high-water marks.`,
      );
    }
    const problems = coverageProblems(doc.tables ?? {}, evidence);
    if (problems.length > 0) {
      // NOT `reportProblems`, whose trailer explains digests, refusals
      // and conflicts against a DESTINATION — the carry's vocabulary,
      // and none of it true here. Borrowing it would have this command
      // say things it does not mean, which is the defect this whole PR
      // keeps being about.
      console.error(
        `\n[d1-carry-rows] coverage REFUSED — ${problems.length} problem(s):`,
      );
      for (const line of problems) console.error(`  - ${line}`);
      console.error(
        `\n${path} is UNCHANGED and remains uncovered. Coverage is the ` +
          `claim that this reconstruction equals what the mirror saw; the ` +
          `evidence above does not support it, so the claim is not ` +
          `recorded.\n\nA baseline that stays uncovered is still useful ` +
          `for finding NEW differences. What it must not do is license ` +
          `the rollback's reverse mirror.\n`,
      );
      process.exit(1);
    }
    // Promoted only here, with the comparison that licenses it recorded
    // alongside — so the artifact says what was checked, not merely that
    // something was.
    // WHICH DIMENSIONS WERE ACTUALLY COMPARED (#2281 r13). Shape
    // evidence is newer than the evidence some operators already hold —
    // the record made at a mirror that has passed cannot be re-taken —
    // so requiring it would make the rollback unfollowable for exactly
    // the artifact this verb exists to rebuild. But a dimension that
    // was not compared must not be left to be assumed: the artifact
    // records what it stands on, and the command says so out loud.
    const nTables = Object.keys(doc.tables ?? {}).length;
    const shapesSeen = [...Object.keys(doc.tables ?? {})].filter((t) =>
      evidence.shapes?.has(t),
    ).length;
    const dimensions = ["rows", "sequences"];
    if (shapesSeen === nTables && nTables > 0) dimensions.push("shape");
    // Pairing counts as established only when NO half is anonymous: one
    // unidentified half is enough for the file to be two moments.
    if (evidence.readings.paired > 0 && evidence.readings.unidentified === 0) {
      dimensions.push("run-pairing");
    }
    doc.provenance = {
      ...prov,
      interval: "covered",
      coveredAt: new Date().toISOString(),
      coveredDimensions: dimensions,
      coveredBy:
        `${nTables} table(s) matched on ${dimensions.join(", ")} against ` +
        `${expect}` +
        (dimensions.includes("shape")
          ? ""
          : ` — no "shape" lines, so row identity was NOT established`) +
        (dimensions.includes("run-pairing")
          ? ""
          : ` — ${evidence.readings.unidentified} half-reading(s) carry ` +
            `no "run:<id>", so it was NOT established that both halves ` +
            `came from one run`),
    };
    writeFileSync(
      `${path}.tmp-${process.pid}`,
      `${JSON.stringify(doc, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    chmodSync(`${path}.tmp-${process.pid}`, 0o600);
    renameSync(`${path}.tmp-${process.pid}`, path);
    console.log(
      `${path} is now COVERED: every table in it matches ${expect} on ` +
        `${dimensions.join(", ")}.\n\n` +
        (dimensions.includes("run-pairing")
          ? ""
          : `WHAT THIS DOES NOT COVER: ${evidence.readings.unidentified} ` +
            `half-reading(s) carry no "run:<id>", so whether the table ` +
            `set and the allocation marks were recorded by the SAME ` +
            `"digest" run could not be established. Halves from two runs ` +
            `describe two moments, and an identifier allocated and ` +
            `released between them would be absorbed here. Evidence ` +
            `recorded before that identifier existed cannot carry it, ` +
            `and a mirror that has passed cannot be re-recorded.\n\n`) +
        (dimensions.includes("shape")
          ? ""
          : `AND: the evidence carries no "shape" ` +
            `lines, so how each table keys and projects its rows at the ` +
            `mirror was not established — only that the rows and the ` +
            `allocation marks agree. A table recreated with a different ` +
            `primary key over the same column-order values reads ` +
            `identical here. Newer "digest" output records shape; ` +
            `evidence taken before it cannot, and a mirror that has ` +
            `passed cannot be re-recorded. The artifact says which ` +
            `dimensions it stands on.\n\n`) +
        `That is what licenses the rollback's reverse mirror. Record in ` +
        `the run log where the evidence came from — this artifact now ` +
        `says WHAT was compared, and only you know where it was written ` +
        `down.`,
    );
    return;
  }

  if (!ACCOUNT || !TOKEN) {
    fail("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must both be set.");
  }
  const shared = sharedDatabase();

  if (mode === "digest") {
    const opts = parseArgs(rest, { flags: ["--db"], switches: [] });
    const name = opts["--db"];
    if (!name) fail(`digest needs --db <name>\n\n${USAGE}`);
    const db = name === shared.name ? shared : await resolveByName(name);
    // ONE RUN, ONE IDENTIFIER, ON BOTH CLOSING LINES (#2281 r15).
    //
    // Rounds 12, 13, 14 and 15 each found another way to pair one run's
    // tables with another run's allocations, and each fix inferred the
    // boundary from a line that happened to be there — a digest line, a
    // repeated shape line. r15 is the crop that leaves none of them: a
    // run reduced to a `seq` line and its marker. There is always
    // another crop, because the boundary was never IN the evidence; it
    // was being guessed from what surrounded it.
    //
    // So the producer states it. Both lines that close a run carry the
    // same identifier, and `cover` pairs halves that agree on it rather
    // than halves that nothing came between. No inference is left to
    // defeat.
    const runId = randomBytes(6).toString("hex");
    printDigest(`${db.name} (${db.id})`, await digestDatabase(db), runId);
    // THE SEQUENCES TOO, so a run log made from this output carries the
    // evidence `cover` requires (#2281 r3). Rows alone cannot cover an
    // interval: an identifier allocated and released after a mirror
    // leaves every row digest identical while the high-water mark moves,
    // and a later reconstruction would absorb the moved value. This
    // output is what an operator pastes into the record at barrier time,
    // so it is where the missing half belongs.
    try {
      const seqs = await query(db.id, "SELECT name, seq FROM sqlite_sequence");
      const usable = seqs.filter((r) => !NEVER_CARRIED(r.name));
      console.log("");
      for (const r of [...usable].sort((a, b) =>
        String(a.name).localeCompare(b.name),
      )) {
        console.log(`  seq ${String(r.name).padEnd(28)} ${Number(r.seq)}`);
      }
      // ABSENCE HAS TO BE READABLE. A table that has never allocated has
      // no row here at all, so a missing line means either "never
      // allocated" — a known zero — or "the operator pasted only part of
      // this". Those are different facts, and `cover` must not guess
      // between them, so the listing says of itself that it is whole.
      console.log(`  seq-listing complete run:${runId}`);
    } catch (err) {
      if (!isMissingSequenceTable(err)) throw err;
      console.log(
        `\n  seq-listing complete run:${runId}   (nothing has ever ` +
          `allocated here)`,
      );
    }
    return;
  }

  if (mode === "manifest") {
    const opts = parseArgs(rest, {
      flags: ["--db", "--out", "--stands-for"],
      switches: [],
    });
    const name = opts["--db"];
    const out = opts["--out"];
    const standsFor = opts["--stands-for"];
    if (!name || !out)
      fail(`manifest needs --db <name> and --out <path>\n\n${USAGE}`);
    // PRESENT QUIESCENCE CANNOT SUBSTANTIATE HISTORICAL EQUALITY, and
    // the first version of this verb implied it could (#2281 r1).
    //
    // Take the exact case the reconciliation exists to find: a suspended
    // invocation commits to the source AFTER the mirror, and the source
    // then goes inert. Every present-tense test passes — the digests are
    // stable, nothing binds it any more — and the manifest taken now
    // CONTAINS that late write. A reconciliation reading it then treats
    // the write as part of the original baseline and can never report
    // it. The check is not merely weakened; it is turned against itself.
    //
    // What could substantiate the claim is evidence captured AT the
    // mirror — its recorded digests, its row counts — compared with what
    // this reading finds. This tool cannot perform that comparison: the
    // evidence lives in a run log it has no access to. So it does the
    // one thing it honestly can, which is refuse to produce an
    // unattributed baseline: the operator must state what moment this
    // stands for and what establishes it, and that statement is written
    // INTO the artifact, as a claim, attributed.
    if (!standsFor) {
      fail(
        `manifest needs --stands-for "<which moment this baseline stands ` +
          `for, and what establishes it>".\n\n` +
          `This verb reads ${name} as it is NOW. That is a stand-in for a ` +
          `mirror's baseline only if ${name} has not changed since the ` +
          `mirror — and NOTHING observable today can establish that. A ` +
          `write that committed after the mirror and before this reading ` +
          `is inside this baseline, indistinguishable from what the ` +
          `mirror saw, and no later reconciliation can report it. Present ` +
          `stillness does not substantiate past equality; only evidence ` +
          `recorded AT the mirror does — its digests and row counts, ` +
          `compared with what this reading finds.\n\n` +
          `If you have that evidence, name it. If you do not, say so ` +
          `plainly — a baseline that admits an uncovered interval is ` +
          `usable with care, and one that hides it is not.\n\n` +
          `  --stands-for "archive at the 19:56 mirror; digests at ` +
          `19:40/19:51/19:57 identical, 43 tables / 1384 rows"\n` +
          `  --stands-for "archive as of this reading only; the interval ` +
          `since the mirror is NOT covered"\n\n${USAGE}`,
      );
    }
    // WHETHER THE INTERVAL IS COVERED IS NOT THIS COMMAND'S TO RECORD
    // (#2281 r3). An earlier revision took `--interval covered` here and
    // wrote it BEFORE printing the digests that are supposed to
    // substantiate it — so the artifact asserted coverage at a moment
    // when no operator could yet have compared anything, and a
    // comparison that later failed, or never happened, left a baseline
    // claiming to license the destructive reverse mirror.
    //
    // So every reconstruction is written UNCOVERED, and `cover` is a
    // separate command that promotes it only by actually checking the
    // recorded readings against evidence from the mirror.
    // Either end of the cutover, and nothing else — the same pinning the
    // carry uses, for the same reason: a baseline is only meaningful
    // about a database this procedure is actually between.
    if (name !== shared.name && name !== PREDECESSOR.name) {
      fail(
        `this tool takes a baseline from exactly two databases: the ` +
          `shared one (${shared.name}) and its recorded predecessor ` +
          `(${PREDECESSOR.name}). It was asked for "${name}".`,
      );
    }
    const db = name === shared.name ? shared : await resolveByName(name);
    if (db.name === PREDECESSOR.name && db.id !== PREDECESSOR.id) {
      fail(
        `"${db.name}" resolves to ${db.id}, but the recorded predecessor ` +
          `is ${PREDECESSOR.id}. A database carrying that name today is ` +
          `not necessarily the one this tool was written for.`,
      );
    }
    // THE ORIGINAL IS NOT REPLACEABLE, AND THIS VERB IS ONLY NEEDED WHEN
    // IT IS ABSENT (#2281 r2). Writing over an existing artifact needs no
    // error to destroy it: a reconstruction that may have absorbed late
    // writes would silently take the place of the one baseline that
    // observed the moment it describes, and nothing can recreate that.
    if (existsSync(out)) {
      fail(
        `${out} already exists, and this verb will not replace it.\n\n` +
          `A manifest the MIRROR wrote observed the moment it describes. ` +
          `A reconstruction only stands in for that moment, and may have ` +
          `absorbed writes that committed after it. Replacing the first ` +
          `with the second destroys the only baseline that was ever a ` +
          `direct observation — and that cannot be undone.\n\n` +
          `Write to a new path. If the existing file is known to be ` +
          `unusable, move it aside deliberately first.`,
      );
    }
    console.log(
      `taking a manifest of ${db.name} (${db.id})\n` +
        `     READ ONLY — no database is written. This records ${db.name} ` +
        `AS IT IS NOW.\n` +
        `     It stands for: ${standsFor}\n` +
        `     Interval since the mirror: UNCOVERED until \`cover\` says ` +
        `otherwise\n` +
        `     A write that committed before this reading is INSIDE this ` +
        `baseline and no reconciliation using it can report the write as ` +
        `late.`,
    );
    const { manifest, refused, digests, readStartedAt, readCompletedAt } =
      await takeManifest(db);
    // A PARTIAL BASELINE IS NOT A BASELINE, and writing one would also
    // destroy whatever valid artifact was at this path (#2281 r1). The
    // refusals are reported and nothing is written.
    if (refused.length > 0) {
      reportProblems(
        [
          ...refused,
          `nothing was written to ${out}. A manifest missing a table is ` +
            `a baseline that reports nothing about it forever, and ` +
            `writing one here would have replaced whatever was at that ` +
            `path with it.`,
        ],
        db,
      );
    }
    writeManifest(
      out,
      db,
      manifest,
      {
        producer: "manifest (reconstructed)",
        // BOUNDS, not the file-write time (#2281 r2). `takenAt` is stamped
        // when the artifact is written, which is AFTER the last read — so
        // a transaction committing in between precedes `takenAt` and is
        // absent from the baseline. A sentence claiming everything before
        // `takenAt` is included says the opposite of what the file holds.
        readStartedAt,
        readCompletedAt,
        observes: `${db.name} as read between the two times above`,
        standsFor,
        interval: "uncovered",
      },
      // NOT A REPLACE. The check that `--out` was free happened before a
      // read measured in minutes; this is the one that holds at the
      // moment of writing.
      { noReplace: true },
    );
    // THE EVIDENCE THE PROCEDURE ASKS FOR, from the reading that was
    // actually accepted. Running `digest` afterwards observes a
    // different interval and says nothing about the rows in this file.
    console.log(`\nper-table digest of the reading recorded in ${out}:`);
    for (const [table, digest] of [...digests].sort()) {
      console.log(`  ${table.padEnd(32)} ${digest}`);
    }
    console.log(
      `\nrecorded ${Object.keys(manifest).length} table(s), read between ` +
        `${readStartedAt} and ${readCompletedAt}.\n\n` +
        `WRITTEN UNCOVERED, and only \`cover\` can change that. It will ` +
        `surface NEW differences as it stands, and it must NOT license ` +
        `the rollback's reverse mirror until the interval since the ` +
        `mirror has been accounted for:\n\n` +
        `  d1-carry-rows.mjs cover --manifest ${out} --expect <file>\n\n` +
        `where <file> holds what was recorded AT the mirror — the ` +
        `per-table digests AND the sequence high-water marks. \`cover\` ` +
        `compares them with the readings in the artifact and promotes it ` +
        `only on exact agreement. An assertion made here instead would be ` +
        `made before the evidence existed.`,
    );
    return;
  }

  if (mode !== "carry" && mode !== "reconcile") fail(USAGE);

  const opts = parseArgs(rest, {
    flags: ["--from", "--to", "--manifest", "--since"],
    switches: ["--mirror"],
  });
  const fromName = opts["--from"];
  const toName = opts["--to"];
  if (!fromName || !toName) {
    fail(`carry needs both --from <name> and --to <name>\n\n${USAGE}`);
  }
  if (fromName === toName) fail("--from and --to name the same database");
  // BOTH ends are pinned, not just one. See PREDECESSOR: requiring only
  // that the shared database be one end let an unrelated account database
  // be mirrored OVER the live shared data, or the shared data be copied
  // INTO one — in both cases passing a check that claimed to prevent
  // exactly that.
  const ends = new Set([fromName, toName]);
  if (!ends.has(shared.name) || !ends.has(PREDECESSOR.name)) {
    fail(
      `this tool carries rows between exactly two databases: the shared ` +
        `one (${shared.name}) and its recorded ` +
        `predecessor (${PREDECESSOR.name}). It was asked for ` +
        `"${fromName}" → "${toName}". Either direction between those two ` +
        `is allowed; nothing else is, in either direction.`,
    );
  }

  const src = fromName === shared.name ? shared : await resolveByName(fromName);
  const dst = toName === shared.name ? shared : await resolveByName(toName);
  // Resolved by NAME above, then checked by ID: a database name can be
  // reused after a delete, an id cannot.
  const other = src.name === shared.name ? dst : src;
  if (other.id !== PREDECESSOR.id) {
    fail(
      `"${other.name}" resolves to ${other.id}, but the recorded ` +
        `predecessor is ${PREDECESSOR.id}. A database carrying that name ` +
        `today is not necessarily the one this tool was written for, and ` +
        `it will not move rows on the strength of a name alone.`,
    );
  }

  // The mode is stated, never defaulted. Neither is an error; both is an
  // error; and the destructive one is not what a missing flag means.
  // TWO VERBS, AND ONLY ONE OF THEM WRITES.
  //
  // `carry --mirror` writes, and is only ever run against a destination
  // nothing is writing to — the barrier and `--writers-held` are what
  // establish that.
  //
  // `reconcile` NEVER writes. It was `carry --only-missing`, which
  // inserted into the LIVE destination, and every round of review found
  // another way that was unsafe: a secondary unique index can be filled
  // between the preflight read and the insert, and no preflight can close
  // that gap — a check against a live database is a statement about the
  // moment it read. Rather than a better preflight, the write is gone.
  // What remains is the classification, reported. The one case that used
  // to be applied automatically is now reported with the rest, and a
  // person applies it: for a straggler count expected to be zero, that is
  // a better trade than a race nobody can close.
  const wantMirror = opts["--mirror"] === true;
  const reconciling = mode === "reconcile";
  if (reconciling && wantMirror) {
    fail(`reconcile never writes, so it takes no --mirror.\n\n${USAGE}`);
  }
  if (!reconciling && !wantMirror) {
    fail(
      `carry needs --mirror, and the mode is never implied: it deletes ` +
        `destination rows the source no longer has and overwrites the ` +
        `rest, which against a live destination destroys its own newer ` +
        `values. To examine a LIVE destination without writing to it, use ` +
        `\`reconcile\`.\n\n${USAGE}`,
    );
  }

  // A mirror RECORDS what it carried; a reconciliation READS that record.
  // Without it, "the destination already has this key" cannot distinguish
  // a row a straggler changed on the source after the mirror from one the
  // destination has legitimately moved on from.
  const manifestPath = opts["--manifest"];
  const sincePath = opts["--since"];
  if (wantMirror && !manifestPath) {
    fail(
      `carry --mirror needs --manifest <path>: the reconciliation that ` +
        `follows a cutover is only meaningful against a record of what ` +
        `this carry saw, and writing it afterwards from memory is how the ` +
        `first copy of this database went unverified.\n\n${USAGE}`,
    );
  }
  if (reconciling && !sincePath) {
    fail(
      `reconcile needs --since <path>, the manifest the mirror wrote. ` +
        `Without it it can see that a key is present but CANNOT tell a ` +
        `late change on the source from the destination's own progress — ` +
        `so it would report "reconciled" having checked nothing of the ` +
        `kind.\n\n${USAGE}`,
    );
  }

  console.log(
    (reconciling ? `reconciling ` : `carrying `) +
      `${src.name} (${src.id})\n` +
      (reconciling ? `     against ` : `     into `) +
      `${dst.name} (${dst.id})\n` +
      (reconciling
        ? `     reconcile — READ ONLY. Nothing is written to either ` +
          `database. Every difference against ${sincePath} is reported ` +
          `for a person to act on, including rows the source gained`
        : `     carry --mirror — the destination is made identical to the ` +
          `source, INCLUDING removing rows the source no longer has. Run ` +
          `this only against a destination nothing is writing to`),
  );

  const since = reconciling ? readManifest(sincePath, src) : null;
  const {
    written,
    refused,
    conflicts,
    manifest,
    pending,
    classifiedSource,
    manifestOnly,
  } = await carry(src, dst, {
    onlyMissing: reconciling,
    reportOnly: reconciling,
    since,
  });
  for (const p of pending ?? []) {
    conflicts.push({
      table: p.table,
      // safeKey, not keyOf: this is a REPORT. `telegram_links` is keyed
      // by the live handshake code, and a row present only on the source
      // is exactly a fresh one (#2267 r31).
      key: safeKey(p.table, p.key, keyOf(p.row, p.key)),
      kind: "present on the source and absent from the destination",
      detail:
        "it appeared on the source after the mirror. This is the one case " +
        "that could be applied mechanically, and reconcile does not write " +
        "— apply it deliberately, then re-run",
    });
  }
  console.log(`wrote ${written} row(s)`);

  // THE EARLY EXIT BELONGS TO THE CARRY, NOT TO THE RECONCILIATION
  // (#2267 r39).
  //
  // For a carry it is right: a run that wrote nothing has nothing to
  // verify, and digesting both databases takes minutes an operator would
  // spend, inside the cutover window, waiting for a conflict list that was
  // decided before any of it started.
  //
  // For the weekly reconciliation the same exit is a trapdoor. Two of the
  // things this run does — the sequence comparison and the re-read that
  // notices the source moved under it — exist precisely because the row
  // comparison CANNOT see certain late writes: an id allocated and then
  // released leaves no row, and an UPDATE leaves the count identical. Both
  // sit after this point. And #2279 means a reconciliation can carry a
  // conflict permanently, because three situations are resolved by a
  // decision that changes no data. Put together, the first permanent
  // conflict would switch off both late-write checks for good, on the one
  // procedure still looking for late writes — the same shape as a check
  // that can never pass, one door along.
  //
  // So reconcile falls through and reports everything it found in one
  // place. `verdictProblems` re-emits the refusals and conflicts verbatim,
  // so nothing is lost by not reporting them here — the run still exits
  // non-zero, it just knows more when it does.
  if (stopsBeforeVerification({ reconciling, refused, conflicts })) {
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
  const srcD = await digestDatabase(src);
  const unreadableLive = [];
  const dstD = await digestDatabase(dst, {
    live: reconciling,
    only: reconciling ? new Set(srcD.keys()) : null,
    skipped: unreadableLive,
  });
  for (const table of unreadableLive) {
    console.log(
      `  ${table.padEnd(32)} NOT DIGESTED — the destination has no primary ` +
        `key here, so there is no unique cursor to read it by while it is ` +
        `live. Nothing in this run's verdict covers it`,
    );
  }
  printDigest(`source  ${src.name}`, srcD);
  printDigest(`target  ${dst.name}`, dstD);

  // (A table only the destination has is reported as schema drift by the
  // carry itself, in the same channel as every other drift note. An
  // ad-hoc second print here said the same thing a second time once the
  // carry started naming it — #2267 r42.)

  const problems = [
    ...verdictProblems({
      srcD,
      dstD,
      refused,
      conflicts,
      reconciling,
      classifiedSource,
      manifestOnly,
    }),
    // A mirror compares the two databases' sequences, because it is
    // about to make one match the other. A reconcile compares the
    // SOURCE against the manifest instead: a straggler that allocated an
    // id after the mirror and then deleted the row leaves the rows
    // matching and the source's sequence advanced, so nothing else in
    // this run would notice that an identifier is now spent on one side
    // and free on the other (#2267 r36).
    ...(reconciling
      ? await sequenceAdvances(src, dst, since)
      : await sequenceProblems(src, dst)),
  ];

  console.log("");
  if (problems.length > 0) reportProblems(problems, dst);

  // THE MANIFEST IS WRITTEN ONLY BY A RUN THAT SUCCEEDED, and this is the
  // last thing before the success line for that reason.
  //
  // It used to be written as soon as the carry returned — including when
  // the carry had refused and written NOTHING. A failed mirror therefore
  // replaced the baseline with archive's CURRENT values, uncarried, and a
  // later reconciliation comparing archive against that baseline would
  // find them equal and classify warm's differing row as
  // `destination-moved`: the late source update disappears, silently, in
  // the one step built to find it.
  //
  // A run that stops leaves the previous manifest untouched, which is
  // still a true record of the last carry that actually happened. Re-run
  // the mirror and a fresh one is written on success.
  if (wantMirror) writeManifest(manifestPath, src, manifest);

  console.log(
    reconciling
      ? // SAY WHAT WAS CHECKED, NOT WHAT USED TO BE TRUE (#2267 r42).
        // This claimed every source table is present in the destination,
        // which stopped being something this mode requires the moment a
        // dropped table became tolerated drift — so on exactly the run
        // where the schemas differ, the success line contradicted the
        // drift notes printed above it.
        `VERIFIED — no unresolved late write from ${src.name} was found. ` +
          (manifestOnly.size > 0
            ? `Every table whose rows this run could LINE UP holds at least ` +
              `as many rows in ${dst.name}; ${manifestOnly.size} table(s) ` +
              `could not be lined up at all and were compared against the ` +
              `manifest alone — named above, with why. Nothing here says ` +
              `how many rows ${dst.name} holds for those.`
            : `Every table the two sides share holds at least as many rows ` +
              `in ${dst.name}, and any table only one of them has is ` +
              `reported as drift above.`) +
          `\n  This mode deliberately does not claim the two sides are ` +
          `identical: the destination is live and its own newer values are ` +
          `left alone.`
      : `VERIFIED — every table the source holds is present in ${dst.name} ` +
          `with an identical content digest.`,
  );
}

// Only run when invoked as a command. A test that imports the decision
// table must not thereby start carrying rows between live databases.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => fail(err.stack ?? String(err)));
}
