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
 * transfer, a claim-burn from another device), so four guards bound
 * reuse to windows where the ownership signals are trustworthy:
 *
 *  - the EPOCH bump clears the memo on `ownership.changed` push
 *    frames, receipt invalidations, and rail-health drops — and
 *    `claimVerdictPut` discards any result captured before the bump
 *    (an in-flight verification racing the bump must not re-seed the
 *    map with pre-bump ownerOf state; Codex #1232 r1);
 *  - the consumer only READS the memo while the push rail is healthy
 *    (rail down ⇒ `ownership.changed` frames aren't arriving, so
 *    every fallback refetch probes live — the pre-memo posture;
 *    Codex #1232 r1);
 *  - entries expire after a TTL, bounding staleness even if a frame
 *    is lost on a rail that still looks healthy;
 *  - a hard size cap resets the whole map (bounded memory; the next
 *    run re-probes once).
 *
 * Standalone module on purpose: `chain/IndexerPushSync` and
 * `chain/receiptSync` import the bump, `data/claimables` imports the
 * cache — no import cycle through the data/chain layers.
 */

/** Values are `ClaimableLoan | null` (claimable row / confirmed
 *  not-claimable) — typed as unknown here so this module stays
 *  import-free; the single consumer casts. */
const cache = new Map<string, { value: unknown; at: number }>();

let epoch = 0;

/** Hard cap so a pathological candidate churn (griefed wallet, long
 *  session across many chains) can't grow the memo unboundedly. */
const MAX_ENTRIES = 2000;

/** Staleness backstop: a verdict older than this re-probes even when
 *  every ownership signal stayed quiet. 15 min keeps the steady-state
 *  saving (the 180s net re-checks reuse ~5 times) while bounding the
 *  damage of a silently lost frame to minutes, not a session. */
const TTL_MS = 15 * 60_000;

/** Capture BEFORE starting a verification pass; hand the same value to
 *  every `claimVerdictPut` of that pass. */
export function claimVerdictEpoch(): number {
  return epoch;
}

export function claimVerdictGet(key: string): {
  hit: boolean;
  value: unknown;
} {
  const entry = cache.get(key);
  if (!entry) return { hit: false, value: undefined };
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    return { hit: false, value: undefined };
  }
  return { hit: true, value: entry.value };
}

/** Store a CLEAN verdict — unless a bump happened since `atEpoch` was
 *  captured, in which case the result predates an ownership signal
 *  and is silently discarded (the next run re-probes). */
export function claimVerdictPut(
  key: string,
  value: unknown,
  atEpoch: number,
): void {
  if (atEpoch !== epoch) return;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { value, at: Date.now() });
}

/** Clear every memoized verdict and invalidate in-flight writes.
 *  Called on `ownership.changed` push frames, receipt invalidations,
 *  and rail-health drops — after any of these, a cached (or
 *  in-flight) ownerOf-derived verdict may be wrong even though the
 *  candidate's identity fields are unchanged. */
export function bumpClaimVerdictEpoch(): void {
  epoch++;
  cache.clear();
}

/** Test-only visibility. */
export function _claimVerdictSizeForTests(): number {
  return cache.size;
}
