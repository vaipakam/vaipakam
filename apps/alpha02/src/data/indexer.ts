/**
 * Typed consumer for the apps/indexer worker — the subset alpha02
 * needs (active offers, a wallet's loans, claimables). Same contract
 * as apps/defi's client: the indexer is a CACHE, not an oracle —
 * every call returns `null` on error/timeout/unset origin and the UI
 * degrades to an honest "couldn't load" state (never a fake empty
 * market). Types mirror apps/defi/src/lib/indexerClient.ts; keep the
 * field shapes in sync with the worker.
 */

const TIMEOUT_MS = 4_000;

function baseUrl(): string | null {
  const url = import.meta.env.VITE_INDEXER_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

export function indexerConfigured(): boolean {
  return baseUrl() !== null;
}

/**
 * #757 Phase B — the WebSocket origin for the indexer's realtime push
 * channel. Prefers an explicit `VITE_INDEXER_WS_ORIGIN` (an operator
 * may front the WS on a separate host); otherwise derives it from
 * `VITE_INDEXER_ORIGIN` by swapping the scheme. `null` = channel
 * disabled, the app keeps its normal polling. Mirrors
 * apps/defi/src/lib/indexerClient.ts.
 */
export function indexerWsOrigin(): string | null {
  const explicit = import.meta.env.VITE_INDEXER_WS_ORIGIN as string | undefined;
  if (explicit) return explicit.replace(/\/$/, '');
  const http = baseUrl();
  if (!http) return null;
  if (http.startsWith('https://')) return 'wss://' + http.slice('https://'.length);
  if (http.startsWith('http://')) return 'ws://' + http.slice('http://'.length);
  return null; // non-http origin — can't derive a ws scheme.
}

async function getJson<T>(path: string): Promise<T | null> {
  const root = baseUrl();
  if (!root) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(root + path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Offer row as the indexer serves it (bigints as strings). */
export interface IndexedOffer {
  chainId: number;
  offerId: number;
  status: 'active' | 'accepted' | 'cancelled' | 'expired' | 'consumed_by_sale';
  creator: string;
  offerType: number; // 0 = lender offer, 1 = borrower offer
  lendingAsset: string;
  collateralAsset: string;
  assetType: number;
  collateralAssetType: number;
  principalLiquidity: number;
  collateralLiquidity: number;
  tokenId: string;
  collateralTokenId: string;
  quantity: string;
  collateralQuantity: string;
  amount: string;
  amountMax: string;
  amountFilled: string;
  interestRateBps: number;
  interestRateBpsMax: number;
  collateralAmount: string;
  durationDays: number;
  positionTokenId: string;
  prepayAsset: string;
  useFullTermInterest: boolean;
  creatorRiskAndTermsConsent: boolean;
  allowsPartialRepay: boolean;
  firstSeenBlock: number;
  firstSeenAt: number;
  updatedAt: number;
  createdAt?: number;
  expiresAt?: number;
  fillMode?: number;
  /** Lender-sale vehicle marker (0029) — a borrower-style offer linked
   *  to an existing loan; bookkeeping, never quotable market liquidity.
   *  Optional: older workers (and the chain-hydration path) omit it. */
  isSaleVehicle?: boolean;
}

export interface ActiveOffersPage {
  chainId: number;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

/** Optional server-side market scoping (Rate Desk #1129): the worker
 *  filters on the exact (pair, tenor) triple, riding a purpose-built
 *  index. Client-filtering the GLOBAL page instead would silently
 *  blank any market whose rows sit past the 200-row page cap. */
export interface MarketScope {
  lendingAsset?: string;
  collateralAsset?: string;
  durationDays?: number;
}

function applyMarketScope(params: URLSearchParams, scope: MarketScope): void {
  if (scope.lendingAsset) params.set('lendingAsset', scope.lendingAsset.toLowerCase());
  if (scope.collateralAsset) {
    params.set('collateralAsset', scope.collateralAsset.toLowerCase());
  }
  if (scope.durationDays !== undefined) {
    params.set('durationDays', String(scope.durationDays));
  }
}

export function fetchActiveOffers(
  chainId: number,
  opts: { limit?: number; before?: number } & MarketScope = {},
): Promise<ActiveOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  applyMarketScope(params, opts);
  return getJson<ActiveOffersPage>(`/offers/active?${params}`);
}

/** One market row from `GET /offers/markets` — a distinct ERC-20/ERC-20
 *  (lendingAsset, collateralAsset, durationDays) triple with live-offer
 *  counts and per-side best headline rates. The Rate Desk's pair chips
 *  + tenor emphasis derive from this endpoint (never from walking the
 *  paginated active feed, whose page cap would drop markets). */
export interface MarketSummary {
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number;
  lenderOffers: number;
  borrowerOffers: number;
  /** Lowest lender floor rate (bps) — best ask. Null when no lender side. */
  bestAskBps: number | null;
  /** Highest borrower ceiling rate (bps) — best bid. Null when no borrower side. */
  bestBidBps: number | null;
}

export function fetchOffersMarkets(
  chainId: number,
): Promise<{ chainId: number; markets: MarketSummary[] } | null> {
  return getJson<{ chainId: number; markets: MarketSummary[] }>(
    `/offers/markets?chainId=${chainId}`,
  );
}

export interface CreatorOffersPage {
  chainId: number;
  creator: string;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export function fetchOfferById(
  chainId: number,
  offerId: number,
): Promise<IndexedOffer | null> {
  return getJson<IndexedOffer>(`/offers/${offerId}?chainId=${chainId}`);
}

export function fetchOffersByCreator(
  chainId: number,
  creator: string,
  opts: { limit?: number; before?: number } = {},
): Promise<CreatorOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<CreatorOffersPage>(
    `/offers/by-creator/${creator.toLowerCase()}?${params}`,
  );
}

export interface HolderOffersPage {
  chainId: number;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

/** Offers whose position NFT the wallet CURRENTLY holds — the manage/
 *  cancel surface must key on this, not the immutable creator, so a
 *  transferred offer NFT follows its new owner. */
export function fetchOffersByCurrentHolder(
  chainId: number,
  holder: string,
  opts: { limit?: number; before?: number } = {},
): Promise<HolderOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<HolderOffersPage>(
    `/offers/by-current-holder/${holder.toLowerCase()}?${params}`,
  );
}

export type IndexedLoanStatus =
  | 'active'
  | 'repaid'
  | 'defaulted'
  | 'liquidated'
  | 'settled'
  | 'fallback_pending'
  | 'internal_matched';

/** Loan row as the indexer serves it. */
export interface IndexedLoan {
  chainId: number;
  loanId: number;
  offerId: number;
  status: IndexedLoanStatus;
  lender: string;
  borrower: string;
  principal: string;
  collateralAmount: string;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number;
  tokenId: string;
  collateralTokenId: string;
  lenderTokenId: string;
  borrowerTokenId: string;
  interestRateBps: number;
  startTime: number;
  allowsPartialRepay: boolean;
  startBlock: number;
  startAt: number;
  terminalBlock: number | null;
  terminalAt: number | null;
  updatedAt: number;
}

export interface ParticipantLoansPage {
  chainId: number;
  side: 'lender' | 'borrower';
  address: string;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export function fetchLoansByLender(
  chainId: number,
  lender: string,
  opts: { limit?: number; before?: number } = {},
): Promise<ParticipantLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<ParticipantLoansPage>(
    `/loans/by-lender/${lender.toLowerCase()}?${params}`,
  );
}

export function fetchLoansByBorrower(
  chainId: number,
  borrower: string,
  opts: { limit?: number; before?: number } = {},
): Promise<ParticipantLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<ParticipantLoansPage>(
    `/loans/by-borrower/${borrower.toLowerCase()}?${params}`,
  );
}

export function fetchLoanById(
  chainId: number,
  loanId: number,
): Promise<IndexedLoan | null> {
  return getJson<IndexedLoan>(`/loans/${loanId}?chainId=${chainId}`);
}

export interface RecentLoansPage {
  chainId: number;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

/** Cross-status recent loans, optionally market-scoped server-side —
 *  the Rate Desk's tape (executed fills for one (pair, tenor) market).
 *  `excludeSaleVehicles` drops the lender-sale temp bookkeeping loans:
 *  a secondary position sale is not a fresh rate print. */
export function fetchRecentLoans(
  chainId: number,
  opts: {
    limit?: number;
    before?: number;
    excludeSaleVehicles?: boolean;
  } & MarketScope = {},
): Promise<RecentLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  if (opts.excludeSaleVehicles) params.set('excludeSaleVehicles', '1');
  applyMarketScope(params, opts);
  return getJson<RecentLoansPage>(`/loans/recent?${params}`);
}

/** Activity event row — mirrors the worker's shape (see apps/defi
 *  indexerClient IndexedActivityEvent). */
export interface IndexedActivityEvent {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  kind: string;
  loanId: number | null;
  offerId: number | null;
  actor: string | null;
  args: Record<string, unknown> | string;
  blockAt: number;
}

export interface ActivityPage {
  chainId: number;
  events: IndexedActivityEvent[];
  nextBefore: string | null;
}

/** NOTE: do NOT filter by `actor=` for a user's history — the worker's
 *  single actor column is non-exhaustive (OfferAccepted stores only the
 *  acceptor; LoanDefaulted/LoanRepaid/etc. store null). Fetch broadly
 *  and filter client-side by participation, like apps/defi does. */
export function fetchActivity(
  chainId: number,
  opts: { actor?: string; limit?: number; before?: string } = {},
): Promise<ActivityPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.actor) params.set('actor', opts.actor.toLowerCase());
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', opts.before);
  return getJson<ActivityPage>(`/activity?${params}`);
}

