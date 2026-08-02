#!/usr/bin/env node
/**
 * restore-from-archive.mjs — the committed restore converter (#1477).
 *
 * Reads a DECRYPTED `archive.json` (the object `backup.ts` encrypts
 * nightly) and produces everything `docs/ops/OffChainRestore.md`
 * §4–§5 need:
 *
 *   D1 half:  one `<outdir>/d1/<table>.sql` INSERT batch per archived
 *             table, each beginning with `DELETE FROM` so the import
 *             REPLACES the table (plain INSERTs collide with surviving
 *             primary keys on a selective restore, and attacker-added
 *             rows survive insert-only imports — §4 step 2). Apply
 *             commands are printed in FK dependency order: parents
 *             before children, because `notify_state` and
 *             `pre_grace_notify_state` cascade from `user_thresholds`
 *             (`ON DELETE CASCADE`) and a parent replaced after its
 *             child silently erases the child.
 *
 *   R2 half:  every legal-vault object materialized under
 *             `<outdir>/r2/<key>` — key VALIDATED first (the archive
 *             is attacker-influenced after a compromise; a key like
 *             `../../.ssh/authorized_keys` must die here, not at
 *             upload), then base64-decoded, written, and SHA-256
 *             verified against the archive's recorded digest. With
 *             `--upload`, each object is then uploaded via wrangler
 *             spawned with an argv ARRAY — never a shell string, so a
 *             hostile key cannot inject.
 *
 * Every failure is fatal and names its context. This script never
 * guesses: an unrecognised value type, an out-of-shape key, a row
 * count that disagrees with the archive's own header — each stops the
 * run, because a restore that silently skips is worse than one that
 * stops (§4/§5).
 *
 * Usage:
 *   node scripts/restore-from-archive.mjs <decrypted-archive.json> \
 *     [--outdir restore] [--upload] [--remote|--local] [--lz-db <name>]
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// ── Constants ─────────────────────────────────────────────────────────

// FK parents, in apply order. Children of a listed parent MUST be
// applied after it (their replace-DELETE is otherwise undone by the
// parent's cascading DELETE). The only FKs in the schema today both
// point at user_thresholds; extend this list when a migration adds a
// parent (the runbook's §4 ordering bullet is the spec).
const PARENT_TABLES_FIRST = ['user_thresholds'];

// Canonical legal-vault key shape, generated at
// `apps/agent/src/diagLegalDoc.ts` (`legal-holds/<sha256>.pdf`).
// Anything else in an archive is a reason to stop and look — after a
// compromise, "unexpected" and "hostile" are indistinguishable.
const R2_KEY_SHAPE = /^legal-holds\/[0-9a-f]{64}\.pdf$/;

const R2_BUCKET = 'vaipakam-legal-vault';

// SQL identifiers come out of the archive too, so they are untrusted
// input like everything else in it.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Per-section table ALLOWLISTS. Identifier syntax alone is not
// validation: `d1_migrations` is a perfectly-shaped identifier, and a
// hostile archive naming it would otherwise get a printed
// `DELETE FROM "d1_migrations"` command against the production
// database (Codex #1484 r1). The backup only ever exports these fixed
// sets (`backup.ts` ARCHIVE_TABLES_* + the legacy lz-watcher trio), so
// anything else in an archive is wrong or hostile — either way, stop.
// Keep in sync with backup.ts; the #1481 classification guard watches
// the backup side of that sync.
const BORN_OFF_CHAIN_TABLES = new Set([
  'diag_errors',
  'diag_legal_holds',
  'diag_legal_hold_audit',
  'user_thresholds',
  'notify_state',
  'pre_grace_notify_state', // archived since #1480; absent from older archives
  'telegram_links',
  'support_tickets',
  // #1349 M5 (migration 0047) — pre-cutover recycling day figures. The one
  // born-off-chain table in the recycling set: the rest are chain-log folds
  // that §6 replays, but these are recomputed from a getter whose input a
  // role demotion can overwrite, after which a re-run yields different
  // numbers and the original is gone. Unknown tables are rejected as
  // hostile, so omitting it here would make every post-rollout archive
  // unrestorable (Codex #1513 r1 P1).
  'recycle_day_backfill',
]);
// Archived as a restore-performance optimisation ONLY. The runbook's
// default treatment for these is §6 clear-and-replay from chain — a
// batch generated from the archive is a stale cross-query snapshot,
// so these are emitted under a separate skip-by-default heading, never
// mixed into the apply sequence (Codex #1484 r5).
const RE_DERIVABLE_TABLES = new Set([
  'offers',
  'loans',
  'activity_events',
  'oracle_snapshot_state',
  'indexer_cursor',
  'liquidity_confidence',
]);
const KNOWN_ARCHIVE_TABLES = new Set([...BORN_OFF_CHAIN_TABLES, ...RE_DERIVABLE_TABLES]);
const KNOWN_LZ_TABLES = new Set(['lz_alert_state', 'scan_cursor', 'oft_balance_history']);

// FK children of user_thresholds (ON DELETE CASCADE). Replacing the
// parent destroys live child rows, so an archive that carries the
// parent but not a child cannot be applied without silent child loss.
const CASCADE_CHILDREN = ['notify_state', 'pre_grace_notify_state'];
// The FK columns those children share with the parent.
const CASCADE_FK_COLUMNS = ['wallet', 'chain_id'];

// Every era of the backup emits these unconditionally, even at zero
// rows (`backup.ts` ARCHIVE_TABLES_REQUIRED minus the era-gated
// additions). A d1.archive that lacks any of them is truncated or
// hostile — `[]` is exactly as wrong as a missing field, and the r1
// required-section guard alone accepted it (Codex #1484 r2).
const BASELINE_TABLES = [
  'diag_errors',
  'diag_legal_holds',
  'diag_legal_hold_audit',
  'user_thresholds',
  'notify_state',
  'telegram_links',
];
// Era-gated: absent from archives older than their rollout — warn.
// (pre_grace_notify_state's era gap is warned about by the cascade
// check below, with the cascade-specific consequence spelled out.)
const ERA_GATED_TABLES = {
  support_tickets: 'migration 0028 (#1040)',
  recycle_day_backfill: 'migration 0047 (#1349 M5)',
};

// Live column sets for the born-off-chain tables (Codex #1484 r13):
// an archive whose schema OMITS a nullable/defaulted column — together
// with its rows — converts to perfectly valid SQL that completes and
// silently NULLs that column for every row after the replace-DELETE
// (e.g. dropping user_thresholds.tg_chat_id disables every Telegram
// alert). The archived schema must therefore CONTAIN at least these
// columns (a superset is fine: a newer-era archive with added columns
// either matches a migrated live schema or fails loudly at import).
// Source of truth: apps/indexer/migrations (CREATE TABLE + ALTERs).
// Scope: born-off-chain only — the re-derivable tables' default
// treatment is §6 clear-and-replay, and the legacy-lz section
// restores a retired ops db.
const REQUIRED_TABLE_COLUMNS = {
  user_thresholds: [
    'wallet', 'chain_id', 'warn_hf', 'alert_hf', 'critical_hf',
    'tg_chat_id', 'push_channel', 'created_at', 'updated_at',
    'locale', 'notify_maturity_approaching', 'last_test_alert_at',
  ],
  notify_state: ['wallet', 'chain_id', 'loan_id', 'last_band', 'last_hf_milli', 'last_sent_ts'],
  pre_grace_notify_state: ['wallet', 'chain_id', 'loan_id', 'last_sent_ts'],
  telegram_links: ['code', 'wallet', 'chain_id', 'expires_at'],
  diag_errors: [
    'id', 'recorded_at', 'client_at', 'fingerprint', 'area', 'flow', 'step',
    'error_type', 'error_name', 'error_selector', 'error_message',
    'redacted_wallet', 'chain_id', 'loan_id', 'offer_id',
    'app_locale', 'app_theme', 'viewport', 'app_version', 'wallet_hash',
  ],
  support_tickets: [
    'ticket_id', 'created_at', 'message', 'email', 'diagnostics', 'page', 'chain_id', 'status',
  ],
  diag_legal_holds: [
    'wallet_hash', 'hold_reason', 'disclosure_allowed', 'disclosure_note',
    'legal_doc_ref', 'legal_doc_sha256', 'created_at', 'updated_at',
  ],
  diag_legal_hold_audit: [
    'id', 'at', 'action', 'wallet_hash', 'admin_wallet',
    'detail', 'legal_doc_ref', 'legal_doc_sha256',
  ],
  // `armed` is the load-bearing one: an archive omitting it would restore
  // every pre-cutover day as NOT armed, republishing figures nothing
  // reserved as though the platform had committed to them.
  recycle_day_backfill: [
    'chain_id', 'day_id', 'stamped', 'schedule_floor', 'recycled_budget',
    'fresh_drawdown', 'absorbed_local', 'absorbed_mirror', 'armed',
    'armed_from_day', 'recorded_at', 'generator_rev',
  ],
};

// TRUSTED primary keys for the born-off-chain tables, from the same
// migrations REQUIRED_TABLE_COLUMNS is sourced from. The duplicate-key
// preflight must not derive the key from the archive's own `pk`
// ordinals alone — an attacker who duplicates a real key can also
// clear those ordinals, emptying the check (Codex #1484 r15). Tables
// not listed here (re-derivable, legacy-lz) fall back to the archived
// ordinals: their batches are skip-by-default / retired-db restores.
const TRUSTED_PRIMARY_KEYS = {
  user_thresholds: ['wallet', 'chain_id'],
  notify_state: ['wallet', 'chain_id', 'loan_id'],
  pre_grace_notify_state: ['wallet', 'chain_id', 'loan_id'],
  telegram_links: ['code'],
  diag_errors: ['id'],
  support_tickets: ['ticket_id'],
  diag_legal_holds: ['wallet_hash'],
  diag_legal_hold_audit: ['id'],
  recycle_day_backfill: ['chain_id', 'day_id'],
};

// The archived legal-hold tables whose rows carry `legal_doc_ref`
// (the R2 bucket key — `diagErasure.ts`: "the bucket key becomes the
// hold's legal_doc_ref").
const LEGAL_REF_TABLES = ['diag_legal_holds', 'diag_legal_hold_audit'];

// The writer's per-column shapes for those tables (Codex #1484 r11):
// `wallet_hash` is always HMAC-SHA256 hex (`diagHash.ts` — 64
// lowercase hex chars); `admin_wallet` is the lowercased
// signature-recovered admin address. Anything else can be restored
// into the TEXT columns without SQLite complaint, but production
// lookups recompute the canonical values and would never find the
// row — a hold under a malformed hash blocks nothing, and a gutted
// admin_wallet erases attribution from the append-only record.
const WALLET_HASH_SHAPE = /^[0-9a-f]{64}$/;
const ADMIN_WALLET_SHAPE = /^0x[0-9a-f]{40}$/;

// The ingestion path's byte invariants (`diagLegalDoc.ts`): non-empty,
// capped, starting with the PDF magic. The key SHAPE guarantees none
// of this — a correctly content-addressed key can sit over arbitrary
// bytes, and restoring those as `application/pdf` re-launders content
// production would have refused (Codex #1484 r3). Mirror the gate.
const MAX_LEGAL_DOC_BYTES = 15 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-');

// ── Errors ────────────────────────────────────────────────────────────

export class RestoreError extends Error {}

function fail(message) {
  throw new RestoreError(message);
}

/** Create (or reuse) one staging-directory level, refusing symlinks.
 *  A pre-planted `restore/d1` (or `restore/r2`) symlink would defeat
 *  the lexical containment checks: recursive mkdir accepts an existing
 *  symlink-to-directory, chmod FOLLOWS it, and every subsequent write
 *  lands in the link's target while reporting the staging path (Codex
 *  #1484 r15). lstat (never stat) each level we own, from the outdir
 *  itself down — file-level symlinks are already killed by the
 *  rm + 'wx' write (r14). */
