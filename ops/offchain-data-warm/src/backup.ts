/**
 * Nightly off-chain backup pipeline. Driven by the Worker's cron
 * trigger; the cron handler in `index.ts` calls
 * `runNightlyBackup(env)`.
 *
 * Output: one archive per tier due that night (daily always, monthly on
 * the 1st, yearly on 1 January), each encrypted to the committed recipient
 * public keys (`./archiveFormat`, `./recipients`) so the Worker cannot read
 * it back, and each with a manifest the backup watcher compares with the
 * archive's bytes (`scripts/backup-ledger.mjs`).
 *
 * Per the design doc §3.1, the archive carries the union of:
 *   - "Born-off-chain" D1 tables (MUST-back-up): diag_errors,
 *     diag_legal_holds, diag_legal_hold_audit.
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

import { PK_SCHEME, sealArchive, type ArchiveTier } from './archiveFormat';
import { sha256Hex } from './crypto';
import { recipientSetForRun } from './recipients';
import type { B2Config } from './b2';
import { putObject } from './b2';
import { MAX_ARCHIVE_BYTES } from './limits';
import { TIERS } from './tiers';
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
    encryption: typeof PK_SCHEME;
    /** The `set` number in backup-recipients/recipients.json. */
    recipientSet: number;
  };
  d1: {
    archive: { table: string; rowCount: number; schemaHash: string }[];
    // #1440 — the `lzAlerts` section was removed with the lz-watcher D1
    // binding. Manifests written before that date still carry it; a reader
    // must treat it as optional rather than required, which is why it is
    // dropped from the type rather than kept as an always-empty array.
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
  // Pre-grace warning dedupe (migration 0023, keeper-written). Same
  // born-off-chain class as notify_state — and it FK-cascades from
  // user_thresholds (ON DELETE CASCADE), so a replace-style restore
  // of the parent destroys it; without a backed-up copy it was
  // unrecoverable and users got duplicate pre-grace warnings after
  // every restore (#1480, found in #1450 r30).
  'pre_grace_notify_state',
  'telegram_links',
  // signed_offers is HYBRID (#1481): EIP-712 offers users POSTed to the
  // book, which exist nowhere on chain until filled, with a status the
  // indexer projects from chain events. Its migration (0033) is applied on
  // every database, so it is plain REQUIRED. The restore imports the user's
  // part and hands the projected part back to the block-zero replay
  // (`scripts/restore-from-archive.mjs`, RESTORE_PROJECTIONS).
  // (prepay_listing_match_breadcrumbs was the second hybrid table until
  // #2757 retired the app POST that wrote its off-chain rows; it is
  // replay-derived now and not archived.)
  'signed_offers',
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
// The migration prefix lets the export loop ask wrangler's
// `d1_migrations` bookkeeping whether the table is SUPPOSED to
// exist: "no such table" post-migration is a table loss and aborts.
const ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED: Array<{
  table: string;
  migrationPrefix: string;
}> = [
  { table: 'support_tickets', migrationPrefix: '0028' },
  //   (recycle_day_backfill, migration 0047, was archived here until #2937
  //   retired it: nothing ever wrote it, every chain is a fresh deploy with
  //   no pre-cutover recycling day to recover, and a later migration drops
  //   it — which this list must not outlive, or the nightly would read the
  //   dropped table as a post-migration table LOSS and abort. The restore
  //   converter still recognises it in older archives; see
  //   RETIRED_ARCHIVE_TABLES in scripts/restore-from-archive.mjs.)
  //   - loan_orphans (#2197, migration 0065) — `loans` rows the indexer
  //     proved the chain has no loan for, moved out of publication with the
  //     whole row kept. A block-zero replay cannot recreate one (its
  //     initiation is not in canonical history), so without the archive a
  //     D1 loss would erase the only record of what was withdrawn.
  { table: 'loan_orphans', migrationPrefix: '0065' },
];

// Re-derivable tables (backed up as restore-performance optimisation only).
const ARCHIVE_TABLES_OPTIONAL = [
  'offers',
  'loans',
  'activity_events',
  'oracle_snapshot_state',
  'indexer_cursor',
  'liquidity_confidence',
];

// #1440 — the lz-watcher D1 export was removed. `vaipakam-lz-watcher` was
// deleted on 2026-07-28 and its database holds only alert-dedup state and
// block cursors for a transport the T-068 CCIP migration retired, so there
// is nothing left worth preserving nightly. The `lzAlerts` manifest section
// is dropped with it; a restore reading an older manifest still finds the
// historical entries in that manifest, which is the correct behaviour —
// manifests describe the run that produced them.

// Hard memory ceiling. Cloudflare Workers' isolate cap is 128 MB; we
// guard at 100 MB to leave headroom for stack + transient buffers
// during encryption + upload. When a future month's growth pushes
// past this, the nightly aborts loudly via the manifest's
// `archiveBytes` and pages the operator — better than a silent
// resource-limit crash. A streaming implementation that removes this
// ceiling is tracked as a Stage A.1 follow-up; the design doc §6
// sequencing already lists it.
// The value lives in ./limits, shared with the backup watcher (#1473).

/** True when a migration whose name starts with `namePrefix` has
 *  been applied to this DB (wrangler records applied migrations in
 *  its `d1_migrations` bookkeeping table). Used to distinguish the
 *  legitimate pre-migration rollout state from a post-migration
 *  table LOSS: "no such table" is only tolerable in the former
 *  (Codex round-7 P2). A missing `d1_migrations` table itself means
 *  a fresh / pre-migration environment → false. */
async function migrationApplied(db: D1Database, namePrefix: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM d1_migrations WHERE name LIKE ?`)
      .bind(`${namePrefix}%`)
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

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

/**
 * One archive the run wrote, as the nightly report names it. Deliberately no
 * object name: the random nonce in the name is what keeps a leaked write key
 * from overwriting the archive, so it is never logged or posted (design §4).
 * The SHA-256 is enough to match the archive against the watcher's ledger.
 */
export interface WrittenArchive {
  tier: ArchiveTier;
  period: string;
  bytes: number;
  sha256: string;
}

export interface BackupRunOutput {
  archives: WrittenArchive[];
  /** The recipient set every archive of this run is encrypted to. */
  recipientSet: number;
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
    ...ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED.map((g) => g.table),
    ...ARCHIVE_TABLES_OPTIONAL,
  ]) {
    try {
      archiveTables.push(await exportTable(env.DB_ARCHIVE, t));
    } catch (err) {
      // Migration-gated tables tolerate exactly ONE failure shape:
      // "no such table" BEFORE their migration ran (checked against
      // wrangler's d1_migrations bookkeeping — a missing table on a
      // post-migration DB is a table LOSS, not a rollout state).
      // Any other export error (D1 fault, permission problem, query
      // regression) aborts like the plain required set — a
      // "successful" nightly silently missing the durable ticket
      // records is the failure mode this Worker exists to prevent
      // (Codex rounds 6+7 P2).
      const gated = ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED.find((g) => g.table === t);
      if (gated) {
        const tableMissing = /no such table/i.test((err as Error).message ?? '');
        if (
          !tableMissing ||
          (await migrationApplied(env.DB_ARCHIVE, gated.migrationPrefix))
        ) {
          throw new Error(
            `BACKUP ABORT: export of vaipakam-warm.${t} failed ` +
            `(${tableMissing ? 'table missing on a post-migration DB' : 'export error'}): ` +
            `${(err as Error).message}`,
          );
        }
      }
      // Tables that don't exist on this deploy shouldn't kill the run —
      // log + skip. Required tables that
      // truly missing are detected by the row-count check after
      // the loop.
      console.warn(`[backup] skipped vaipakam-warm.${t}: ${(err as Error).message}`);
    }
  }
  // Required-table guards — if a born-off-chain table truly isn't
  // there, that's the backup pipeline silently losing data, not a
  // schema migration that hasn't run yet. Page operator on either DB.
  const missingArchive = ARCHIVE_TABLES_REQUIRED.filter(
    (t) => !archiveTables.some((e) => e.name === t),
  );
  if (missingArchive.length > 0) {
    throw new Error(
      `BACKUP ABORT: required tables missing from vaipakam-warm: ${missingArchive.join(', ')}`,
    );
  }
  // Migration-gated tables missing → warn loudly but keep the run:
  // aborting here would drop the WHOLE nightly (diag/legal/alerts)
  // over a table that cannot hold data yet.
  for (const g of ARCHIVE_TABLES_REQUIRED_ONCE_MIGRATED) {
    if (!archiveTables.some((e) => e.name === g.table)) {
      console.warn(
        `[backup] migration-gated table ${g.table} missing — apply its migration; nightly continues without it`,
      );
    }
  }
  // 2. Export the R2 legal-vault.
  const r2Objects = await exportR2Bucket(env.R2_LEGAL_VAULT);

  // 3+4. Serialize, then seal once per tier. The recipient set is chosen
  //    once, at the start of the run, which is also the time every header
  //    and plaintext states as `createdAt`; the watcher judges the header
  //    against the set in force then.
  //    JSON is fine at this scale (≤ 10 GB year-1); if archive size
  //    becomes a bottleneck a future PR can swap to a streaming
  //    format (NDJSON line-delimited + Reader-aware encryption).
  const createdAt = new Date(startedAt).toISOString();
  const recipientSet = recipientSetForRun(startedAt);
  const serialize = (tables: TableExport[]): Uint8Array => {
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        createdAt,
        d1: { archive: tables },
        r2: { bucket: 'vaipakam-legal-vault', objects: r2Objects },
      }),
    );
    // Memory ceiling — checked BEFORE encryption, which holds the plaintext
    // and the ciphertext at once; a post-encryption check would be too late,
    // because the encrypt call itself would exhaust the isolate first. The
    // stored archive is the plaintext plus the format's bounded overhead
    // (MAX_STORED_ARCHIVE_BYTES in ./limits).
    if (plaintext.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `BACKUP ABORT: archive plaintext size ${plaintext.byteLength} bytes ` +
        `exceeds MAX_ARCHIVE_BYTES (${MAX_ARCHIVE_BYTES}). Cloudflare Workers' ` +
        `128 MB isolate cap means encryption would exhaust the Worker. Time to ship ` +
        `the streaming implementation (Stage A.1 follow-up).`,
      );
    }
    return plaintext;
  };

  // One archive: sealed to the recipients, digested, and given its manifest.
  // The manifest is small and unencrypted: metadata only (row counts, schema
  // hashes, the archive's SHA-256), no plaintext data. The backup watcher
  // compares it with the bytes it downloads.
  const seal = async (tables: TableExport[], plaintext: Uint8Array, tier: ArchiveTier, period: string) => {
    const archive = await sealArchive({ set: recipientSet, plaintext, tier, period, createdAt });
    const archiveSha = await sha256Hex(archive);
    const manifest: Manifest = {
      version: 1,
      createdAt,
      schemaVersion: 2,
      archive: {
        sha256: archiveSha,
        byteLength: archive.byteLength,
        encryption: PK_SCHEME,
        recipientSet: recipientSet.set,
      },
      d1: {
        archive: await Promise.all(
          tables.map(async (t) => ({
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
    return { archive, archiveSha, manifest };
  };

  // 5. Upload — archive first, then manifest. A failure between the two
  //    leaves an archive without a manifest, which the backup watcher waits
  //    for (MANIFEST_GRACE_MS) and then records as such. The opposite order
  //    would leave a manifest naming an archive that never landed.
  //
  // Tiered prefixes match the lifecycle rules in `bucket-lifecycle.json`:
  //   archives/<date>/<nonce>.bin          — daily.
  //   archives-monthly/<month>/<nonce>.bin — 1st of the month.
  //   archives-yearly/<year>/<nonce>.bin   — 1 January, no rule (indefinite).
  //
  // Every archive gets its OWN random 16-byte nonce (32 hex chars), shared
  // only with its manifest. The write key cannot list the bucket, and the
  // nonce is now written nowhere the Worker or Cloudflare keeps (it is not
  // logged and not in the ops message), so overwriting an archive in place
  // means guessing a 128-bit value; a write to a new name is caught by the
  // watcher as an ambiguous period (design §4).
  const dateKey = createdAt.slice(0, 10); // YYYY-MM-DD
  const monthKey = createdAt.slice(0, 7); // YYYY-MM
  const yearKey = createdAt.slice(0, 4); // YYYY
  const isFirstOfMonth = dateKey.endsWith('-01');
  const isFirstOfYear = dateKey.endsWith('-01-01');
  const written: WrittenArchive[] = [];
  const upload = async (tier: ArchiveTier, period: string, sealed: Awaited<ReturnType<typeof seal>>) => {
    const nonce = newNonce();
    // The prefixes are the tier table's, the one the watcher reads too.
    const spec = TIERS.find((t) => t.tier === tier)!;
    await putObject(b2Cfg, `${spec.archivePrefix}${period}/${nonce}.bin`, sealed.archive, 'application/octet-stream');
    await putObject(
      b2Cfg,
      `${spec.manifestPrefix}${period}/${nonce}.json`,
      new TextEncoder().encode(JSON.stringify(sealed.manifest, null, 2)),
      'application/json',
    );
    written.push({ tier, period, bytes: sealed.archive.byteLength, sha256: sealed.archiveSha });
  };

  // DAILY tier — the FULL table set, including support_tickets. Built,
  // uploaded, then RELEASED before any long-tier build: holding two
  // ciphertexts (plus the second build's plaintext) at once could push a
  // well-under-the-guard archive past the 128 MB isolate cap on exactly the
  // runs that build twice (Codex round-5 P2).
  {
    const plaintext = serialize(archiveTables);
    await upload('daily', dateKey, await seal(archiveTables, plaintext, 'daily', dateKey));
  }

  // LONG tiers (monthly and yearly) — ONE plaintext that EXCLUDES
  // `support_tickets`. The Privacy Policy promises tickets are deleted no
  // later than 12 months after submission; a ticket caught by a monthly cut
  // could outlive that (Codex round-5 P1) and an indefinite yearly copy would
  // keep it forever. With the exclusion, a ticket's backup copies live ONLY
  // in the daily tier.
  //
  // The plaintext is shared; the encryption is not. Each tier is sealed on
  // its own, with its own data key, IV, header and nonce, so the January
  // monthly and the yearly are unrelated ciphertexts and the watcher's
  // replay check needs no exception for them (design §5.3). They are sealed
  // and uploaded one after the other, so at most one ciphertext is held
  // beside the plaintext.
  if (isFirstOfMonth || isFirstOfYear) {
    const longTables = archiveTables.filter((t) => t.name !== 'support_tickets');
    const plaintext = serialize(longTables);
    if (isFirstOfMonth) await upload('monthly', monthKey, await seal(longTables, plaintext, 'monthly', monthKey));
    if (isFirstOfYear) await upload('yearly', yearKey, await seal(longTables, plaintext, 'yearly', yearKey));
  }

  const rowsBackedUp = archiveTables.reduce((a, t) => a + t.rowCount, 0);
  return {
    archives: written,
    recipientSet: recipientSet.set,
    rowsBackedUp,
    r2ObjectsBackedUp: r2Objects.length,
    durationMs: Date.now() - startedAt,
  };
}

/** A fresh 16-byte nonce as 32 hex characters. */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
