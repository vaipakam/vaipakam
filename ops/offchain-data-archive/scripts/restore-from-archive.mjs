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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
};

// The archived legal-hold tables whose rows carry `legal_doc_ref`
// (the R2 bucket key — `diagErasure.ts`: "the bucket key becomes the
// hold's legal_doc_ref").
const LEGAL_REF_TABLES = ['diag_legal_holds', 'diag_legal_hold_audit'];

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
  for (const [i, row] of rows.entries()) {
    const keys = Object.keys(row);
    // Strict shape check: a row keyed differently from the schema is
    // drift INSIDE one archive, which the export cannot produce.
    if (keys.length !== columns.length || keys.some((k) => !columns.includes(k))) {
      fail(`table ${name} row ${i}: row keys [${keys}] do not match schema columns [${columns}]`);
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
    const dir = path.join(outDir, subdir);
    mkdirSync(dir, { recursive: true });
    for (const table of applyOrder(tables)) {
      const sql = tableToSql(table);
      const file = path.join(dir, `${table.name}.sql`);
      writeFileSync(file, sql);
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
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, bytes);
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
      if (ref === null || ref === undefined) {
        // A HASH without a ref is never a writer-produced shape
        // (Codex #1484 r4). And null/null is table-SPECIFIC
        // (Codex #1484 r6): placing a hold REQUIRES the document
        // (`diagErasure.ts` rejects `place` without one), so a
        // current-hold row — or a `place` audit row — with neither
        // field recreates an erasure-blocking hold with no
        // authorizing evidence. Only non-`place` audit actions
        // (`lift`, `set-disclosure`) are legitimately doc-less.
        if (row.legal_doc_sha256 !== null && row.legal_doc_sha256 !== undefined) {
          invalid.push({ table: table.name, ref, problem: 'recorded sha present but ref is null' });
        } else if (table.name === 'diag_legal_holds') {
          invalid.push({
            table: table.name,
            ref,
            problem: 'current hold with no authorizing document (place requires one)',
          });
        } else if (table.name === 'diag_legal_hold_audit' && row.action === 'place') {
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
  const d1 = convertD1(archive, outDir, { lzDatabase });
  const r2 = materializeR2(archive, outDir);

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
