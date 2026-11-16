/**
 * #3688 — the nightly copy of published NFT collection-offer lists to B2.
 *
 * A listed collection offer names its token ids on-chain only by a root and a
 * list hash, so a list posted to the indexer as a file (more than the 256 ids
 * an event carries) exists nowhere else: the indexer keeps it in the
 * `vaipakam-collection-lists` R2 bucket under `lists/<listHash>`. The
 * archive cannot carry these files (one may be 8 MB, and the archive is held
 * whole under MAX_ARCHIVE_BYTES), so they are copied beside it instead.
 *
 * The copy keeps the Worker write-only (BackupSecurityDesign.md §4; design
 * thread decision 2026-11-16, option 1):
 *
 *   - It keeps NO record of what it copied. It reads which files the indexer
 *     stored in the last MIRROR_WINDOW_HOURS (`collection_offer_set.
 *     list_stored_at`) and copies each, so two missed nights lose nothing and
 *     a file is copied at most a few times.
 *   - Every copy gets its own random nonce: `collection-lists/<hash>/<nonce>.json`.
 *     A leaked write key cannot overwrite a copy, only add one, and a restore
 *     takes, per hash, any copy whose bytes hash to the name and ignores the
 *     rest (`scripts/restore-collection-lists.mjs`).
 *   - The files are stored as they are, NOT encrypted: they are public by
 *     design (served by hash so anyone can recompute an offer's root) and
 *     carry no personal data.
 *
 * The backup watcher (`scripts/backup-ledger.mjs`) checks that every list
 * the indexer publishes has a copy, and pages when one is missing; that is
 * the report of a file not yet copied.
 */

import type { B2Config } from './b2';
import { putObject } from './b2';

/** How far back a nightly looks for newly stored files. */
export const MIRROR_WINDOW_HOURS = 72;

/** The B2 prefix list copies live under. */
export const COLLECTION_LIST_PREFIX = 'collection-lists/';

const HASH_RE = /^0x[0-9a-f]{64}$/;

export interface ListMirrorOutcome {
  /** Files copied this run. */
  copied: number;
  /** Total bytes copied. */
  bytes: number;
  /** Hashes the indexer recorded that the store did not hold (never named
   *  in a report as anything but a count: they are public, but a count is
   *  what the operator acts on). */
  missingFromStore: number;
  /** Why the step did not run, when it did not. */
  skipped: string | null;
}

/**
 * Copy every list file stored in the window to B2. Never throws for a
 * missing table or binding (it reports why it skipped); a failed PUT throws,
 * after the archives are already written, so the run reports it as a failure.
 */
export async function mirrorCollectionLists(
  db: D1Database,
  store: R2Bucket | undefined,
  b2Cfg: B2Config,
  nowMs: number,
  newNonce: () => string,
): Promise<ListMirrorOutcome> {
  const out: ListMirrorOutcome = { copied: 0, bytes: 0, missingFromStore: 0, skipped: null };
  if (!store) return { ...out, skipped: 'no COLLECTION_LISTS binding' };
  const since = Math.floor(nowMs / 1000) - MIRROR_WINDOW_HOURS * 3600;
  let hashes: string[];
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT list_hash FROM collection_offer_set
          WHERE list_stored_at IS NOT NULL AND list_stored_at >= ?
          ORDER BY list_hash`,
      )
      .bind(since)
      .all<{ list_hash: string }>();
    hashes = (rows.results ?? []).map((r) => String(r.list_hash).toLowerCase()).filter((h) => HASH_RE.test(h));
  } catch (err) {
    // Before migration 0097 there is nothing to copy.
    if (/no such table|no such column/i.test((err as Error).message ?? '')) {
      return { ...out, skipped: 'collection_offer_set not migrated yet' };
    }
    throw err;
  }
  for (const hash of hashes) {
    const got = await store.get(`lists/${hash}`);
    if (!got) {
      out.missingFromStore++;
      continue;
    }
    const body = new Uint8Array(await got.arrayBuffer());
    // Labelled by count, not by name: the nonce in the key is what keeps a
    // leaked write key from overwriting this copy (see `putObject`).
    await putObject(b2Cfg, `${COLLECTION_LIST_PREFIX}${hash}/${newNonce()}.json`, body, 'application/json', {
      label: `collection list copy ${out.copied + 1} of ${hashes.length}`,
    });
    out.copied++;
    out.bytes += body.byteLength;
  }
  return out;
}
