/**
 * RPC read-diet PR C (Alpha02RpcReadDietDesign §4.2.3) — the
 * per-candidate claim-verdict memo.
 *
 * The Claims verification fan-out (`ownerOf` + `getClaimable` +
 * `getBorrowerLifRebate` per candidate) is the app's single most
 * expensive recurring read surface. PR A already keys the query on the
 * candidate-set CONTENT fingerprint, but the fingerprint is
 * set-granular: ONE changed candidate re-probes EVERY candidate. This
 * module memoizes the per-candidate verdict keyed on the same identity
 * fields as the fingerprint, so a re-run only spends probes on
 * candidates whose identity actually changed.
 *
 * Correctness boundary (design §2.3): the memo may only skip a
 * RE-probe of an identical candidate — it must never suppress the
 * first probe (fresh page load starts empty; the cache is in-memory
 * only, never persisted), and chain-decided actionability is
 * untouched (a cached verdict IS a chain probe's result). Ownership
 * can flip WITHOUT any identity field changing (secondary-market NFT
 * transfer, a claim-burn from another device), so the epoch bump
 * below clears the whole memo whenever an `ownership.changed` push
 * frame or an own-receipt invalidation arrives — the exact signals
 * that carry those flips.
 *
 * Standalone module on purpose: `chain/IndexerPushSync` and
 * `chain/receiptSync` import the bump, `data/claimables` imports the
 * cache — no import cycle through the data/chain layers.
 */

/** Values are `ClaimableLoan | null` (claimable row / confirmed
 *  not-claimable) — typed as unknown here so this module stays
 *  import-free; the single consumer casts. */
const cache = new Map<string, unknown>();

/** Hard cap so a pathological candidate churn (griefed wallet, long
 *  session across many chains) can't grow the memo unboundedly. The
 *  whole map resets — the next run re-probes once, which is the
 *  pre-memo behaviour. */
const MAX_ENTRIES = 2000;

export function claimVerdictGet(key: string): {
  hit: boolean;
  value: unknown;
} {
  return cache.has(key)
    ? { hit: true, value: cache.get(key) }
    : { hit: false, value: undefined };
}

export function claimVerdictPut(key: string, value: unknown): void {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, value);
}

/** Clear every memoized verdict. Called on `ownership.changed` push
 *  frames and on receipt invalidations (own claim/transfer just
 *  mined) — after either, any cached ownerOf-derived verdict may be
 *  wrong even though the candidate's identity fields are unchanged. */
export function bumpClaimVerdictEpoch(): void {
  cache.clear();
}

/** Test-only visibility. */
export function _claimVerdictSizeForTests(): number {
  return cache.size;
}
