/**
 * #2386 — what the Rate Desk ladder knows about the gasless signed book.
 *
 * The desk merges signed offers into the chain/indexer ladder ADDITIVELY,
 * so a signed book that failed to load used to leave a chain-only ladder
 * that looked complete. This names the state so the ladder (and the
 * chart's middle-rate hint, which stands in for the ladder on mobile) can
 * say what it is missing:
 *
 *  - `loading`     — the signed book has not answered yet; the ladder
 *                    shows only on-chain offers for now.
 *  - `unavailable` — the offer-book service did not answer, answered for
 *                    another chain, or is not set up, OR its latest
 *                    refetch failed. Signed offers are left out entirely,
 *                    so the best rates and the middle rate may be missing
 *                    some. A failed refetch is unavailable rather than
 *                    "the last book we saw": a cached signed order may
 *                    have been taken or cancelled since.
 *  - `truncated`   — a side had more signed offers than the service
 *                    returns. It keeps the best-priced ones per side, so
 *                    the best rates and the middle rate are complete; only
 *                    deeper levels and running totals leave some out.
 *  - `complete`    — every active signed offer for the market is merged.
 */
export type SignedDepth = 'loading' | 'unavailable' | 'truncated' | 'complete';

export function signedDepthOf(q: {
  data: { truncated: boolean } | null | undefined;
  isError: boolean;
}): SignedDepth {
  if (q.isError || q.data === null) return 'unavailable';
  if (q.data === undefined) return 'loading';
  return q.data.truncated ? 'truncated' : 'complete';
}
