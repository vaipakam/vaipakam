/**
 * #2386 — what the Rate Desk knows about the gasless signed book.
 *
 * The desk merges signed offers into the chain/indexer ladder ADDITIVELY,
 * so a signed book that failed to load used to leave a chain-only ladder
 * that looked complete. This names the state so the page can say what it
 * is missing. One note at the top of the market (not one per widget)
 * carries it, because the best rates and the middle rate also appear in
 * the header and the chart, and on a phone either can be on screen
 * without the offers list.
 *
 *  - `loading`     — the signed book has not answered yet; only on-chain
 *                    offers are shown for now.
 *  - `unconfigured`— this deployment has no offer-book service set up, so
 *                    signed offers will not appear at all. A standing fact
 *                    about the deployment, disclosed as one rather than as
 *                    a temporary outage (#2398 r4).
 *  - `unavailable` — the offer-book service did not answer or answered for
 *                    another chain, OR its latest refetch failed. Signed offers are left out entirely.
 *                    A failed refetch is unavailable rather than "the last
 *                    book we saw": a cached signed order may have been
 *                    taken or cancelled since.
 *  - `partial`     — the service answered but some signed depth may be
 *                    missing: a side overflowed its cap (`truncated`), or
 *                    the service did not report whether it did (an older
 *                    deploy). Nothing positive is claimed about what WAS
 *                    included: the cap keeps the best-priced rows per side,
 *                    but more than the cap can share the best rate, and a
 *                    kept row can expire locally before the next poll while
 *                    the next-best one stays unfetched (#2386 r1, r4).
 *  - `complete`    — the service reported every active signed offer for
 *                    the market.
 */
export type SignedDepth =
  | 'loading'
  | 'unconfigured'
  | 'unavailable'
  | 'partial'
  | 'complete';

export function signedDepthOf(
  q: {
    data: { truncated: boolean | null } | null | undefined;
    isError: boolean;
  },
  /** Whether this deployment has an offer-book service origin at all. */
  serviceConfigured: boolean,
): SignedDepth {
  if (!serviceConfigured) return 'unconfigured';
  if (q.isError || q.data === null) return 'unavailable';
  if (q.data === undefined) return 'loading';
  return q.data.truncated === false ? 'complete' : 'partial';
}
