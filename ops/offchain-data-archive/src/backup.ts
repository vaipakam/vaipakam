/**
 * Nightly off-chain backup pipeline. Driven by the Worker's cron
 * trigger; the cron handler in `index.ts` calls
 * `runNightlyBackup(env)`.
 *
 * Output: one client-side-encrypted archive uploaded to Backblaze B2
 * per night, plus a manifest object that the weekly healthcheck reads
 * to verify the archive's SHA-256 still matches.
 *
 * Per the design doc §3.1, the archive carries the union of:
 *   - "Born-off-chain" D1 tables (MUST-back-up): diag_errors,
 *     diag_legal_holds, diag_legal_hold_audit, lz_alerts, lz_cursor.
 *   - "Re-derivable" D1 tables (kept as a performance optimisation —
 *     restore can drop these in favour of a fresh re-index): offers,
 *     loans, activity, oracle_snapshot_state, liquidity_confidence_*,
 *     current_holder.
 *   - Every object in the R2 legal-vault bucket.
 *
 * Schema-validation note: the export captures table schemas via
 * `PRAGMA table_info(<table>)` so a future restore that hits a schema
 * mismatch (e.g. a column was dropped in a migration after the
 * archive was created) can detect the drift cleanly instead of
 * silently re-importing into the wrong shape.
 */

import { encrypt, sha256Hex } from './crypto';
import type { B2Config } from './b2';
import { putObject } from './b2';
import type { Env } from './env';

interface TableExport {
  name: string;
  schema: Array<{ cid: number; name: string; type: string; notnull: number; pk: number }>;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

interface R2Object {
  key: string;
  size: number;
  sha256: string;
  base64Body: string;
}

interface Manifest {
  version: 1;
  createdAt: string; // ISO timestamp
  schemaVersion: number; // bump when this manifest shape changes
  archive: {
    sha256: string;
    byteLength: number;
    encryption: 'AES-256-GCM';
  };
  d1: {
    archive: { table: string; rowCount: number; schemaHash: string }[];
    lzAlerts: { table: string; rowCount: number; schemaHash: string }[];
  };
  r2: {
    bucket: string;
    objectCount: number;
    totalBytes: number;
  };
}

// Born-off-chain tables (MUST back up). Names verified against
// `apps/indexer/migrations/*.sql` — code-review feedback caught the
// previous list silently naming `activity` and `liquidity_confidence_*`
// that don't exist in the real schema; the strict required-set guard
// below would abort a backup whose REQUIRED list drifts but the
// optional list could still silently skip mis-named tables. Both
// lists are now grounded against the live schema.
const ARCHIVE_TABLES_REQUIRED = [
  // Diagnostic + legal audit — irrecoverable without backup.
  'diag_errors',
  'diag_legal_holds',
  'diag_legal_hold_audit',
  // User-supplied / user-derived state (HF alert thresholds,
  // notification dedupe state, Telegram chat links). Born off chain,
  // losing them = user-visible breakage on restore.
  'user_thresholds',
  'notify_state',
  'telegram_links',
];

// Rollout-aware required set: REQUIRED once its migration has been
// applied, but a Worker deploy ordered BEFORE the migration must not
// abort the whole nightly — no rows can exist in a table that isn't
// there yet, so nothing is being lost (Codex round-5 P2). Missing →
// loud warn + the daily ops message's open-ticket count reads
// "n/a (table missing)", so the gap is operator-visible either way.
//   - support_tickets (#1040 phase 1, migration 0028) — the DURABLE
//     record of user support requests (message, optional reply
//     email, consented diagnostics). Once the migration lands, a D1
//     loss without backup would silently drop every ticket.
const ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED = ['support_tickets'];

// Re-derivable tables (backed up as restore-performance optimisation only).
const ARCHIVE_TABLES_OPTIONAL = [
  'offers',
  'loans',
  'activity_events',
  'oracle_snapshot_state',
  'indexer_cursor',
  'liquidity_confidence',
];

// lz-watcher's separate D1. Real schema (per
// `ops/lz-watcher/migrations/0001_init.sql`): `lz_alert_state` carries
// the dispatch history, `scan_cursor` the per-chain block cursor,
// `oft_balance_history` the mint/burn imbalance time-series. All three
// are REQUIRED — silently skipping any of them dropped the alert-
// history dataset entirely in the previous shape.
const LZ_ALERTS_TABLES_REQUIRED = [
  'lz_alert_state',
  'scan_cursor',
  'oft_balance_history',
];

// Hard memory ceiling. Cloudflare Workers' isolate cap is 128 MB; we
// guard at 100 MB to leave headroom for stack + transient buffers
// during encryption + upload. When a future month's growth pushes
// past this, the nightly aborts loudly via the manifest's
// `archiveBytes` and pages the operator — better than a silent
// resource-limit crash. A streaming implementation that removes this
// ceiling is tracked as a Stage A.1 follow-up; the design doc §6
// sequencing already lists it.
const MAX_ARCHIVE_BYTES = 100_000_000;

async function exportTable(db: D1Database, table: string): Promise<TableExport> {
  // PRAGMA table_info returns one row per column — captures the schema
  // so a restore can detect drift before importing into the wrong shape.
  const schemaRes = await db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ cid: number; name: string; type: string; notnull: number; pk: number }>();
  const rowsRes = await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
  return {
    name: table,
    schema: schemaRes.results ?? [],
    rowCount: rowsRes.results?.length ?? 0,
    rows: rowsRes.results ?? [],
  };
}