function secureStagingDir(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  if (lstatSync(p).isSymbolicLink()) {
    fail(
      `staging directory ${p} is a symlink — a pre-planted link would redirect the ` +
        `decrypted restore material outside the staging tree; remove it and rerun`,
    );
  }
  chmodSync(p, 0o700);
}

// ── D1 half ───────────────────────────────────────────────────────────

export function assertIdentifier(name, ctx) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    fail(`${ctx}: identifier ${JSON.stringify(name)} is not a bare SQL identifier — refusing`);
  }
  return name;
}

/** SQLite literal for one archived value. Strict on purpose: the D1
 *  export produces only strings, finite numbers, and nulls; anything
 *  else means the archive is not what this script was written for,
 *  and guessing a representation would silently corrupt the restore. */
export function sqlLiteral(value, ctx) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${ctx}: non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000')) fail(`${ctx}: string contains NUL — refusing`);
    return `'${value.replaceAll("'", "''")}'`;
  }
  fail(`${ctx}: unrecognised value type ${typeof value} (${JSON.stringify(value)}) — refusing`);
}

/** Order tables parents-first, preserving archive order otherwise. */
export function applyOrder(tables) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const ordered = [];
  for (const parent of PARENT_TABLES_FIRST) {
    if (byName.has(parent)) ordered.push(byName.get(parent));
  }
  for (const t of tables) {
    if (!PARENT_TABLES_FIRST.includes(t.name)) ordered.push(t);
  }
  return ordered;
}

