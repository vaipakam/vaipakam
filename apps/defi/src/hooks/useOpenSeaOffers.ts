/**
 * T-086 Round-5 Block C (#309 Mode B) — OpenSea Offers polling
 * hook for the pragmatic English-auction flow.
 *
 * Design § 15.3:
 *   1. Borrower posts a fixed-price listing at a deliberately-high
 *      reserve.
 *   2. Bidders place collection / item offers via OpenSea's
 *      native UI.
 *   3. THIS HOOK polls the agent's `/opensea/offers/...` proxy
 *      and surfaces incoming offers to the borrower with an
 *      "acceptable" classification.
 *   4. When the borrower clicks "Match", the dapp calls
 *      `updatePrepayListing` rotating the canonical Seaport order
 *      to the offer's price — handled in `useNFTPrepayListing`,
 *      not here. This hook is read-side only.
 *
 * **Acceptable threshold (§15.3 step 4):**
 *   `offer.value >= (lenderLeg + treasuryLeg) * (1 + bufferBps/10000) + sum(feeLegs.amount)`
 *
 *   - Block-C-on-fee-FREE (v1 ships here): `feeLegs == []`, so the
 *     threshold collapses to `(lenderLeg + treasuryLeg) * (1 + bufferBps/10000)`.
 *   - Fee-enforced collections will plug a `requiredFees` arg in a
 *     follow-up that re-fetches `/opensea/collection/{slug}` to
 *     re-derive `feeLegs` at the offer's gross at match time
 *     (per §15.3's "re-fetch on every match-offer click" rule).
 *
 * **Polling cadence**: every 30s while the consumer is mounted
 * (matches the agent's `OPENSEA_OFFERS_RATELIMIT` headroom of
 * 60 req/min/IP).
 *
 * **No write paths** — accepting an offer goes through
 * `useNFTPrepayListing.updatePrepayListing` so the canonical
 * order rotation stays in one hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Normalized offer surface the panel renders. The agent proxy
 *  returns the raw OpenSea JSON; the hook flattens to the
 *  borrower-relevant fields + classifies acceptability. */
export interface NormalizedOffer {
  /** Stable identity used as React key + sort tiebreaker. */
  orderHash: string;
  /** "item" = single-NFT offer, "collection" = floor offer for the
   *  whole collection. The borrower may want to surface both but
   *  rank by amount independently. */
  kind: 'item' | 'collection';
  /** Bidder address — used for the out-of-band notification copy
   *  ("notify your bidder before clicking Match"). */
  bidder: string;
  /** ERC20 the bidder is offering (typically the loan's principal
   *  asset; mismatches are flagged + filtered out by the panel). */
  paymentToken: string;
  /** Gross offer value in `paymentToken` smallest unit. */
  value: bigint;
  /** Linear decay end-time for the offer (Unix seconds). The
   *  borrower's match window is bounded by this. */
  endTime: number;
  /** Whether the offer meets the protocol-leg + buffer threshold.
   *  The panel greys out non-acceptable rows to prevent a
   *  guaranteed-to-revert `updatePrepayListing` click. */
  acceptable: boolean;
  /** Reason a non-acceptable offer was rejected — for the inline
   *  tooltip on the greyed row. */
  rejectReason?: 'below-threshold' | 'wrong-payment-token' | 'expired';
}

export interface UseOpenSeaOffersOptions {
  /** Stop polling. Useful when the loan card collapses or the
   *  parent navigates away. */
  paused?: boolean;
  /** Override the default 30 s poll interval — tests pin this to
   *  a smaller value so a single tick is observable in real time. */
  pollIntervalMs?: number;
}

export interface UseOpenSeaOffersResult {
  offers: NormalizedOffer[];
  /** True while the FIRST fetch is in flight (later refreshes
   *  silently update the array). Lets the UI render a spinner on
   *  initial mount without flashing on every refresh. */
  loadingInitial: boolean;
  /** Surfaces the last fetch error — diagnostic-only, the panel
   *  shows it under a collapsible Diagnostics row to keep the
   *  primary surface focused on offers when the fetch succeeded
   *  but returned an empty array. */
  error: string | null;
  /** Manual refresh trigger — bound to a "refresh now" affordance
   *  on the panel header. Codex round-3 P1 review #328: returns
   *  the refreshed offers array directly so the panel's
   *  pre-match revalidation can compare against the post-refresh
   *  shape WITHOUT racing the React render closure that
   *  `offersResult.offers` was captured in. Returns an empty
   *  array when the hook is paused (the refresh is a no-op in
   *  that state — same shape as `offers` would expose). */
  refresh: () => Promise<NormalizedOffer[]>;
}