async function exportR2Bucket(bucket: R2Bucket): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const list = await bucket.list({ cursor, limit: 1000 });
    for (const obj of list.objects) {
      const got = await bucket.get(obj.key);
      if (!got) continue;
      const buf = await got.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Base64-encode for JSON embedding. R2 legal-vault holds
      // operator-uploaded documents (PDFs, scans) — sizes are
      // bounded by the legal-hold UI's per-file limit.
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      out.push({
        key: obj.key,
        size: bytes.length,
        sha256: await sha256Hex(bytes),
        base64Body: btoa(s),
      });
    }
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  return out;
}

/** Compute a stable schema hash so a restore that sees a schema drift
 *  can fail loud and call out which table changed. Lex-sort column
 *  defs by `cid` before hashing — D1's `PRAGMA table_info` already
 *  returns in `cid` order but explicit sort guards against any future
 *  D1 behaviour change. */
async function schemaHash(
  schema: Array<{ cid: number; name: string; type: string; notnull: number; pk: number }>,
): Promise<string> {
  const normalised = [...schema]
    .sort((a, b) => a.cid - b.cid)
    .map((c) => `${c.cid}:${c.name}:${c.type}:${c.notnull}:${c.pk}`)
    .join('|');
  return sha256Hex(new TextEncoder().encode(normalised));
}

export interface BackupRunOutput {
  manifestKey: string;
  archiveKey: string;
  archiveBytes: number;
  archiveSha256: string;
  rowsBackedUp: number;
  r2ObjectsBackedUp: number;
  durationMs: number;
}