/** Convert one TableExport into a replace-not-merge SQL batch. */
export function tableToSql(table) {
  const name = assertIdentifier(table.name, 'table');
  if (!Array.isArray(table.schema) || table.schema.length === 0) {
    fail(`table ${name}: archive carries no schema — cannot order columns`);
  }
  const columns = table.schema.map((c) => assertIdentifier(c.name, `table ${name} column`));
  const rows = Array.isArray(table.rows) ? table.rows : fail(`table ${name}: rows is not an array`);
  if (typeof table.rowCount === 'number' && table.rowCount !== rows.length) {
    fail(
      `table ${name}: archive header says rowCount=${table.rowCount} but carries ${rows.length} rows — archive is self-inconsistent`,
    );
  }
  const lines = [
    `-- ${name}.sql — generated by restore-from-archive.mjs (#1477).`,
    `-- Replace-not-merge: the leading DELETE makes the import safe for`,
    `-- selective restores into a live database (OffChainRestore.md §4).`,
    `DELETE FROM "${name}";`,
  ];
  const colList = columns.map((c) => `"${c}"`).join(', ');
  // Duplicate primary keys cannot come out of a SELECT — only a
  // tampered archive carries them — and emitting them anyway produces
  // a batch that fails its UNIQUE constraint MID-file at D1, leaving
  // the table partially restored after its DELETE already committed
  // (Codex #1484 r12). For known tables the key columns come from the
  // TRUSTED per-table map, never the archive's own `pk` ordinals — an
  // attacker who duplicates a key can also clear the ordinals and
  // empty the check (r15). Unknown tables fall back to the ordinals.
  const trustedPk = TRUSTED_PRIMARY_KEYS[name];
  if (trustedPk && trustedPk.some((c) => !columns.includes(c))) {
    fail(
      `table ${name}: archived schema lacks primary-key column(s) ${trustedPk.filter((c) => !columns.includes(c)).join(', ')} — cannot verify key uniqueness`,
    );
  }
  const pkCols = trustedPk ?? table.schema
    .filter((c) => typeof c.pk === 'number' && c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const seenPks = new Set();
  for (const [i, row] of rows.entries()) {
    const keys = Object.keys(row);
    // Strict shape check: a row keyed differently from the schema is
    // drift INSIDE one archive, which the export cannot produce.
    if (keys.length !== columns.length || keys.some((k) => !columns.includes(k))) {
      fail(`table ${name} row ${i}: row keys [${keys}] do not match schema columns [${columns}]`);
    }
    if (pkCols.length > 0) {
      const pkKey = JSON.stringify(pkCols.map((c) => row[c]));
      if (seenPks.has(pkKey)) {
        fail(
          `table ${name} row ${i}: duplicate primary key (${pkCols.join(', ')}) = ${pkKey} — ` +
            `a SELECT cannot produce duplicate keys, so the archive was tampered with; ` +
            `importing would fail the UNIQUE constraint mid-batch and leave a partial restore`,
        );
      }
      seenPks.add(pkKey);
    }
    const values = columns.map((c) => sqlLiteral(row[c], `table ${name} row ${i} column ${c}`));
    lines.push(`INSERT INTO "${name}" (${colList}) VALUES (${values.join(', ')});`);
  }
  return lines.join('\n') + '\n';
}

/** Write every archived table's SQL file; returns apply-ordered
 *  entries {name, file, rowCount, database}. */
/** Everything this converter knows — allowlists, required sections,
 *  row semantics — is specific to archive version 1. A future format
 *  whose arrays happen to resemble v1 must stop HERE, not be silently
 *  interpreted under obsolete assumptions (Codex #1484 r3). */
export function assertVersion(archive) {
  if (archive?.version !== 1) {
    fail(
      `archive version is ${JSON.stringify(archive?.version)} — this converter understands ` +
        `exactly version 1; a newer archive needs a newer converter`,
    );
  }
}

export function convertD1(archive, outDir, { lzDatabase = 'vaipakam-lz-alerts-db' } = {}) {
  assertVersion(archive);
  // A version-1 archive ALWAYS carries d1.archive — backup.ts emits it
  // unconditionally. Treating its absence like the genuinely optional
  // legacy lzAlerts section would let a truncated or hostile archive
  // report a successful EMPTY restore (Codex #1484 r1).
  if (!Array.isArray(archive?.d1?.archive)) {
    fail('archive is missing the required d1.archive section — truncated or not a backup archive');
  }
  const entries = [];
  // Era-gated tables the archive omits: they still need an explicit clear
  // (see the warning site below) or a selective restore leaves live rows
  // the archive cannot vouch for.
  const eraLossClears = [];
  const sections = [
    {
      tables: archive.d1.archive,
      database: 'vaipakam-archive',
      subdir: 'd1',
      allowed: KNOWN_ARCHIVE_TABLES,
    },
    // Pre-#1440 archives still carry the lz-watcher section; its
    // target database is separate — and operator-named, since the
    // runbook permits recreating it under any name (§4).
    {
      tables: archive?.d1?.lzAlerts,
      database: lzDatabase,
      subdir: 'd1-lz-alerts',
      allowed: KNOWN_LZ_TABLES,
    },
  ];
  for (const { tables, database, subdir, allowed } of sections) {
    if (tables === undefined) continue;
    if (!Array.isArray(tables)) fail(`archive d1 section for ${database} is not an array`);
    const nameList = tables.map((t) => t?.name);
    const names = new Set(nameList);
    for (const t of names) {
      if (!allowed.has(t)) {
        fail(
          `archive names table ${JSON.stringify(t)} which the backup never exports to this ` +
            `section — wrong or hostile archive; refusing to emit a destructive batch for it`,
        );
      }
    }
    // The backup emits every table exactly once. Duplicates would
    // silently collapse (last-writer-wins on the output file while the
    // printed commands advertise stale row counts) — reject instead
    // (Codex #1484 r2).
    if (names.size !== nameList.length) {
      const dupes = nameList.filter((n, i) => nameList.indexOf(n) !== i);
      fail(`archive repeats table entr${dupes.length > 1 ? 'ies' : 'y'} ${[...new Set(dupes)].join(', ')} — the backup emits each table exactly once; refusing`);
    }
    // Baseline completeness for the main section: every era of the
    // backup carries these even at zero rows, so `[]` or a partial
    // set is a truncated/hostile archive, not a small one.
    if (database === 'vaipakam-archive') {
      const missingBaseline = BASELINE_TABLES.filter((t) => !names.has(t));
      if (missingBaseline.length > 0) {
        fail(
          `archive is missing baseline table(s) ${missingBaseline.join(', ')} — the backup ` +
            `emits these unconditionally in every era, so this archive is truncated or hostile`,
        );
      }
      for (const [t, since] of Object.entries(ERA_GATED_TABLES)) {
        if (!names.has(t)) {
          console.warn(`⚠ archive lacks ${t} (added ${since}) — an archive from before that is expected; anything newer is suspicious.`);
          // A warning alone leaves LIVE ROWS UNTOUCHED (Codex #1513 r3 P2).
          // The converter emits no replace batch for a table the archive
          // omits, so a selective restore into a post-migration database
          // silently preserves whatever is already there — which may be
          // exactly the fabricated state the restore exists to remove, and
          // which the read route then serves as authoritative history.
          //
          // Emit an explicit clear, so following the runbook cannot leave
          // unaccounted rows behind. Legitimately-pre-era archives lose
          // nothing (there was nothing to restore); a truncated archive
          // loses the attacker's rows, which is the point.
          eraLossClears.push(t);
        }
      }
      // Schema completeness per table: rows are validated against the
      // archive's OWN schema, so a schema that omits a live column
      // (with its rows shortened to match) converts cleanly and
      // silently NULLs that column for every restored row (Codex
      // #1484 r13).
      for (const table of tables) {
        const required = REQUIRED_TABLE_COLUMNS[table.name];
        if (!required) continue; // re-derivable: §6 clear-and-replay is the default
        const archivedCols = new Set((table.schema ?? []).map((c) => c?.name));
        const missing = required.filter((c) => !archivedCols.has(c));
        if (missing.length > 0) {
          fail(
            `table ${table.name}: archived schema omits live column(s) ${missing.join(', ')} — ` +
              `a replace-import would silently NULL them for every row (truncated or hostile ` +
              `archive; or a migration changed the live schema — update REQUIRED_TABLE_COLUMNS)`,
          );
        }
      }
    }
    // Cascade completeness: the parent's replace-DELETE destroys live
    // child rows, so a parent without its archived children cannot be
    // applied safely (Codex #1484 r1). pre_grace_notify_state is
    // warn-not-fail: archives written before #1480 legitimately lack
    // it, and the runbook records that loss as accepted.
    if (names.has('user_thresholds')) {
      for (const child of CASCADE_CHILDREN) {
        if (names.has(child)) continue;
        if (child === 'pre_grace_notify_state') {
          console.warn(
            `⚠ archive carries user_thresholds but not ${child} (pre-#1480 archive?): ` +
              `the parent's replace-DELETE will cascade-erase live ${child} rows with ` +
              `nothing to re-import — accepted loss per OffChainRestore.md §4, but know it.`,
          );
        } else {
          fail(
            `archive carries user_thresholds but not ${child}: applying the parent batch ` +
              `cascade-erases live ${child} rows with nothing to re-import — dependency-` +
              `incomplete archive, refusing`,
          );
        }
      }
      // Name presence is not dependency CONSISTENCY: the backup
      // exports tables in separate queries, so a parent+child pair
      // inserted between those queries can leave a child key with no
      // parent row in the same archive. Importing that batch commits
      // the parent (cascade-erasing live children) and then fails the
      // child's FK constraint — a partially-restored database. Check
      // the archived relation itself before emitting anything
      // (Codex #1484 r2).
      const parent = tables.find((t) => t.name === 'user_thresholds');
      const parentKeys = new Set(
        parent.rows.map((r) => JSON.stringify(CASCADE_FK_COLUMNS.map((c) => r[c]))),
      );
      for (const child of CASCADE_CHILDREN) {
        const childTable = tables.find((t) => t.name === child);
        if (!childTable) continue;
        for (const [i, row] of childTable.rows.entries()) {
          const key = JSON.stringify(CASCADE_FK_COLUMNS.map((c) => row[c]));
          if (!parentKeys.has(key)) {
            fail(
              `${child} row ${i} references (${CASCADE_FK_COLUMNS.map((c) => `${c}=${row[c]}`).join(', ')}) ` +
                `which is absent from the archived user_thresholds — the archive's own FK ` +
                `relation is inconsistent (snapshot race or tampering); importing it would ` +
                `commit the parent and then fail the child mid-restore, refusing`,
            );
          }
        }
      }
    }
    // Absolute from here on: the runbook invokes the converter inside
    // a `( cd ops/offchain-data-archive && … )` subshell, so a printed
    // relative path resolves to a DIFFERENT, nonexistent file once the
    // operator copies the command at the repo root (Codex #1484 r7).
    const dir = path.resolve(outDir, subdir);
    // Owner-only staging: the archive was encrypted precisely to keep
    // this material unreadable at rest, so its DECRYPTED form must not
    // inherit a permissive umask (0644 under the common 022) where any
    // local account could read diagnostics, Telegram IDs and legal-hold
    // data (Codex #1484 r12). mode is masked by umask, but 0700/0600
    // carry no group/other bits for a umask to leave behind. Reused
    // trees are re-tightened (r13) and each level we own is refused if
    // it is a planted symlink (r15) — secureStagingDir does all three,
    // level by level from the outdir down.
    secureStagingDir(path.resolve(outDir));
    secureStagingDir(dir);
    for (const table of applyOrder(tables)) {
      const sql = tableToSql(table);
      const file = path.join(dir, `${table.name}.sql`);
      // Fresh inode, never write-through: a reused predictable file
      // could already be held open by another local account, and
      // chmod cannot revoke an open descriptor. rm + 'wx' also kills
      // a planted symlink instead of following it (Codex #1484 r14).
      rmSync(file, { force: true });
      writeFileSync(file, sql, { mode: 0o600, flag: 'wx' });
      entries.push({
        name: table.name,
        file,
        rowCount: table.rows.length,
        database,
        tier:
          database !== 'vaipakam-archive'
            ? 'legacy-lz'
            : RE_DERIVABLE_TABLES.has(table.name)
              ? 're-derivable'
              : 'born-off-chain',
      });
    }

    // Clear-only batches for era-gated tables THIS section's archive
    // omits. Emitted inside the section so they keep the apply ORDER the
    // runbook depends on — appending them after every section put them
    // behind the legacy-lz database's entries, which is both meaningless
    // (different database) and broke the ordering test.
    //
    // Without them the converter emits nothing for such a table and a
    // selective restore silently keeps whatever the live database already
    // holds — possibly the fabricated rows the restore exists to remove.
    if (database === 'vaipakam-archive') {
      for (const name of eraLossClears) {
        const file = path.join(dir, `${name}.sql`);
        const sql =
          `-- ${name}.sql — generated by restore-from-archive.mjs (#1513).\n` +
          `-- The archive carries NO rows for this table. Expected for an\n` +
          `-- archive predating it, suspicious otherwise — either way the live\n` +
          `-- table must not keep rows this archive cannot vouch for.\n` +
          `DELETE FROM "${name}";\n`;
        rmSync(file, { force: true });
        writeFileSync(file, sql, { mode: 0o600, flag: 'wx' });
        entries.push({
          name,
          file,
          rowCount: 0,
          database,
          tier: 'born-off-chain',
          eraLoss: true,
        });
      }
    }
  }

  return entries;
}

// ── R2 half ───────────────────────────────────────────────────────────

/** Containment first (traversal is fatal wherever shape validation
 *  might later loosen), then the canonical shape. */
export function validateR2Key(key) {
  if (typeof key !== 'string' || key.length === 0) fail(`r2: empty/non-string key`);
  if (key.includes('\\') || key.includes('\u0000')) {
    fail(`r2 key ${JSON.stringify(key)}: backslash/NUL — refusing`);
  }
  if (path.isAbsolute(key) || key.split('/').some((seg) => seg === '..' || seg === '')) {
    fail(`r2 key ${JSON.stringify(key)}: absolute or dot-dot segment — filesystem traversal, refusing`);
  }
  if (!R2_KEY_SHAPE.test(key)) {
    fail(
      `r2 key ${JSON.stringify(key)}: does not match the canonical legal-vault shape ` +
        `legal-holds/<64-hex>.pdf — stop and inspect the archive (OffChainRestore.md §5)`,
    );
  }
  return key;
}

/** Decode, write under <outDir>/r2/<key>, verify SHA-256. */
export function materializeR2(archive, outDir) {
  assertVersion(archive);
  // Like d1.archive, backup.ts always emits r2.objects (possibly
  // empty for a vault with no documents — but the FIELD is present).
  // A missing field means a truncated/wrong archive, and reporting it
  // as "zero objects restored, success" would hide missing legal
  // documents (Codex #1484 r1).
  const objects = archive?.r2?.objects;
  if (!Array.isArray(objects)) {
    fail('archive is missing the required r2.objects section — truncated or not a backup archive');
  }
  const root = path.resolve(outDir, 'r2');
  const written = [];
  for (const obj of objects) {
    validateR2Key(obj.key);
    const local = path.resolve(root, obj.key);
    // Belt over braces: even a key that passed validation must still
    // resolve inside the staging tree.
    if (local !== root && !local.startsWith(root + path.sep)) {
      fail(`r2 key ${JSON.stringify(obj.key)}: resolves outside ${root} — refusing`);
    }
    const bytes = Buffer.from(obj.base64Body, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== obj.sha256) {
      fail(`r2 key ${obj.key}: SHA-256 mismatch (archive says ${obj.sha256}, decoded ${digest})`);
    }
    // The vault is CONTENT-ADDRESSED: the key's 64-hex component IS
    // the document's SHA-256 (`diagLegalDoc.ts`). `obj.sha256` only
    // proves the archive is internally consistent — the backup
    // computed it over whatever bytes were in the bucket, so an
    // attacker who replaced the object pre-backup gets a matching
    // digest for free. The key hash is the independent anchor the
    // D1 `legal_doc_ref` provenance relies on (Codex #1484 r1).
    const keyHash = obj.key.slice('legal-holds/'.length, -'.pdf'.length);
    if (digest !== keyHash) {
      fail(
        `r2 key ${obj.key}: decoded bytes hash to ${digest}, but the vault is ` +
          `content-addressed and the key says ${keyHash} — the archived bytes are NOT ` +
          `the document this key was minted for; treat as tampering, not as a glitch`,
      );
    }
    // Same byte gate the ingestion path enforces — a content-addressed
    // key over non-PDF bytes means the vault held something production
    // would have refused to store.
    if (bytes.length === 0 || bytes.length > MAX_LEGAL_DOC_BYTES) {
      fail(`r2 key ${obj.key}: ${bytes.length} bytes — outside the vault's (0, ${MAX_LEGAL_DOC_BYTES}] ingestion bounds (diagLegalDoc.ts)`);
    }
    if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      fail(
        `r2 key ${obj.key}: bytes do not start with the PDF magic — the ingestion path ` +
          `would have refused this document, so its presence in the vault/archive is ` +
          `itself suspect (diagLegalDoc.ts)`,
      );
    }
    // Owner-only, same as the D1 staging: these are the decrypted
    // legal documents themselves (Codex #1484 r12). Reused trees are
    // re-tightened (r13), planted symlink DIRECTORIES are refused at
    // every level we own (r15), and the file itself is always a FRESH
    // inode — chmod cannot revoke a descriptor another account already
    // holds, and rm + 'wx' refuses to follow a planted symlink (r14).
    secureStagingDir(path.resolve(outDir));
    secureStagingDir(root);
    secureStagingDir(path.dirname(local));
    rmSync(local, { force: true });
    writeFileSync(local, bytes, { mode: 0o600, flag: 'wx' });
    written.push({ key: obj.key, local, size: bytes.length });
  }
  return written;
}