/**
 * @param agentOrigin     Origin of the agent Worker (from
 *                        `VITE_AGENT_ORIGIN`). Pass `null` to
 *                        disable the hook (the loan card uses
 *                        this when the dapp is running against a
 *                        deploy without the agent configured).
 * @param chainId         Loan's chainId.
 * @param collateralAsset Loan's `loan.collateralAsset` (ERC721
 *                        contract).
 * @param collateralTokenId Loan's `loan.collateralTokenId`.
 * @param threshold       `(lenderLeg, treasuryLeg, bufferBps,
 *                        principalAsset)` — used to classify
 *                        offers. `paymentToken !== principalAsset`
 *                        marks the offer unacceptable upfront
 *                        ("wrong-payment-token").
 */
export function useOpenSeaOffers(
  agentOrigin: string | null,
  chainId: number,
  collateralAsset: string,
  collateralTokenId: bigint,
  threshold: {
    lenderLeg: bigint;
    treasuryLeg: bigint;
    bufferBps: number;
    principalAsset: string;
  },
  options: UseOpenSeaOffersOptions = {},
): UseOpenSeaOffersResult {
  const { paused = false, pollIntervalMs = 30_000 } = options;
  const [offers, setOffers] = useState<NormalizedOffer[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(0);

  const computeAcceptable = useCallback(
    (value: bigint, paymentToken: string, endTime: number): {
      acceptable: boolean;
      rejectReason?: NormalizedOffer['rejectReason'];
    } => {
      // Block-C-on-fee-free baseline: no fee legs. Threshold collapses
      // to the protocol-leg buffer.
      const min =
        ((threshold.lenderLeg + threshold.treasuryLeg) *
          BigInt(10_000 + threshold.bufferBps)) /
        10_000n;
      if (
        paymentToken.toLowerCase() !== threshold.principalAsset.toLowerCase()
      ) {
        return { acceptable: false, rejectReason: 'wrong-payment-token' };
      }
      if (endTime > 0 && endTime <= Math.floor(Date.now() / 1000)) {
        return { acceptable: false, rejectReason: 'expired' };
      }
      if (value < min) {
        return { acceptable: false, rejectReason: 'below-threshold' };
      }
      return { acceptable: true };
    },
    [threshold.lenderLeg, threshold.treasuryLeg, threshold.bufferBps, threshold.principalAsset],
  );

  const doFetch = useCallback(async (): Promise<NormalizedOffer[]> => {
    // Codex round-3 P2 review #328 — manual refreshes (via the
    // returned `refresh()`) must NOT bypass the `paused` gate.
    // Otherwise the panel's "Refresh now" button + the confirm-
    // time revalidation would run against a (potentially zero)
    // fallback threshold and classify offers as acceptable
    // against an unknown floor. Paused → return the empty list
    // without touching state.
    if (paused) return [];
    if (!agentOrigin) {
      setOffers([]);
      setLoadingInitial(false);
      setError(null);
      return [];
    }
    const myFetch = ++fetchRef.current;
    try {
      const url =
        `${agentOrigin}/opensea/offers/${chainId}/` +
        `${collateralAsset.toLowerCase()}/${collateralTokenId.toString()}`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        if (myFetch === fetchRef.current) {
          setError(`fetch failed: HTTP ${res.status}`);
          setLoadingInitial(false);
        }
        return [];
      }
      const body = (await res.json()) as {
        item_offers?: { status: number; body: unknown };
        collection_offers?: { status: number; body: unknown } | null;
      };

      // The OpenSea v2 response wraps offers in `{ offers: [...] }`
      // (current) or `{ orders: [...] }` (legacy). `extractOrders`
      // accepts both shapes. We tag each entry's kind and
      // concatenate; v1 only fetches collection offers (see
      // openseaOffersProxy.ts commentary).
      const itemRaw = extractOrders(body.item_offers);
      const collectionRaw = extractOrders(body.collection_offers ?? undefined);
      const normalized: NormalizedOffer[] = [
        ...itemRaw.map(o => normalize(o, 'item', computeAcceptable)),
        ...collectionRaw.map(o => normalize(o, 'collection', computeAcceptable)),
      ].filter((o): o is NormalizedOffer => o !== null);

      // Sort by acceptability, then descending value. The panel
      // renders in this order so the most actionable offer is at
      // the top.
      normalized.sort((a, b) => {
        if (a.acceptable !== b.acceptable) return a.acceptable ? -1 : 1;
        if (a.value > b.value) return -1;
        if (a.value < b.value) return 1;
        return a.orderHash < b.orderHash ? -1 : 1;
      });

      if (myFetch === fetchRef.current) {
        setOffers(normalized);
        setError(null);
        setLoadingInitial(false);
      }
      return normalized;
    } catch (err) {
      if (myFetch === fetchRef.current) {
        setError(err instanceof Error ? err.message : String(err));
        setLoadingInitial(false);
      }
      return [];
    }
  }, [
    agentOrigin,
    paused,
    chainId,
    collateralAsset,
    collateralTokenId,
    computeAcceptable,
  ]);

  useEffect(() => {
    if (paused) return;
    void doFetch();
    const id = setInterval(() => {
      void doFetch();
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [doFetch, paused, pollIntervalMs]);

  return { offers, loadingInitial, error, refresh: doFetch };
}

/** Pluck the offers array from an OpenSea v2 response — both the
 *  collection and item endpoints wrap the orders in `{ orders: ... }`
 *  when the response is 2xx. Other statuses (4xx / 5xx) carry an
 *  `errors` array or are echoed as a string; we treat both as "no
 *  offers" without surfacing the upstream error to the panel (the
 *  panel's `error` state is reserved for fetch-level failures). */
function extractOrders(
  source: { status: number; body: unknown } | undefined,
): unknown[] {
  if (!source) return [];
  if (source.status < 200 || source.status >= 300) return [];
  // Codex P1 review #328 — the **current** collection-offers
  // endpoint returns the list under `offers`, not `orders`. Legacy
  // item-offers responses (now deferred — see agent proxy) used
  // `orders`. Accept BOTH so a future re-enablement of the item
  // path doesn't need a second pass.
  const body = source.body as
    | { offers?: unknown[]; orders?: unknown[] }
    | unknown[]
    | unknown;
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as { offers?: unknown[]; orders?: unknown[] };
    if (Array.isArray(obj.offers)) return obj.offers;
    if (Array.isArray(obj.orders)) return obj.orders;
  }
  return [];
}

/** Map an OpenSea v2 order object to our normalized shape. Returns
 *  `null` when the order's shape doesn't match what we expect
 *  (defensive — OpenSea's schema evolves, and we'd rather drop one
 *  row than crash the panel). */
function normalize(
  raw: unknown,
  kind: 'item' | 'collection',
  computeAcceptable: (
    value: bigint,
    paymentToken: string,
    endTime: number,
  ) => { acceptable: boolean; rejectReason?: NormalizedOffer['rejectReason'] },
): NormalizedOffer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    order_hash?: string;
    maker?: { address?: string } | string;
    current_price?: string;
    protocol_data?: {
      parameters?: {
        offer?: Array<{ token?: string; startAmount?: string }>;
        endTime?: string;
        offerer?: string;
      };
    };
  };

  const orderHash = r.order_hash ?? '';
  if (!orderHash) return null;
  // Codex P1 review #328 — current OpenSea offer objects identify
  // the bidder via `protocol_data.parameters.offerer` (the Seaport
  // order's `offerer`); the top-level `maker` field is no longer
  // populated on every response shape. Fall back to the Seaport
  // parameters' `offerer` field so current-shape offers aren't
  // discarded as `null` here.
  const bidder =
    (typeof r.maker === 'string'
      ? r.maker
      : r.maker?.address ?? '') ||
    r.protocol_data?.parameters?.offerer ||
    '';
  if (!bidder) return null;

  // Payment-token / value extraction: the bidder's offer item is
  // `protocol_data.parameters.offer[0]` (single-leg per §15.3's
  // "OpenSea's make-offer UI only generates single-leg offers
  // paying the seller-of-record"). Fall back to `current_price`
  // when the wrapped order shape is incomplete.
  const offerItem = r.protocol_data?.parameters?.offer?.[0];
  const paymentToken = (offerItem?.token ?? '').toLowerCase();
  const value = BigInt(
    offerItem?.startAmount ?? r.current_price ?? '0',
  );
  const endTime = Number(r.protocol_data?.parameters?.endTime ?? '0');

  const verdict = computeAcceptable(value, paymentToken, endTime);
  return {
    orderHash,
    kind,
    bidder,
    paymentToken,
    value,
    endTime,
    acceptable: verdict.acceptable,
    rejectReason: verdict.rejectReason,
  };
}