export async function runNightlyBackup(env: Env, b2Cfg: B2Config): Promise<BackupRunOutput> {
  const startedAt = Date.now();

  // 1. Export the two D1s.
  const archiveTables: TableExport[] = [];
  for (const t of [
    ...ARCHIVE_TABLES_REQUIRED,
    ...ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED,
    ...ARCHIVE_TABLES_OPTIONAL,
  ]) {
    try {
      archiveTables.push(await exportTable(env.DB_ARCHIVE, t));
    } catch (err) {
      // Migration-gated tables tolerate exactly ONE failure shape:
      // "no such table" before their migration ran. Any other export
      // error on them (D1 fault, permission problem, query
      // regression) must abort like the plain required set — a
      // "successful" nightly silently missing the durable ticket
      // records is the failure mode this Worker exists to prevent
      // (Codex round-6 P2).
      if (
        ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED.includes(t) &&
        !/no such table/i.test((err as Error).message ?? '')
      ) {
        throw new Error(
          `BACKUP ABORT: export of vaipakam-archive.${t} failed post-migration: ${(err as Error).message}`,
        );
      }
      // Tables that don't exist on this deploy (e.g. lz_alerts on
      // a fresh archive DB before lz-watcher ran any migration)
      // shouldn't kill the run — log + skip. Required tables that
      // truly missing are detected by the row-count check after
      // the loop.
      console.warn(`[backup] skipped vaipakam-archive.${t}: ${(err as Error).message}`);
    }
  }
  const lzAlertsTables: TableExport[] = [];
  for (const t of LZ_ALERTS_TABLES_REQUIRED) {
    // lz-watcher tables are ALL required (alert-history dispatch +
    // mint/burn balance series + the per-chain scan cursor). The
    // previous shape only warned + skipped on missing tables — that
    // meant a renamed table silently dropped the dataset from
    // archives forever. Now any export failure here is a hard abort.
    lzAlertsTables.push(await exportTable(env.DB_LZ_ALERTS, t));
  }

  // Required-table guards — if a born-off-chain table truly isn't
  // there, that's the backup pipeline silently losing data, not a
  // schema migration that hasn't run yet. Page operator on either DB.
  const missingArchive = ARCHIVE_TABLES_REQUIRED.filter(
    (t) => !archiveTables.some((e) => e.name === t),
  );
  if (missingArchive.length > 0) {
    throw new Error(
      `BACKUP ABORT: required tables missing from vaipakam-archive: ${missingArchive.join(', ')}`,
    );
  }
  // Migration-gated tables missing → warn loudly but keep the run:
  // aborting here would drop the WHOLE nightly (diag/legal/alerts)
  // over a table that cannot hold data yet.
  for (const t of ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED) {
    if (!archiveTables.some((e) => e.name === t)) {
      console.warn(
        `[backup] migration-gated table ${t} missing — apply its migration; nightly continues without it`,
      );
    }
  }
  const missingLz = LZ_ALERTS_TABLES_REQUIRED.filter(
    (t) => !lzAlertsTables.some((e) => e.name === t),
  );
  if (missingLz.length > 0) {
    throw new Error(
      `BACKUP ABORT: required tables missing from vaipakam-lz-alerts-db: ${missingLz.join(', ')}`,
    );
  }

  // 2. Export the R2 legal-vault.
  const r2Objects = await exportR2Bucket(env.R2_LEGAL_VAULT);

  // 3+4. Build the canonical archive blob + its manifest. Extracted
  //    as a local helper because the Jan-1 run needs a SECOND build
  //    with a different table set (see the yearly-tier note below).
  //    JSON is fine at this scale (≤ 10 GB year-1); if archive size
  //    becomes a bottleneck a future PR can swap to a streaming
  //    format (NDJSON line-delimited + Reader-aware encryption).
  const createdAt = new Date().toISOString();
  const buildPayload = async (tables: TableExport[]) => {
    const archiveObj = {
      version: 1,
      createdAt,
      d1: { archive: tables, lzAlerts: lzAlertsTables },
      r2: { bucket: 'vaipakam-legal-vault', objects: r2Objects },
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(archiveObj));

    // Memory ceiling — checked BEFORE encrypt because encryption
    // doubles peak memory (plaintext + ciphertext both resident at
    // ~equal size; AES-GCM ciphertext is plaintext + 28 bytes IV+tag).
    // A post-encryption check is too late — the encrypt() call itself
    // would OOM the isolate first. Comparing plaintext bytes against
    // the encrypted budget MAX_ARCHIVE_BYTES is conservative by ~28
    // bytes (plaintext < ciphertext) — safe direction. The 128 MB
    // isolate cap is the hard ceiling; 100 MB target leaves headroom
    // for stack + transient buffers.
    if (plaintext.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `BACKUP ABORT: archive plaintext size ${plaintext.byteLength} bytes ` +
        `exceeds MAX_ARCHIVE_BYTES (${MAX_ARCHIVE_BYTES}). Cloudflare Workers' ` +
        `128 MB isolate cap means encrypt() would OOM the Worker. Time to ship ` +
        `the streaming implementation (Stage A.1 follow-up).`,
      );
    }

    // `TextEncoder().encode(...).buffer` is `ArrayBufferLike` in TS's
    // strict typings (it could be a SharedArrayBuffer in theory).
    // WebCrypto wants a plain ArrayBuffer; slice(0) returns one
    // explicitly without an extra copy beyond the bytes we already own.
    const encrypted = await encrypt(
      env.encryptionKey,
      plaintext.buffer.slice(0) as ArrayBuffer,
    );
    const archiveSha = await sha256Hex(encrypted);

    // Manifest — small, unencrypted (the healthcheck reads it
    // without the key). Carries only metadata: row counts, schema
    // hashes, archive SHA-256. No plaintext data.
    const manifest: Manifest = {
      version: 1,
      createdAt,
      schemaVersion: 1,
      archive: {
        sha256: archiveSha,
        byteLength: encrypted.byteLength,
        encryption: 'AES-256-GCM',
      },
      d1: {
        archive: await Promise.all(
          tables.map(async (t) => ({
            table: t.name,
            rowCount: t.rowCount,
            schemaHash: await schemaHash(t.schema),
          })),
        ),
        lzAlerts: await Promise.all(
          lzAlertsTables.map(async (t) => ({
            table: t.name,
            rowCount: t.rowCount,
            schemaHash: await schemaHash(t.schema),
          })),
        ),
      },
      r2: {
        bucket: 'vaipakam-legal-vault',
        objectCount: r2Objects.length,
        totalBytes: r2Objects.reduce((acc, o) => acc + o.size, 0),
      },
    };
    return { encrypted, archiveSha, manifest };
  };

  // 5. Upload — archive first, then manifest. Reverse-order failure
  //    means a missing manifest with an existing archive (harmless;
  //    a later GC sweep cleans the orphan via the lifecycle rule).
  //    The opposite order would leave a manifest pointing at an
  //    archive that didn't land, which the healthcheck would then
  //    false-positive on.
  //
  // Tiered prefixes match the lifecycle rules set by
  // `scripts/setup-backblaze.mjs`:
  //   archives/<date>/<nonce>.bin         — daily, 30-day retention.
  //   archives-monthly/<month>/<nonce>.bin — 1st-of-month, 365-day.
  //   archives-yearly/<year>/<nonce>.bin   — Jan-1, no rule (indefinite).
  //
  // Object keys carry a random 16-byte nonce (32 hex chars) so the
  // SAME date/month/year written twice produces two DIFFERENT keys.
  // This blocks a write-only-key attacker from overwriting an
  // existing archive: their PUT lands at a new key, the original
  // file survives, and the healthcheck's manifest-vs-archive
  // verification catches the divergence. Without the nonce, a
  // single PUT to `archives/2026-05-23.bin` with garbage bytes
  // would silently replace the previous night's data — write-only
  // alone doesn't defend against in-place overwrite.
  //
  // The same nonce is shared by an archive and its manifest so the
  // healthcheck can pair them deterministically (`archives/<d>/<n>.bin`
  // ↔ `manifests/<d>/<n>.json`).
  const dateKey = createdAt.slice(0, 10); // YYYY-MM-DD
  const monthKey = createdAt.slice(0, 7); // YYYY-MM
  const yearKey = createdAt.slice(0, 4);  // YYYY
  const isFirstOfMonth = dateKey.endsWith('-01');
  const isFirstOfYear = dateKey.endsWith('-01-01');

  // 16-byte cryptographic nonce → 32 hex chars. crypto.getRandomValues
  // is the same source WebCrypto's encrypt() draws from internally,
  // so we don't add any new entropy assumption.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  let nonceHex = '';
  for (let i = 0; i < nonceBytes.length; i++) {
    nonceHex += nonceBytes[i].toString(16).padStart(2, '0');
  }

  // DAILY tier (30-day retention) — the FULL table set, including
  // support_tickets. Built, uploaded, then RELEASED before any
  // long-tier build: holding two ciphertexts (plus the second
  // build's plaintext) at once could push a well-under-the-guard
  // archive past the 128 MB isolate cap on exactly the runs that
  // build twice (Codex round-5 P2).
  const archiveKey = `archives/${dateKey}/${nonceHex}.bin`;
  const manifestKey = `manifests/${dateKey}/${nonceHex}.json`;
  let daily: Awaited<ReturnType<typeof buildPayload>> | null =
    await buildPayload(archiveTables);
  const archiveSha256 = daily.archiveSha;
  const archiveBytes = daily.encrypted.byteLength;
  await putObject(b2Cfg, archiveKey, daily.encrypted, 'application/octet-stream');
  await putObject(
    b2Cfg,
    manifestKey,
    new TextEncoder().encode(JSON.stringify(daily.manifest, null, 2)),
    'application/json',
  );
  daily = null; // release the first ciphertext before any second build

  // LONG tiers (monthly: 365-day lifecycle; yearly: NO rule,
  // indefinite) — built as ONE separate payload that EXCLUDES
  // `support_tickets`. The Privacy Policy promises tickets are
  // deleted no later than 12 months after submission; a ticket
  // caught by a monthly cut can outlive that by ~a month (Codex
  // round-5 P1) and an indefinite yearly copy would keep it forever.
  // With the exclusion, a ticket's backup copies live ONLY in the
  // 30-day daily tier — at most 30 days past its D1 deletion.
  // Everything else in the long tiers (legal-hold audit trail etc.)
  // is exactly the data they exist for.
  if (isFirstOfMonth || isFirstOfYear) {
    let longTier: Awaited<ReturnType<typeof buildPayload>> | null =
      await buildPayload(
        archiveTables.filter((t) => t.name !== 'support_tickets'),
      );
    const longManifestBody = new TextEncoder().encode(
      JSON.stringify(longTier.manifest, null, 2),
    );
    if (isFirstOfMonth) {
      await putObject(
        b2Cfg,
        `archives-monthly/${monthKey}/${nonceHex}.bin`,
        longTier.encrypted,
        'application/octet-stream',
      );
      await putObject(
        b2Cfg,
        `manifests-monthly/${monthKey}/${nonceHex}.json`,
        longManifestBody,
        'application/json',
      );
    }
    if (isFirstOfYear) {
      await putObject(
        b2Cfg,
        `archives-yearly/${yearKey}/${nonceHex}.bin`,
        longTier.encrypted,
        'application/octet-stream',
      );
      await putObject(
        b2Cfg,
        `manifests-yearly/${yearKey}/${nonceHex}.json`,
        longManifestBody,
        'application/json',
      );
    }
    longTier = null;
  }

  // The healthcheck looks up the most recent manifest under
  // `manifests/<recent-date>/` via list-with-prefix (the read-scoped
  // key can do that) and dereferences to its sibling archive. The
  // BackupRunOutput surfaces the daily key — monthly / yearly
  // siblings are reflected in the Telegram alert.
  const rowsBackedUp =
    archiveTables.reduce((a, t) => a + t.rowCount, 0) +
    lzAlertsTables.reduce((a, t) => a + t.rowCount, 0);
  return {
    manifestKey,
    archiveKey,
    archiveBytes,
    archiveSha256,
    rowsBackedUp,
    r2ObjectsBackedUp: r2Objects.length,
    durationMs: Date.now() - startedAt,
  };
}
