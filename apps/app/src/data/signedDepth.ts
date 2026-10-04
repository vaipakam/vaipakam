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
 *  - `unavailable` — the offer-book service did not answer, answered for
 *                    another chain, or is not set up, OR its latest
 *                    refetch failed. Signed offers are left out entirely.
 *                    A failed refetch is unavailable rather than "the last
 *                    book we saw": a cached signed order may have been
 *                    taken or cancelled since.
 *  - `partial`     — the service answered but some signed depth may be
 *                    missing: a side overflowed its cap (`truncated`), or
 *                    the service did not report whether it did (an older
 *                    deploy). The cap keeps the best-priced rows per side,
 *                    but more than the cap can share the best rate, so even
 *                    the best level's amount can be short — no level is
 *                    claimed complete (#2386 r1).
 *  - `complete`    — the service reported every active signed offer for
 *                    the market.
 */
export type SignedDepth = 'loading' | 'unavailable' | 'partial' | 'complete';

export function signedDepthOf(q: {
  data: { truncated: boolean | null } | null | undefined;
  isError: boolean;
}): SignedDepth {
  if (q.isError || q.data === null) return 'unavailable';
  if (q.data === undefined) return 'loading';
  return q.data.truncated === false ? 'complete' : 'partial';
}