// (The /claimables endpoint client was removed with #988: claimables
// are on-chain-authoritative now — see data/claimables.ts.)

/** Indexer ingest-cursor freshness, piggybacked on /offers/stats
 *  (F-20260703-003, #988). `null` = endpoint unreachable OR the chain
 *  has no cursor yet — "unknown", never treated as fresh OR stale. */
export interface IndexerFreshness {
  lastBlock: number;
  /** Unix SECONDS of the cursor's last advance. */
  updatedAt: number;
}

export async function fetchIndexerFreshness(
  chainId: number,
): Promise<IndexerFreshness | null> {
  const res = await getJson<{
    indexer: { lastBlock: number; updatedAt: number } | null;
  }>(`/offers/stats?chainId=${chainId}`);
  return res?.indexer ?? null;
}

/** Freshness probe for the Support drawer (#1028 item 4) — unlike
 *  `fetchIndexerFreshness`, this keeps "endpoint unreachable" and
 *  "reachable but this chain has no ingest cursor yet" apart: a fresh
 *  deployment or newly added chain must not read as an outage in a
 *  user-facing health check. */
export type IndexerFreshnessProbe =
  | { kind: 'unreachable' }
  | { kind: 'no-cursor' }
  | { kind: 'cursor'; freshness: IndexerFreshness };

export async function probeIndexerFreshness(
  chainId: number,
): Promise<IndexerFreshnessProbe> {
  const res = await getJson<{
    indexer: { lastBlock: number; updatedAt: number } | null;
  }>(`/offers/stats?chainId=${chainId}`);
  if (res === null) return { kind: 'unreachable' };
  return res.indexer
    ? { kind: 'cursor', freshness: res.indexer }
    : { kind: 'no-cursor' };
}
