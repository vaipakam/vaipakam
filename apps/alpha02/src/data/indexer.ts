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
}

export interface ActiveOffersPage {
  chainId: number;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export function fetchActiveOffers(
  chainId: number,
  opts: { limit?: number; before?: number } = {},
): Promise<ActiveOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<ActiveOffersPage>(`/offers/active?${params}`);
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
): Promise<CreatorOffersPage | null> {
  return getJson<CreatorOffersPage>(
    `/offers/by-creator/${creator.toLowerCase()}?chainId=${chainId}`,
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
): Promise<ParticipantLoansPage | null> {
  return getJson<ParticipantLoansPage>(
    `/loans/by-lender/${lender.toLowerCase()}?chainId=${chainId}`,
  );
}

export function fetchLoansByBorrower(
  chainId: number,
  borrower: string,
): Promise<ParticipantLoansPage | null> {
  return getJson<ParticipantLoansPage>(
    `/loans/by-borrower/${borrower.toLowerCase()}?chainId=${chainId}`,
  );
}

export function fetchLoanById(
  chainId: number,
  loanId: number,
): Promise<IndexedLoan | null> {
  return getJson<IndexedLoan>(`/loans/${loanId}?chainId=${chainId}`);
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
  opts: { actor?: string; limit?: number } = {},
): Promise<ActivityPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.actor) params.set('actor', opts.actor.toLowerCase());
  if (opts.limit) params.set('limit', String(opts.limit));
  return getJson<ActivityPage>(`/activity?${params}`);
}

export interface ClaimablesResponse {
  chainId: number;
  address: string;
  asLender: IndexedLoan[];
  asBorrower: IndexedLoan[];
}

export function fetchClaimables(
  chainId: number,
  address: string,
): Promise<ClaimablesResponse | null> {
  return getJson<ClaimablesResponse>(
    `/claimables/${address.toLowerCase()}?chainId=${chainId}`,
  );
}
