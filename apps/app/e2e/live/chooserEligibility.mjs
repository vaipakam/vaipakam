/**
 * The borrower chooser's render rule and the grace bucket walk, as this
 * drive applies them (#1557).
 *
 * The drive is plain Node and does not load the app's TypeScript at run
 * time, so it carries these two rules as a MIRROR, and
 * `chooserEligibility.test.mjs` checks the mirror against the app's own
 * definitions (`src/data/earlyRepayChooser.ts`, `src/lib/grace.ts`) over
 * every combination of facts and a fixed set of bucket shapes. A clause
 * the page gains and this file lacks fails CI instead of silently
 * narrowing what a live run visits. That is the pattern
 * `refinancePosture.mjs` and `forcedCloseCard.mjs` already follow.
 *
 * Before this file, the drive wrote both inline. The copy drifted twice
 * inside one review (#1529): first two clauses were missing, then the
 * grace walk read an empty bucket set as zero grace and the drive skipped
 * every loan on a chain that publishes none.
 *
 * What parity cannot cover is how each FACT is read; the drive's negative
 * control (visiting a loan this rule excludes and confirming the chooser
 * is absent) is what checks those against the page.
 *
 * Imports nothing.
 */

/**
 * The first clause that hides the chooser, or `null` when it renders.
 * Same facts, same order, same reasons as `earlyRepayChooserExclusion`.
 *
 * @param {{ viewerIsBorrower: boolean, active: boolean, rental: boolean,
 *   offsetPending: boolean, graceVerifiablyOver: boolean,
 *   closedThisSession: boolean }} f
 * @returns {'not-borrower'|'not-active'|'closed-this-session'|'rental'|
 *   'offset-pending'|'grace-over'|null}
 */
export function chooserExclusion(f) {
  if (!f.viewerIsBorrower) return 'not-borrower';
  if (!f.active) return 'not-active';
  if (f.closedThisSession) return 'closed-this-session';
  if (f.rental) return 'rental';
  if (f.offsetPending) return 'offset-pending';
  if (f.graceVerifiablyOver) return 'grace-over';
  return null;
}

/** The reason in the words the drive prints beside a skipped loan. */
export const EXCLUSION_WORDS = Object.freeze({
  'not-borrower': 'borrower token burned',
  'not-active': 'not active',
  'closed-this-session': 'closed this session',
  rental: 'NFT rental',
  'offset-pending': 'offset in progress',
  'grace-over': 'past grace',
});

/** `lib/grace.defaultGraceSeconds`: the contract's zero-bucket schedule. */
export function defaultGraceSeconds(durationDays) {
  const d = BigInt(durationDays);
  if (d < 7n) return 3_600n;
  if (d < 30n) return 86_400n;
  if (d < 90n) return 3n * 86_400n;
  if (d < 180n) return 7n * 86_400n;
  if (d < 365n) return 14n * 86_400n;
  return 30n * 86_400n;
}

/**
 * `lib/grace.graceSecondsFromBuckets`: the first bucket whose threshold
 * strictly exceeds the duration, a `maxDurationDays == 0` catch-all, the
 * LAST entry for a malformed set, and the default schedule for an EMPTY
 * set (the live path on Base Sepolia, which publishes none).
 *
 * @param {ReadonlyArray<{maxDurationDays: bigint, graceSeconds: bigint}>} buckets
 * @param {bigint | number} durationDays
 */
export function graceSecondsFromBuckets(buckets, durationDays) {
  const days = BigInt(durationDays);
  if (buckets.length > 0) {
    for (const b of buckets) {
      if (b.maxDurationDays === 0n) return b.graceSeconds;
      if (days < b.maxDurationDays) return b.graceSeconds;
    }
    return buckets[buckets.length - 1].graceSeconds;
  }
  return defaultGraceSeconds(days);
}

/**
 * The reasons this drive DERIVES from chain reads of its own (the offset
 * lock and the grace deadline), as opposed to reading them straight off
 * the loan (status, asset type, holder). They are where #1529's drift
 * happened, so an empty pool made up of them is suspicious rather than
 * merely empty.
 */
const DERIVED = new Set(['offset-pending', 'grace-over']);

/**
 * The loans set aside ONLY by a derived reason (#1557, direction 2).
 *
 * When no loan is eligible, the drive cannot tell "the chain has nothing
 * to look at" from "the drive's reading of a gate has drifted": both
 * leave the pool empty. It can say which loans an Active, held, ERC-20
 * status would otherwise have admitted, so the BLOCKED line names them
 * instead of reading as an empty chain.
 *
 * @template L
 * @param {L[]} loans
 * @param {(l: L) => Parameters<typeof chooserExclusion>[0]} factsOf
 * @returns {L[]}
 */
export function setAsideByDerivedGate(loans, factsOf) {
  return loans.filter((l) => DERIVED.has(chooserExclusion(factsOf(l))));
}
