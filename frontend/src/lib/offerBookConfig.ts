/**
 * OfferBook UI tuning knobs.
 *
 * Single source of truth for the page-size cap the 2-filter
 * OfferBook hydrates per "Load more" click. Defaults to 200 hydrated
 * offers per fetch — balances first-paint speed (~109 KB hydrated
 * payload) against the user not having to click "Load more" too
 * often.
 *
 * RPC quota note: 200 vs 500 is NOT a quota concern. Both fetches
 * are exactly one multicall (request-priced by every public RPC
 * provider we use). The reason to default low is bandwidth + JS
 * render time on slow connections / mobile devices, not provider
 * spend. Operators on chains with consistently large pair buckets
 * can dial this up via the env var below without a code change.
 *
 * Bounds: clamped to [50, 1000]. Below 50 is too few rows for the
 * sort UI to feel useful; above 1000 starts straining browser memory
 * on devices with multiple OfferBook tabs open.
 */

const DEFAULT_OFFER_BOOK_PAGE_SIZE = 200;
const MIN_OFFER_BOOK_PAGE_SIZE = 50;
const MAX_OFFER_BOOK_PAGE_SIZE = 1000;

function readPageSize(): number {
  const raw = import.meta.env.VITE_OFFER_BOOK_PAGE_SIZE;
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULT_OFFER_BOOK_PAGE_SIZE;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_OFFER_BOOK_PAGE_SIZE;
  }
  return Math.min(
    MAX_OFFER_BOOK_PAGE_SIZE,
    Math.max(MIN_OFFER_BOOK_PAGE_SIZE, parsed),
  );
}

/**
 * How many full Offer structs the OfferBook hydrates per fetch.
 *
 * Single fetch on first page-load returns this many rows; each
 * "Load more" click re-fetches the same count on top.
 *
 * The skinny ranking call (one round trip for the entire pair
 * bucket) is independent of this knob — sort-across-all stays free.
 */
export const OFFER_BOOK_PAGE_SIZE = readPageSize();