/** Every non-null `legal_doc_ref` in the archived legal-hold tables
 *  must resolve to an archived R2 object. The backup exports D1 and R2
 *  independently, so an object deleted before the nightly leaves an
 *  internally consistent archive whose holds reference a document
 *  that no longer exists ANYWHERE — a restore that reports success
 *  over that is the unrecoverable-legal-document failure this whole
 *  pipeline exists to prevent (Codex #1484 r2). Returns the missing
 *  refs (with their table) for the caller to fail on. */
export function invalidLegalDocRefs(archive) {
  const r2Keys = new Set((archive?.r2?.objects ?? []).map((o) => o.key));
  const invalid = [];
  for (const table of archive?.d1?.archive ?? []) {
    if (!LEGAL_REF_TABLES.includes(table?.name)) continue;
    for (const row of table.rows ?? []) {
      const ref = row.legal_doc_ref;
      // Action-domain FIRST, independent of document presence: a
      // corrupted/hostile audit row with an unknown action and a
      // perfectly valid document pair is still an impossible record —
      // the production parser admits exactly three strings
      // (Codex #1484 r8, extending r7's documentless-only check).
      if (
        table.name === 'diag_legal_hold_audit' &&
        row.action !== 'place' &&
        row.action !== 'lift' &&
        row.action !== 'set-disclosure'
      ) {
        invalid.push({
          table: table.name,
          ref,
          problem: `audit action ${JSON.stringify(row.action)} outside the production domain ('place'/'lift'/'set-disclosure')`,
        });
        continue;
      }
      if (ref === null || ref === undefined) {
        // A HASH without a ref is never a writer-produced shape
        // (Codex #1484 r4). And null/null is table-SPECIFIC
        // (Codex #1484 r6): placing a hold REQUIRES the document
        // (`diagErasure.ts` rejects `place` without one), so a
        // current-hold row — or a `place` audit row — with neither
        // field recreates an erasure-blocking hold with no
        // authorizing evidence. The doc-less allowance is an exact-
        // string domain (`lift` / `set-disclosure`) — a relabelled
        // action (`PLACE`, `delete`, null) must not fall through it
        // (Codex #1484 r7): the production parser admits only the
        // three exact strings, so anything else is a corrupted or
        // hostile audit record.
        if (row.legal_doc_sha256 !== null && row.legal_doc_sha256 !== undefined) {
          invalid.push({ table: table.name, ref, problem: 'recorded sha present but ref is null' });
        } else if (table.name === 'diag_legal_holds') {
          invalid.push({
            table: table.name,
            ref,
            problem: 'current hold with no authorizing document (place requires one)',
          });
        } else if (table.name === 'diag_legal_hold_audit' && row.action === 'place') {
          // Domain already enforced above, so doc-less here means
          // exactly one invalid shape: a placement without evidence.
          invalid.push({
            table: table.name,
            ref,
            problem: "audit row for a 'place' with no authorizing document",
          });
        }
        continue;
      }
      // The full PAIR must hold, not just key membership (Codex #1484
      // r3): an empty ref, an off-shape ref, and a recorded sha that
      // disagrees with the hash embedded in its own key are all
      // pre-backup D1 tampering shapes that key-membership alone
      // waves through.
      if (typeof ref !== 'string' || !R2_KEY_SHAPE.test(ref)) {
        invalid.push({ table: table.name, ref, problem: 'ref is not a canonical vault key' });
        continue;
      }
      if (!r2Keys.has(ref)) {
        invalid.push({ table: table.name, ref, problem: 'document absent from the archive' });
        continue;
      }
      const keyHash = ref.slice('legal-holds/'.length, -'.pdf'.length);
      const recorded = row.legal_doc_sha256;
      // The production writer stores ref and sha TOGETHER
      // (`diagErasure.ts` derives docRef/docSha in one step), so a
      // present ref with a NULL sha is as much a tampering shape as a
      // mismatched one — the r3 null exemption was wrong (Codex #1484
      // r4).
      if (recorded === null || recorded === undefined) {
        invalid.push({ table: table.name, ref, problem: 'ref present but recorded sha is null' });
      } else if (recorded !== keyHash) {
        invalid.push({
          table: table.name,
          ref,
          problem: `recorded sha ${recorded} disagrees with the key's own hash`,
        });
      }
    }
  }
  return invalid;
}

