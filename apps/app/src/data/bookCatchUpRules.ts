/**
 * The Offer Book catch-up scan's RULES, with no dependencies (#2097).
 *
 * `bookCatchUp.ts` runs the scan; this module only states what it is
 * allowed to do, so the live RPC audit (`e2e/live/catchUpTally.mjs`) can
 * hold the deployed page to the same rules without loading the ABI barrel,
 * which plain Node cannot import. One definition: the scan reads these, and
 * so does the audit.
 */

/** Serialized 1000-block windows — public RPCs cap eth_getLogs
 *  ranges, and serial requests keep a refocused background tab from
 *  tripping per-second rate limits. */
export const CHUNK_BLOCKS = 1000n;

/** If the cache is further behind than this, skip the catch-up scan
 *  entirely (rendering pure cache state) rather than hammering the
 *  RPC with dozens of scans from the browser — MarketFreshnessNote
 *  already tells the user the lists are running behind in that
 *  state. */
export const MAX_CATCHUP_BLOCKS = 20_000n;

/** Every event that ends an offer's active life, by name. Each carries
 *  the offer id as its first INDEXED argument (topics[1]):
 *  OfferAccepted / OfferCanceled / OfferClosed (emitted on both cancel
 *  and range-match) / OfferConsumedBySale (loan-sale settlement; uint96
 *  id, same 32-byte topic encoding). Topic hashes are derived from the
 *  compiled ABI by whoever reads this, never hand-written. */
export const OFFER_TERMINAL_EVENTS = [
  'OfferAccepted',
  'OfferCanceled',
  'OfferClosed',
  'OfferConsumedBySale',
] as const;
