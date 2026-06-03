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
 *   Block-C-on-fee-enforced (#331, this commit) reformulates that
 *   constraint in closed form so the threshold compare doesn't need
 *   to reconstruct on-chain feeLeg amounts: with
 *   `feeAmount[i] = offer.value × feeBps[i] / 10000`, the
 *   borrower-remainder-non-negative + protocol-leg-buffer
 *   constraint becomes
 *
 *     `offer.value × (10000 - feeBpsTotal) ≥ (lenderLeg + treasuryLeg) × (10000 + bufferBps)`
 *
 *   i.e. `offer.value ≥ ceil((lenderLeg + treasuryLeg) × (10000 + bufferBps) / (10000 - feeBpsTotal))`.
 *
 *   - Block-C-on-fee-FREE: `feeBpsTotal == 0`, threshold collapses
 *     to `ceil((lenderLeg + treasuryLeg) × (10000 + bufferBps) / 10000)`
 *     which is the v1 baseline (modulo 1-wei rounding from ceil-
 *     instead-of-floor, irrelevant to UX).
 *   - Block-C-on-fee-enforced: `feeBpsTotal` carries the sum of
 *     required-fee basis points from the parsed OpenSea collection
 *     schedule. The Match flow then re-fetches the schedule at
 *     confirm time and threads the recomputed `FeeLeg[]` through
 *     `updatePrepayListing` (per §15.3's "re-fetch on every match-
 *     offer click" rule).
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

/** Codex round-14 P2 review #328 — chainId → OpenSea chain slug
 *  map. Mirrors the agent proxy's
 *  `apps/agent/src/openseaOffersProxy.ts:OPENSEA_CHAIN_SLUG` so
 *  the hook can drop offer rows whose `chain` field doesn't
 *  match the current loan's chain. Unmapped chains return
 *  `null` from the lookup; the normalizer then skips the
 *  chain-mismatch filter (can't enforce something we don't have
 *  a reference for). */
const OPENSEA_CHAIN_SLUG: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  137: 'matic',
};

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
  /** The OpenSea collection slug the agent resolved for this NFT
   *  (or `null` when resolution failed). Surfaced to the
   *  consumer so the section can run a one-time
   *  `/opensea/collection/{slug}` fee-enforcement gate at mount
   *  time without re-resolving the slug — Codex round-5 P2
   *  review #328. */
  slug: string | null;
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
    /** #331 — sum of required-fee basis points from the parsed
     *  OpenSea collection schedule for this slug. `0` on fee-free
     *  collections (Block C v1 baseline). `>0` on fee-enforced
     *  collections; the threshold check scales accordingly so the
     *  panel only greenlights offers whose gross-minus-fees still
     *  covers `(lenderLeg + treasuryLeg) × (1 + bufferBps/10000)`.
     *  Caller-provided so the hook doesn't re-fetch the schedule
     *  itself (the section already polls it for the Match-side
     *  recompute). */
    feeBpsTotal: number;
    /** #339 round-2 — smallest required-fee basis points. Drives
     *  the per-leg-rounding floor:
     *  `floor(askPrice × bps / 10000) ≥ 1` requires
     *  `askPrice ≥ ceil(10000 / bps)`. Without this, an offer
     *  above the closed-form threshold but below the rounding
     *  floor would classify as acceptable, light up the Match
     *  button, and abort at confirm time because `computeFeeLegs`
     *  would produce a zero-amount leg (diamond reverts
     *  `FeeLegInvalidAmount`). Baking the floor into the
     *  classification keeps the gate closed in the first place.
     *  `0` on fee-free collections (no rounding constraint). */
    minRequiredFeeBps: number;
  },
  options: UseOpenSeaOffersOptions = {},
): UseOpenSeaOffersResult {
  const { paused = false, pollIntervalMs = 30_000 } = options;
  const [offers, setOffers] = useState<NormalizedOffer[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(0);

  const computeAcceptable = useCallback(
    (value: bigint, paymentToken: string, endTime: number): {
      acceptable: boolean;
      rejectReason?: NormalizedOffer['rejectReason'];
    } => {
      // #331 — closed-form acceptable threshold. Derivation in the
      // hook's header docstring. Returns `ceil(num / den)` so the
      // threshold rounds toward the conservative direction (rejects
      // borderline-unacceptable instead of admitting them).
      //
      // Degenerate guard: `feeBpsTotal >= 10000` means required
      // fees consume the entire askPrice, leaving nothing for the
      // protocol legs. Treat every offer as below-threshold; the
      // panel renders an unmatchable state, the borrower notices,
      // the operator investigates the collection's fee config.
      if (threshold.feeBpsTotal >= 10_000) {
        return { acceptable: false, rejectReason: 'below-threshold' };
      }
      const num =
        (threshold.lenderLeg + threshold.treasuryLeg) *
        BigInt(10_000 + threshold.bufferBps);
      const den = BigInt(10_000 - threshold.feeBpsTotal);
      const minByThreshold = den === 0n ? 0n : (num + den - 1n) / den;
      // #339 round-2 — per-leg-rounding floor. For a required-fee
      // row with `bps`, the on-chain amount is
      // `floor(askPrice × bps / 10000)`. For that to be ≥ 1 the
      // askPrice must be ≥ ceil(10000 / bps). The smallest `bps`
      // among required rows sets the binding constraint; offers
      // below this floor would produce a zero-amount leg, which the
      // diamond rejects. Fee-free schedules pass `minRequiredFeeBps =
      // 0` and skip this branch entirely.
      const minByRounding =
        threshold.minRequiredFeeBps > 0
          ? (10_000n + BigInt(threshold.minRequiredFeeBps) - 1n) /
            BigInt(threshold.minRequiredFeeBps)
          : 0n;
      const min =
        minByThreshold > minByRounding ? minByThreshold : minByRounding;
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
    [
      threshold.lenderLeg,
      threshold.treasuryLeg,
      threshold.bufferBps,
      threshold.principalAsset,
      threshold.feeBpsTotal,
      threshold.minRequiredFeeBps,
    ],
  );

  const doFetch = useCallback(async (): Promise<NormalizedOffer[]> => {
    // Codex round-3 P2 review #328 — manual refreshes (via the
    // returned `refresh()`) must NOT bypass the `paused` gate.
    // Otherwise the panel's "Refresh now" button + the confirm-
    // time revalidation would run against a (potentially zero)
    // fallback threshold and classify offers as acceptable
    // against an unknown floor. Paused → return the empty list
    // without touching state — EXCEPT clear `loadingInitial` and
    // any stale offers so the panel renders the disabled state
    // instead of the "Loading offers…" spinner. Codex round-4 P2
    // review #328.
    if (paused) {
      // Codex round-6 P2 review #328 — bump the fetch generation
      // BEFORE clearing state. Any in-flight request from before
      // the pause flip will observe `myFetch !== fetchRef.current`
      // in its resolution branch and skip its state writes, so a
      // stale response can't repopulate `offers` / `slug` after
      // the reset. Without this, the per-minute floor-refresh
      // race (or the listing-becomes-unmatchable race) could
      // re-enable Match rows against a stale threshold.
      fetchRef.current++;
      setOffers([]);
      setSlug(null);
      setLoadingInitial(false);
      setError(null);
      return [];
    }
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
        item_offers?: { status: number; body: unknown } | null;
        collection_offers?: { status: number; body: unknown } | null;
        slug?: string | null;
      };
      if (myFetch === fetchRef.current) {
        setSlug(body.slug ?? null);
      }

      // The OpenSea v2 response wraps offers in `{ offers: [...] }`
      // (current) or `{ orders: [...] }` (legacy). `extractOrders`
      // accepts both shapes. We tag each entry's kind and
      // concatenate; v1 only fetches collection offers (see
      // openseaOffersProxy.ts commentary).
      const itemRaw = extractOrders(body.item_offers ?? undefined);
      const collectionRaw = extractOrders(body.collection_offers ?? undefined);
      // Codex round-14 P2 review #328 — expected OpenSea chain
      // string for this loan. Mirrors the agent proxy's map at
      // `apps/agent/src/openseaOffersProxy.ts:OPENSEA_CHAIN_SLUG`.
      // Null = unmapped chain; `normalize` then skips the
      // chain-mismatch filter (can't enforce something we don't
      // have a reference for).
      const expectedChain = OPENSEA_CHAIN_SLUG[chainId] ?? null;
      const normalized: NormalizedOffer[] = [
        ...itemRaw.map(o => normalize(o, 'item', collateralAsset, collateralTokenId, expectedChain, computeAcceptable)),
        ...collectionRaw.map(o => normalize(o, 'collection', collateralAsset, collateralTokenId, expectedChain, computeAcceptable)),
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
    // Codex round-5 P2 review #328 — ALWAYS invoke `doFetch` so
    // the paused branch (which clears `offers` / `loadingInitial`
    // / `error`) runs even when `paused` flips true after the
    // previous render had unpaused offers. Without this, the
    // effect's `if (paused) return` skipped `doFetch` entirely
    // and the panel could keep showing stale acceptable offers
    // OR sit on the initial "Loading offers…" spinner. The
    // setInterval polling is still gated on `!paused` — the
    // single mount-time `doFetch` call is enough to reset state.
    void doFetch();
    if (paused) return;
    const id = setInterval(() => {
      void doFetch();
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [doFetch, paused, pollIntervalMs]);

  return { offers, slug, loadingInitial, error, refresh: doFetch };
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
  collateralAsset: string,
  collateralTokenId: bigint,
  expectedChain: string | null,
  computeAcceptable: (
    value: bigint,
    paymentToken: string,
    endTime: number,
  ) => { acceptable: boolean; rejectReason?: NormalizedOffer['rejectReason'] },
): NormalizedOffer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    order_hash?: string;
    chain?: string;
    maker?: { address?: string } | string;
    current_price?: string;
    price?: { current?: { value?: string } };
    protocol_data?: {
      parameters?: {
        offer?: Array<{ token?: string; startAmount?: string; endAmount?: string }>;
        consideration?: Array<{
          itemType?: number;
          token?: string;
          identifierOrCriteria?: string;
        }>;
        endTime?: string;
        offerer?: string;
      };
    };
  };

  const orderHash = r.order_hash ?? '';
  if (!orderHash) return null;

  // Codex round-14 P2 review #328 — drop offers whose
  // `chain` field doesn't match the loan's chain. For slugs
  // that span multiple chains (rare but happens with bridged
  // collections), an offer placed on chain X would otherwise
  // pass through to a borrower viewing the loan on chain Y;
  // Match would rotate the listing to a price that no chain-Y
  // bidder can fulfill against the chain-Y NFT. Skip the check
  // when `expectedChain` is null (e.g. unmapped chainId) — we
  // can't enforce something we don't have a reference for.
  if (expectedChain !== null && r.chain && r.chain !== expectedChain) {
    return null;
  }

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
  // paying the seller-of-record").
  //
  // Codex round-14 P2 review #328 — for time-varying Seaport
  // offers (start != end), `startAmount` is yesterday's value.
  // OpenSea exposes the live value at `price.current.value` —
  // use that when present, fall back to `startAmount` /
  // `current_price` for fixed/legacy shapes.
  const offerItem = r.protocol_data?.parameters?.offer?.[0];
  const paymentToken = (offerItem?.token ?? '').toLowerCase();
  const liveValueString =
    r.price?.current?.value ?? offerItem?.startAmount ?? r.current_price ?? '0';
  const value = BigInt(liveValueString);
  const endTime = Number(r.protocol_data?.parameters?.endTime ?? '0');

  // Codex rounds 13 + 14 + 15 + 16 P2 review #328 — the
  // `/collection/{slug}/all` endpoint can return offers that
  // don't apply to this specific NFT. Round-16's tightening:
  // OpenSea's criteria-offer surface (`post_criteria_offer_v2`
  // docs) can carry hidden trait criteria validated SERVER-SIDE
  // by OpenSea — even `identifier === '0'` on a criteria-type
  // item is NOT a guaranteed collection-wide offer.
  // v1 doesn't do trait / merkle-proof validation, so we accept
  // ONLY:
  //   - `token` matches `collateralAsset` AND
  //   - itemType 2 (ERC721) or 3 (ERC1155) (concrete) AND
  //   - identifier equals `collateralTokenId`
  // Collection-wide / criteria-type offers stay visible on
  // OpenSea's marketplace for the borrower to fulfill there;
  // they just don't pass the dapp's Match surface (fail-closed).
  const consideration = r.protocol_data?.parameters?.consideration?.[0];
  if (!consideration) return null;
  if (
    consideration.token &&
    consideration.token.toLowerCase() !== collateralAsset.toLowerCase()
  ) {
    return null;
  }
  const itemType = consideration.itemType;
  if (itemType !== 2 && itemType !== 3) {
    // Drop criteria-types (4/5) AND any anomalous types
    // (ETH/ERC20) — only concrete NFT considerations qualify.
    return null;
  }
  const ident = (consideration.identifierOrCriteria ?? '0').toString();
  if (ident !== collateralTokenId.toString()) return null;

  // Codex round-16 P2 #2 — drop rows whose top-level `status`
  // is present and not `ACTIVE`. OpenSea offer responses carry
  // a status enum (`ACTIVE`, `INACTIVE`, `FULFILLED`,
  // `EXPIRED`, `CANCELLED`); a future-`endTime` row could still
  // be cancelled/fulfilled and the on-chain rotation would
  // succeed against an offer no bidder can fulfill.
  const offerStatus = (r as { status?: string }).status;
  if (typeof offerStatus === 'string' && offerStatus !== 'ACTIVE') {
    return null;
  }

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