/** Per-row writer invariants for the legal-hold tables (Codex #1484
 *  r11) — one pass that pins EVERY column shape the production writer
 *  guarantees, so this class of finding is closed as a whole rather
 *  than column-by-column:
 *
 *  - `wallet_hash` (both tables): canonical 64-lowercase-hex HMAC.
 *    SQLite would accept '' or any text, but production lookups
 *    recompute the real hash and never find the row — a hold restored
 *    under a malformed hash blocks nothing.
 *  - `admin_wallet` (audit): lowercased signature-recovered EVM
 *    address. A gutted value erases WHO took the legal action from
 *    the append-only defensible record.
 *  - `disclosure_allowed` (holds): exactly 0 or 1 — NOT NULL in the
 *    schema, and the writer binds only those two values. NULL must
 *    not be normalized into a comparable 0.
 *  - `hold_reason` (holds) and every `place` audit `detail`: a
 *    non-empty string — the parser rejects placements without one,
 *    and a gutted HISTORICAL placement erases the recorded legal
 *    basis even when the latest placement looks fine.
 *
 *  Returns {table, row, problem} entries for the caller to fail on. */
/** Unsigned decimal wei, as the writer emits it. */
const UNSIGNED_DECIMAL = /^[0-9]+$/;
/** The contract getter behind these figures returns `uint256`. */
const UINT256_MAX = (1n << 256n) - 1n;
/**
 * Digits accepted before we stop parsing at all. `uint256` maxes out at 78
 * decimal digits, so anything longer cannot be a real figure — and refusing
 * on LENGTH first means a hostile archive cannot make us build a
 * multi-megabyte BigInt just to discover it is out of range.
 */
