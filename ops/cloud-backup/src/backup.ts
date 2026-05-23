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

// Born-off-chain tables (MUST back up).
const ARCHIVE_TABLES_REQUIRED = [
  'diag_errors',
  'diag_legal_holds',
  'diag_legal_hold_audit',
];

// Re-derivable tables (backed up as restore-performance optimisation only).
const ARCHIVE_TABLES_OPTIONAL = [
  'offers',
  'loans',
  'activity',
  'oracle_snapshot_state',
  'liquidity_confidence_observations',
  'liquidity_confidence_state',
  'current_holder',
  'indexer_cursor',
];

const LZ_ALERTS_TABLES = ['lz_alerts', 'lz_cursor'];

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
  for (const t of [...ARCHIVE_TABLES_REQUIRED, ...ARCHIVE_TABLES_OPTIONAL]) {
    try {
      archiveTables.push(await exportTable(env.DB_ARCHIVE, t));
    } catch (err) {
      // Tables that don't exist on this deploy (e.g. lz_alerts on
      // a fresh archive DB before lz-watcher ran any migration)
      // shouldn't kill the run — log + skip. Required tables that
      // truly missing are detected by the row-count check after
      // the loop.
      console.warn(`[backup] skipped vaipakam-archive.${t}: ${(err as Error).message}`);
    }
  }
  const lzAlertsTables: TableExport[] = [];
  for (const t of LZ_ALERTS_TABLES) {
    try {
      lzAlertsTables.push(await exportTable(env.DB_LZ_ALERTS, t));
    } catch (err) {
      console.warn(`[backup] skipped lz-alerts.${t}: ${(err as Error).message}`);
    }
  }

  // Required-table guard — if a born-off-chain table truly isn't
  // there, that's the backup pipeline silently losing data, not a
  // schema migration that hasn't run yet. Page operator.
  const missingRequired = ARCHIVE_TABLES_REQUIRED.filter(
    (t) => !archiveTables.some((e) => e.name === t),
  );
  if (missingRequired.length > 0) {
    throw new Error(
      `BACKUP ABORT: required tables missing from vaipakam-archive: ${missingRequired.join(', ')}`,
    );
  }

  // 2. Export the R2 legal-vault.
  const r2Objects = await exportR2Bucket(env.R2_LEGAL_VAULT);

  // 3. Build the canonical archive object — JSON, then encrypt the
  //    whole thing as a single AES-256-GCM blob. JSON is fine at
  //    this scale (≤ 10 GB year-1); if archive size becomes a
  //    bottleneck a future PR can swap to a streaming format
  //    (NDJSON line-delimited + Reader-aware encryption).
  const archive = {
    version: 1,
    createdAt: new Date().toISOString(),
    d1: { archive: archiveTables, lzAlerts: lzAlertsTables },
    r2: { bucket: 'vaipakam-legal-vault', objects: r2Objects },
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(archive));
  // `TextEncoder().encode(...).buffer` is `ArrayBufferLike` in TS's
  // strict typings (it could be a SharedArrayBuffer in theory).
  // WebCrypto wants a plain ArrayBuffer; slice(0) returns one
  // explicitly without an extra copy beyond the bytes we already own.
  const encrypted = await encrypt(
    env.encryptionKey,
    plaintext.buffer.slice(0) as ArrayBuffer,
  );
  const archiveSha = await sha256Hex(encrypted);

  // 4. Manifest — small, unencrypted (the healthcheck reads it
  //    without the key). Carries only metadata: row counts, schema
  //    hashes, archive SHA-256. No plaintext data.
  const manifest: Manifest = {
    version: 1,
    createdAt: archive.createdAt,
    schemaVersion: 1,
    archive: {
      sha256: archiveSha,
      byteLength: encrypted.byteLength,
      encryption: 'AES-256-GCM',
    },
    d1: {
      archive: await Promise.all(
        archiveTables.map(async (t) => ({
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

  // 5. Upload — archive first, then manifest. Reverse-order failure
  //    means a missing manifest with an existing archive (harmless;
  //    the next run overwrites the orphan). The opposite order would
  //    leave a manifest pointing at an archive that didn't land,
  //    which the healthcheck would then false-positive on.
  //
  // Tiered prefixes match the lifecycle rules set by
  // `scripts/setup-backblaze.mjs`:
  //   archives/         — daily, 30-day retention.
  //   archives-monthly/ — 1st-of-month, 365-day retention.
  //   archives-yearly/  — Jan-1, no rule (indefinite).
  // The nightly archive ALWAYS lands in `archives/`; on the 1st of
  // the month we ALSO write a copy to `archives-monthly/` (and to
  // `archives-yearly/` on Jan 1). Same encrypted bytes, three
  // different lifecycle buckets — B2 dedupes on hash so the storage
  // cost overhead for the duplicate writes is ~zero.
  const dateKey = archive.createdAt.slice(0, 10); // YYYY-MM-DD
  const monthKey = archive.createdAt.slice(0, 7); // YYYY-MM
  const yearKey = archive.createdAt.slice(0, 4);  // YYYY
  const isFirstOfMonth = dateKey.endsWith('-01');
  const isFirstOfYear = dateKey.endsWith('-01-01');

  const writes: Array<{ archive: string; manifest: string }> = [
    { archive: `archives/${dateKey}.bin`, manifest: `manifests/${dateKey}.json` },
  ];
  if (isFirstOfMonth) {
    writes.push({
      archive: `archives-monthly/${monthKey}.bin`,
      manifest: `manifests-monthly/${monthKey}.json`,
    });
  }
  if (isFirstOfYear) {
    writes.push({
      archive: `archives-yearly/${yearKey}.bin`,
      manifest: `manifests-yearly/${yearKey}.json`,
    });
  }

  const manifestBody = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  for (const w of writes) {
    await putObject(b2Cfg, w.archive, encrypted, 'application/octet-stream');
    await putObject(b2Cfg, w.manifest, manifestBody, 'application/json');
  }

  // The healthcheck only knows about the daily prefix (archives/),
  // so the BackupRunOutput surfaces the daily key — the monthly /
  // yearly siblings are recorded in the Telegram alert (alert text
  // built by index.ts off the durationMs / rowsBackedUp summary).
  const archiveKey = writes[0].archive;
  const manifestKey = writes[0].manifest;

  const rowsBackedUp =
    archiveTables.reduce((a, t) => a + t.rowCount, 0) +
    lzAlertsTables.reduce((a, t) => a + t.rowCount, 0);
  return {
    manifestKey,
    archiveKey,
    archiveBytes: encrypted.byteLength,
    archiveSha256: archiveSha,
    rowsBackedUp,
    r2ObjectsBackedUp: r2Objects.length,
    durationMs: Date.now() - startedAt,
  };
}
