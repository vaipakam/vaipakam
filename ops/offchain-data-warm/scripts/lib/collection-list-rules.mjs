/**
 * #3688 — the backup watcher's check of the collection-offer list copies.
 *
 * The nightly copies each list file the indexer stored lately to
 * `collection-lists/<listHash>/<nonce>.json` and keeps no record of what it
 * copied (src/collectionLists.ts), so this is where a file that was never
 * copied is found: every list the indexer publishes
 * (`GET /collection-lists`) needs at least one uploaded copy under its hash
 * once the nightly has had time to run.
 *
 * Only presence is judged here. Whether a copy's bytes hash to its name is
 * judged at restore (`scripts/restore-collection-lists.mjs`), which takes any
 * copy that does and ignores the rest; a hash with no good copy is then
 * reported by name. The hashes are public (they are on-chain), so a problem
 * names them; a copy's object name, whose nonce keeps a leaked write key from
 * overwriting it, is never printed.
 */

/** The B2 prefix the nightly writes list copies under. */
export const COLLECTION_LIST_PREFIX = 'collection-lists/';

/** How long after a file is stored a missing copy is a problem: the nightly
 *  runs once a day and looks back 72 hours, so this allows one missed night. */
export const LIST_COPY_GRACE_MS = 48 * 3600 * 1000;

const COPY_NAME = /^collection-lists\/(0x[0-9a-f]{64})\/[0-9a-f]{32}\.json$/;

/** The hashes that hold at least one uploaded copy with a well-formed name. */
export function copiedHashes(versions) {
  const out = new Set();
  for (const v of versions) {
    if (v.action !== 'upload') continue;
    const m = COPY_NAME.exec(v.fileName ?? '');
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * The problems the copies show: each published list past the grace period
 * with no copy. `published` is the indexer's index, `[{ listHash, storedAt }]`
 * with `storedAt` in unix seconds.
 *
 * @returns {{ problems: Array<{keys: string[], text: string}>, notes: string[] }}
 */
export function judgeListCopies({ now, published, versions, graceMs = LIST_COPY_GRACE_MS }) {
  const copied = copiedHashes(versions);
  const missing = [];
  let waiting = 0;
  for (const p of published) {
    const hash = String(p.listHash).toLowerCase();
    if (copied.has(hash)) continue;
    if (now - Number(p.storedAt) * 1000 < graceMs) {
      waiting++;
      continue;
    }
    missing.push(hash);
  }
  const problems = missing.map((hash) => ({
    keys: [`collection-list-uncopied:${hash}`],
    text: `Collection-offer list ${hash} has no copy in the backup bucket; the nightly copies a file only within 72 hours of its storing, so re-copy it by hand (docs/ops/OffChainRestore.md, list files).`,
  }));
  const notes = [
    `Collection-offer lists: ${published.length} published, ${published.length - missing.length - waiting} copied, ${waiting} within the copy window, ${missing.length} missing.`,
  ];
  return { problems, notes };
}

/** Every entry of the indexer's list index, following its pages. */
export async function readListIndex(origin, { fetchImpl = fetch, pageCap = 1000 } = {}) {
  const base = origin.replace(/\/+$/, '');
  const out = [];
  let after = '';
  for (let page = 0; page < pageCap; page++) {
    const url = `${base}/collection-lists?limit=1000${after ? `&after=${after}` : ''}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`the indexer's list index answered ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.lists)) throw new Error("the indexer's list index is not in the expected shape");
    out.push(...body.lists);
    if (!body.nextAfter) return out;
    after = String(body.nextAfter);
  }
  throw new Error(`the indexer's list index did not finish within ${pageCap} pages`);
}