const MAX_AMOUNT_DIGITS = 78;

/**
 * Per-row writer invariants for `recycle_day_backfill` (Codex #1513 r3).
 *
 * Column PRESENCE is not enough. The amount columns are TEXT, so
 * `schedule_floor: "not-a-number"` restores without complaint and then
 * makes the read route throw at `BigInt(...)` — a 500 for that whole chain
 * — while a plausible numeric substitution silently falsifies published
 * history instead. `armed` decides whether a day's figures are republished
 * as committed emission, so a non-boolean there is not cosmetic.
 *
 * Returns {table, row, problem} entries for the caller to fail on.
 */
export function invalidRecycleBackfillRowShapes(archive) {
  const invalid = [];
  for (const table of archive?.d1?.archive ?? []) {
    if (table?.name !== 'recycle_day_backfill') continue;
    for (const [i, row] of (table.rows ?? []).entries()) {
      const push = (problem) =>
        invalid.push({ table: table.name, row: i, problem });

      for (const col of [
        'schedule_floor', 'recycled_budget', 'fresh_drawdown',
        'absorbed_local', 'absorbed_mirror',
      ]) {
        const v = row[col];
        if (typeof v !== 'string' || !UNSIGNED_DECIMAL.test(v)) {
          push(
            `${col} ${JSON.stringify(v)} is not an unsigned decimal string — it ` +
              `restores into the TEXT column without complaint and then throws ` +
              `in the read route, 500ing the series for this chain`,
          );
        } else if (v.length > MAX_AMOUNT_DIGITS) {
          // Length BEFORE value: refusing here means a hostile archive cannot
          // make us construct an enormous BigInt just to learn it is invalid.
          push(
            `${col} has ${v.length} digits — a uint256 has at most ` +
              `${MAX_AMOUNT_DIGITS}, so this cannot be a figure the getter ` +
              `produced, and parsing it would be the attack rather than the check`,
          );
        } else if (BigInt(v) > UINT256_MAX) {
          push(
            `${col} ${v} exceeds uint256 — the contract getter behind this ` +
              `figure cannot return it, so restoring it would publish ` +
              `impossible history`,
          );
        }
      }
      for (const col of ['chain_id', 'day_id', 'armed_from_day', 'recorded_at']) {
        const v = row[col];
        // SAFE integers: 2^53 passes `Number.isInteger` and satisfies
        // `n + 1 === n`, so a restored `day_id` at that value makes the
        // read route's dense `for (dayId <= maxDay; dayId++)` loop never
        // terminate and hangs every request (Codex #1513 r4).
        if (!Number.isSafeInteger(v) || v < 0) {
          push(`${col} ${JSON.stringify(v)} is not a non-negative safe integer`);
        }
      }
      // Provenance the writer always stamps. Without it an archive can
      // restore rows under the schema's empty-string default, which makes
      // first-write-wins captures from DIFFERENT computations
      // indistinguishable — the exact ambiguity the column was added to
      // remove (Codex #1513 r5 P2).
      if (typeof row.generator_rev !== 'string' || row.generator_rev === '') {
        push(
          `generator_rev ${JSON.stringify(row.generator_rev)} is not a ` +
            `non-empty string — the writer stamps every row, so a blank one ` +
            `did not come from it and cannot be tied to a computation`,
        );
      }
      // The generator NEVER supplies these — the getter behind it does not
      // return them — yet the read surface publishes whatever is stored.
      // A fabricated margin would silently rewrite historical transparency
      // figures (Codex #1513 r7).
      for (const col of ['a_bar', 'margin_bps']) {
        if (row[col] !== null && row[col] !== undefined) {
          push(
            `${col} ${JSON.stringify(row[col])} is not null — the generator ` +
              `cannot know this field, so a value here did not come from it`,
          );
        }
      }
      if (row.stamped !== 0 && row.stamped !== 1) {
        push(`stamped ${JSON.stringify(row.stamped)} is not exactly 0 or 1`);
      }
      if (row.armed !== 0 && row.armed !== 1) {
        push(
          `armed ${JSON.stringify(row.armed)} is not exactly 0 or 1 — this flag ` +
            `decides whether the day's figures are republished as committed ` +
            `emission rather than as an estimate`,
        );
      }
      // The writer SKIPS an unfinalized day with no absorption — there is
      // nothing to preserve. A restored empty row is therefore not a shape
      // it produces, and it is not inert: every row participates in the
      // head query's MIN(day_id), so an invented early one drags the
      // coverage boundary back and makes the API publish synthetic quiet
      // buckets for days it never observed (Codex #1513 r8).
      if (
        row.stamped === 0 &&
        String(row.absorbed_local) === '0' &&
        String(row.absorbed_mirror) === '0'
      ) {
        push(
          `an unfinalized row with no absorption is not a shape the writer ` +
            `emits (it skips those) — restored, it would drag coverage back ` +
            `and fabricate quiet days`,
        );
      }
      if (row.stamped === 0 && row.armed === 1) {
        push(
          `an unfinalized day cannot be armed — the writer emits armed=0 for ` +
            `absorption-only rows, so this pair is not a shape it produces`,
        );
      }
      // `armed` must AGREE with the sentinel, not merely be a valid scalar
      // (Codex #1513 r4). `armed_from_day = 0` means the governor was NEVER
      // armed, so a stamped row claiming armed=1 under it restores figures
      // nothing reserved and republishes them as committed emission. The
      // writer derives one from the other; an archive where they disagree
      // did not come from the writer.
      if (
        row.stamped === 1 &&
        Number.isSafeInteger(row.day_id) &&
        Number.isSafeInteger(row.armed_from_day)
      ) {
        const expected =
          row.armed_from_day !== 0 && row.day_id >= row.armed_from_day ? 1 : 0;
        if (row.armed !== expected) {
          push(
            `armed=${row.armed} contradicts armed_from_day=${row.armed_from_day} ` +
              `for day ${row.day_id} (the writer derives armed=${expected}) — ` +
              `restoring it would republish an estimate as committed emission`,
          );
        }
      }
    }
  }
  return invalid;
}

