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
const KNOWN_ARCHIVE_TABLES = new Set([
  // born-off-chain
  'diag_errors',
  'diag_legal_holds',
  'diag_legal_hold_audit',
  'user_thresholds',
  'notify_state',
  'pre_grace_notify_state', // archived since #1480; absent from older archives
  'telegram_links',
  'support_tickets',
  // re-derivable (archived as restore-performance optimisation)
  'offers',
  'loans',
  'activity_events',
  'oracle_snapshot_state',
  'indexer_cursor',
  'liquidity_confidence',
]);
const KNOWN_LZ_TABLES = new Set(['lz_alert_state', 'scan_cursor', 'oft_balance_history']);

// FK children of user_thresholds (ON DELETE CASCADE). Replacing the
// parent destroys live child rows, so an archive that carries the
// parent but not a child cannot be applied without silent child loss.
const CASCADE_CHILDREN = ['notify_state', 'pre_grace_notify_state'];

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
export function convertD1(archive, outDir, { lzDatabase = 'vaipakam-lz-alerts-db' } = {}) {
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
    const names = new Set(tables.map((t) => t?.name));
    for (const t of names) {
      if (!allowed.has(t)) {
        fail(
          `archive names table ${JSON.stringify(t)} which the backup never exports to this ` +
            `section — wrong or hostile archive; refusing to emit a destructive batch for it`,
        );
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
    }
    const dir = path.join(outDir, subdir);
    mkdirSync(dir, { recursive: true });
    for (const table of applyOrder(tables)) {
      const sql = tableToSql(table);
      const file = path.join(dir, `${table.name}.sql`);
      writeFileSync(file, sql);
      entries.push({ name: table.name, file, rowCount: table.rows.length, database });
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
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, bytes);
    written.push({ key: obj.key, local, size: bytes.length });
  }
  return written;
}

/** Upload each materialized object. argv ARRAY, never a shell string —
 *  no shell parsing means no escape rules to get wrong (§5 pitfall 2). */
export function uploadR2(written, { remote = true, spawn = spawnSync } = {}) {
  for (const { key, local } of written) {
    const args = ['r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', local];
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

  console.log(`\nD1: ${d1.length} table batch(es) written. Apply IN THIS ORDER`);
  console.log('(parents before children — OffChainRestore.md §4), then verify');
  console.log('each post-import COUNT(*) EQUALS the row count printed here:\n');
  for (const [i, e] of d1.entries()) {
    console.log(
      `  ${i + 1}. wrangler d1 execute ${shQuote(e.database)} --file=${shQuote(e.file)} --remote   # ${e.rowCount} rows`,
    );
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