export function invalidLegalRowShapes(archive) {
  const invalid = [];
  for (const table of archive?.d1?.archive ?? []) {
    if (!LEGAL_REF_TABLES.includes(table?.name)) continue;
    for (const [i, row] of (table.rows ?? []).entries()) {
      const push = (problem) => invalid.push({ table: table.name, row: i, problem });
      if (typeof row.wallet_hash !== 'string' || !WALLET_HASH_SHAPE.test(row.wallet_hash)) {
        push(`wallet_hash ${JSON.stringify(row.wallet_hash)} is not the canonical 64-lowercase-hex HMAC — production would never find this row, so a hold under it blocks nothing`);
      }
      if (table.name === 'diag_legal_holds') {
        if (row.disclosure_allowed !== 0 && row.disclosure_allowed !== 1) {
          push(`disclosure_allowed ${JSON.stringify(row.disclosure_allowed)} is not exactly 0 or 1 — the column is NOT NULL and the writer binds only those values`);
        }
        if (typeof row.hold_reason !== 'string' || row.hold_reason === '') {
          push(`hold_reason ${JSON.stringify(row.hold_reason)} is not a non-empty string — the parser rejects placements without a reason`);
        }
      } else {
        if (typeof row.admin_wallet !== 'string' || !ADMIN_WALLET_SHAPE.test(row.admin_wallet)) {
          push(`admin_wallet ${JSON.stringify(row.admin_wallet)} is not a lowercased EVM address — the writer records the signature-recovered admin, so attribution was erased or forged`);
        }
        if (row.action === 'place' && (typeof row.detail !== 'string' || row.detail === '')) {
          push(`'place' audit detail ${JSON.stringify(row.detail)} is not the non-empty holdReason — a gutted placement erases the recorded legal basis from the append-only record`);
        }
      }
    }
  }
  return invalid;
}

/** The holds table and its audit trail are exported by SEPARATE
 *  queries, so a `place`/`lift` landing between them yields an archive
 *  where every row is individually valid but the PAIR is not: a
 *  `place` audit with no current hold restores WITHOUT a legally
 *  required erasure block; a hold whose latest audit is `lift`
 *  resurrects a lifted hold and wrongly blocks erasure (Codex #1484
 *  r7). The audit trail is replayed per wallet as the writer's own
 *  STATE MACHINE (`diagErasure.ts`), ordered by (at, id) — the table
 *  is append-only autoincrement:
 *
 *  - `place` on an absent wallet inserts a fresh row: reason + doc
 *    from the request, disclosure_allowed=0 / note NULL. A re-place
 *    refreshes reason + doc and leaves disclosure UNTOUCHED. The
 *    place audit's `detail` is the raw holdReason — the same value
 *    bound into `hold_reason` (Codex #1484 r9 P2: a re-place between
 *    the two exports must not leave the register citing a stale
 *    order, so the reason is reconciled too).
 *  - `lift` DELETEs the row — reason, doc and disclosure state all
 *    die with it.
 *  - `set-disclosure` requires an existing hold (the endpoint 404s
 *    WITHOUT appending an audit row otherwise), then updates
 *    flag+note; detail format `disclosure_allowed=<0|1>; note=<note>`.
 *    A `set-disclosure` while no hold existed is therefore an
 *    impossible record and is flagged outright rather than merely
 *    ignored (Codex #1484 r9 P1 — r8's after-the-last-lift filter
 *    let one masquerade as the expected state).
 *
 *  The replayed end state (membership, document, reason, disclosure
 *  flag/note) is compared against the archived hold row; any
 *  disagreement means the two tables are not from one consistent
 *  moment (snapshot race) or were tampered with. Off-format
 *  set-disclosure detail fails rather than guesses (Codex #1484 r8).
 *  Returns {walletHash, problem} entries for the caller to fail on. */
export function reconcileLegalHolds(archive) {
  const tables = archive?.d1?.archive ?? [];
  const holds = tables.find((t) => t?.name === 'diag_legal_holds');
  const audit = tables.find((t) => t?.name === 'diag_legal_hold_audit');
  if (!holds || !audit) return []; // baseline check already fails these
  const holdByWallet = new Map(holds.rows.map((r) => [r.wallet_hash, r]));
  const byWallet = new Map(); // wallet_hash -> its audit rows
  for (const row of audit.rows) {
    // Unknown actions are already fatal via invalidLegalDocRefs.
    if (row.action !== 'place' && row.action !== 'lift' && row.action !== 'set-disclosure') continue;
    let rows = byWallet.get(row.wallet_hash);
    if (!rows) byWallet.set(row.wallet_hash, (rows = []));
    rows.push(row);
  }
  const problems = [];
  const seenWallets = new Set();
  for (const [wallet, rows] of byWallet) {
    rows.sort((a, b) => a.at - b.at || a.id - b.id);
    let held = false;
    let sawMembership = false;
    let lastPlace = null; // latest place — carries current reason + doc
    let discRow = null; // latest set-disclosure on the CURRENT row
    for (const row of rows) {
      if (row.action === 'place') {
        if (!held) discRow = null; // fresh row starts gagged (0/NULL)
        held = true;
        sawMembership = true;
        lastPlace = row;
      } else if (row.action === 'lift') {
        held = false;
        sawMembership = true;
        discRow = null; // died with the deleted row
      } else if (!held) {
        problems.push({
          walletHash: wallet,
          problem: "audit has a 'set-disclosure' while no hold existed — the production endpoint 404s without appending, so this record is impossible (tampering)",
        });
      } else {
        discRow = row;
      }
    }
    const hold = holdByWallet.get(wallet);
    if (sawMembership) seenWallets.add(wallet);
    if (!sawMembership) {
      // Only set-disclosure rows — the orphan-hold sweep below decides.
    } else if (held && !hold) {
      problems.push({
        walletHash: wallet,
        problem: "latest audit is 'place' but no current hold exists — restoring omits a legally required erasure block (snapshot race or tampering)",
      });
    } else if (!held && hold) {
      problems.push({
        walletHash: wallet,
        problem: "latest audit is 'lift' but a current hold row exists — restoring resurrects a lifted hold (snapshot race or tampering)",
      });
    } else if (held && hold) {
      if (hold.legal_doc_ref !== lastPlace.legal_doc_ref) {
        problems.push({
          walletHash: wallet,
          problem: "current hold's document differs from its latest 'place' audit — the pair is not from one consistent moment",
        });
      }
      // The production parser REJECTS a placement without a non-empty
      // string reason (`diagErasure.ts`), so an empty/NULL placement
      // detail is an impossible record — do not normalize it into a
      // comparable '' that a matching gutted hold_reason would pass
      // (Codex #1484 r10).
      if (typeof lastPlace.detail !== 'string' || lastPlace.detail === '') {
        problems.push({
          walletHash: wallet,
          problem: "latest 'place' audit carries an empty or non-string reason — the production parser requires a non-empty holdReason, so this record is impossible (tampering)",
        });
      } else if (hold.hold_reason !== lastPlace.detail) {
        problems.push({
          walletHash: wallet,
          problem: "current hold's reason differs from its latest 'place' audit — restoring would leave the legal register citing a stale order or case (snapshot race or tampering)",
        });
      }
      let expectedAllowed = 0;
      let expectedNote = '';
      if (discRow) {
        const m = /^disclosure_allowed=([01]); note=(.*)$/s.exec(String(discRow.detail ?? ''));
        if (!m) {
          problems.push({
            walletHash: wallet,
            problem: `latest 'set-disclosure' audit detail ${JSON.stringify(discRow.detail)} does not match the writer's structured format — cannot verify the hold's disclosure state`,
          });
          continue;
        }
        expectedAllowed = Number(m[1]);
        expectedNote = m[2];
      }
      // Strict on the flag: NULL/undefined must not coerce into a
      // matching 0 (invalidLegalRowShapes rejects the row anyway —
      // r11). The note's `?? ''` stays: NULL note is a legitimate
      // writer value and the audit detail encodes it as ''.
      if (hold.disclosure_allowed !== expectedAllowed || (hold.disclosure_note ?? '') !== expectedNote) {
        problems.push({
          walletHash: wallet,
          problem: "current hold's disclosure flag/note disagrees with the audit replay — restoring could surface (or gag) a retained-by-law note the latest 'set-disclosure' decided otherwise (snapshot race or tampering)",
        });
      }
    }
  }
  for (const wallet of holdByWallet.keys()) {
    if (!seenWallets.has(wallet)) {
      problems.push({
        walletHash: wallet,
        problem: 'current hold has no place/lift audit history at all — the writer always appends one',
      });
    }
  }
  return problems;
}

/** Upload each materialized object. argv ARRAY, never a shell string —
 *  no shell parsing means no escape rules to get wrong (§5 pitfall 2).
 *  `--content-type application/pdf` restores the httpMetadata the
 *  originals were stored with (`diagLegalDoc.ts`) — wrangler only
 *  forwards an explicitly supplied value, and the key shape already
 *  guarantees every vault object is a PDF (Codex #1484 r2). */
export function uploadR2(written, { remote = true, spawn = spawnSync } = {}) {
  for (const { key, local } of written) {
    const args = [
      'r2', 'object', 'put', `${R2_BUCKET}/${key}`,
      '--file', local,
      '--content-type', 'application/pdf',
    ];
    if (remote) args.push('--remote');
    const r = spawn('wrangler', args, { stdio: 'inherit' });
    if (r.status !== 0) {
      fail(`wrangler r2 object put failed for ${key} (exit ${r.status})`);
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

/** POSIX single-quote for display in printed commands — the emitted
 *  text must be ONE shell argument even when --outdir carried spaces
 *  or metacharacters (the upload path avoids this class structurally
 *  with an argv array; printed commands can only quote). */
export function shQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

export function main(argv) {
  const args = argv.slice(2);
  const positional = [];
  let outDir = 'restore';
  let upload = false;
  let remote = true;
  let lzDatabase = 'vaipakam-lz-alerts-db';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--outdir') outDir = args[++i] ?? fail('--outdir needs a value');
    else if (a === '--upload') upload = true;
    else if (a === '--local') remote = false;
    else if (a === '--remote') remote = true; // explicit form of the default
    else if (a === '--lz-db') lzDatabase = args[++i] ?? fail('--lz-db needs a value');
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error(
      'Usage: node scripts/restore-from-archive.mjs <decrypted-archive.json> ' +
        '[--outdir restore] [--upload] [--remote|--local] [--lz-db <name>]',
    );
    return 2;
  }

  const archive = JSON.parse(readFileSync(positional[0], 'utf8'));
  // Row-shape validation runs BEFORE either materialization (Codex #1513
  // r4). Validating afterwards still exits non-zero and still prints no
  // apply command, but the staging directory has already been overwritten
  // with a batch built from the hostile archive — replacing a prior
  // known-good staging output at the documented restore path. Refusing
  // before anything is written keeps the failure non-destructive.
  const badBackfill = invalidRecycleBackfillRowShapes(archive);
  if (badBackfill.length > 0) {
    for (const { table, row, problem } of badBackfill) {
      console.error(`✗ ${table} row ${row}: ${problem}`);
    }
    fail(
      `${badBackfill.length} recycle_day_backfill row(s) violate the writer's ` +
        `column invariants — restoring them would either 500 the transparency ` +
        `series or republish falsified history as the record. Pick a different ` +
        `archive, or escalate: this can be evidence of pre-backup tampering`,
    );
  }

  const d1 = convertD1(archive, outDir, { lzDatabase });
  const r2 = materializeR2(archive, outDir);

  // Per-row writer invariants on the legal tables first — a malformed
  // wallet_hash / admin_wallet / disclosure flag is restorable SQL but
  // production-impossible data (r11).
  const badShapes = invalidLegalRowShapes(archive);
  if (badShapes.length > 0) {
    for (const { table, row, problem } of badShapes) {
      console.error(`✗ ${table} row ${row}: ${problem}`);
    }
    fail(
      `${badShapes.length} legal-hold row(s) violate the production writer's column invariants — ` +
        `the archive carries values the writer cannot produce. Pick a different archive, or ` +
        `escalate: this can be evidence of pre-backup tampering in D1`,
    );
  }
  // Cross-halves check: legal holds must not reference documents the
  // archive does not carry.
  const badDocs = invalidLegalDocRefs(archive);
  if (badDocs.length > 0) {
    for (const { table, ref, problem } of badDocs) {
      console.error(`✗ ${table} ref ${JSON.stringify(ref)}: ${problem}`);
    }
    fail(
      `${badDocs.length} legal-hold row(s) fail the document-reference invariants — ` +
        `restoring would produce holds whose authorizing documents are missing, mislabelled ` +
        `or mismatched. Pick a different archive, or escalate: this can be evidence of ` +
        `pre-backup tampering in D1 or the vault`,
    );
  }
  const holdDrift = reconcileLegalHolds(archive);
  if (holdDrift.length > 0) {
    for (const { walletHash, problem } of holdDrift) {
      console.error(`✗ legal-hold reconciliation, wallet ${walletHash}: ${problem}`);
    }
    fail(
      `${holdDrift.length} wallet(s) fail hold↔audit reconciliation — the two tables were ` +
        `snapshotted at different moments (or tampered with). A hold that should not exist, ` +
        `or should, is a legal outcome, not a data glitch: pick an adjacent nightly whose ` +
        `pair reconciles, or resolve the drift manually before importing`,
    );
  }

  const locality = remote ? '--remote' : '--local';
  const cmd = (e) =>
    `wrangler d1 execute ${shQuote(e.database)} --file=${shQuote(e.file)} ${locality}   # ${e.rowCount} rows`;
  const born = d1.filter((e) => e.tier === 'born-off-chain');
  const derived = d1.filter((e) => e.tier === 're-derivable');
  const legacy = d1.filter((e) => e.tier === 'legacy-lz');

  console.log(`\nD1 (born-off-chain): ${born.length} batch(es). Apply IN THIS ORDER`);
  console.log('(parents before children — OffChainRestore.md §4), then verify');
  console.log('each post-import COUNT(*) EQUALS the row count printed here:\n');
  for (const [i, e] of born.entries()) console.log(`  ${i + 1}. ${cmd(e)}`);

  if (derived.length > 0) {
    console.log(`\nD1 (re-derivable): ${derived.length} batch(es) written but SKIP BY DEFAULT.`);
    console.log('The runbook restores these via §6 clear-and-replay from chain —');
    console.log('these batches are a STALE cross-query snapshot, archived only as a');
    console.log('restore-performance optimisation. Use them only where §6 explicitly');
    console.log('permits the fast path, never on a tampering recovery:\n');
    for (const [i, e] of derived.entries()) console.log(`  (${i + 1}.) ${cmd(e)}`);
  }
  if (legacy.length > 0) {
    console.log(`\nD1 (legacy lz-alerts): ${legacy.length} batch(es) — see §4's lz section:\n`);
    for (const [i, e] of legacy.entries()) console.log(`  ${i + 1}. ${cmd(e)}`);
  }
  const r2Bytes = r2.reduce((n, o) => n + o.size, 0);
  console.log(`\nR2: ${r2.length} object(s), ${r2Bytes} bytes, SHA-verified under ${path.join(outDir, 'r2')}/`);
  if (upload) {
    uploadR2(r2, { remote });
    console.log(`R2: ${r2.length} object(s) uploaded to ${R2_BUCKET}.`);
  } else if (r2.length > 0) {
    console.log('R2: re-run with --upload to push them via wrangler (argv-array, no shell).');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    if (e instanceof RestoreError) {
      console.error(`FATAL: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
