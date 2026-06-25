/**
 * T-041 Phase 1+2 — typed REST consumer for the apps/indexer offer
 * indexer (`/offers/...` endpoints). Treats the worker as a CACHE,
 * not an oracle: every method returns `null` on any error / timeout
 * / non-2xx, and the caller is expected to fall back to the in-
 * browser `lib/logIndex.ts` scan. Decentralization is preserved —
 * the worker can be down or compromised, and the offer book still
 * loads from on-chain logs.
 *
 * Base URL is read from `VITE_INDEXER_ORIGIN` (the same env var
 * the alerts settings page uses). When unset, every method short-
 * circuits to `null` so dev / preview builds without a worker
 * configured fall through to the log-scan path cleanly.
 */

const TIMEOUT_MS = 4_000;

function baseUrl(): string | null {
  const url = import.meta.env.VITE_INDEXER_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

/**
 * Public accessor for the configured indexer origin (trailing slash
 * stripped), or `null` when `VITE_INDEXER_ORIGIN` is unset. Exists so
 * UI surfaces that want to *display* the endpoint (e.g. the diagnostics
 * drawer's "Indexer endpoint" row) read the exact same value the data
 * calls use — never a second, drifting `import.meta.env` read. The
 * value is build-time operator config, not anything fetched at runtime:
 * the indexer is a cache the app must be told the address of, and there
 * is no on-chain registry to discover it from.
 */
export function indexerOrigin(): string | null {
  return baseUrl();
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
    // Network / timeout / parse error — caller falls back. No
    // logging at INFO level since this is an expected failure mode.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Indexer-cached offer row. Field names mirror `LibVaipakam.Offer`
 *  except `bigint`s are JSON strings (D1 stores as TEXT) and uint8
 *  enums come through as plain numbers. The mapper in
 *  `useIndexedActiveOffers` converts to the OfferBook's `OfferData`. */
export interface IndexedOffer {
  chainId: number;
  offerId: number;
  /** T-086 Round-8 (#358) §19.7e — added `consumed_by_sale` for the
   *  no-loan-branch parallel-sale terminal (Scenario A: buyer-side
   *  won the race). Distinct from `cancelled` so the frontend can
   *  render "Sold via OpenSea" instead of the generic "Cancelled"
   *  copy, and so the indexer's retention prune (which keys on
   *  `cancelled`) preserves the sold-history rows. */
  status: 'active' | 'accepted' | 'cancelled' | 'expired' | 'consumed_by_sale';
  creator: string;
  offerType: number;
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
  // #164 / #195 / #125 — surfaced via indexer migration 0014.
  //   createdAt is the ON-CHAIN Offer.createdAt stamp (NOT
  //     firstSeenAt). Sourced from the Offer struct read; matches
  //     the contract-side cooldown clock second-for-second.
  //     Pre-#164 backfilled rows carry 0; the consumer treats 0
  //     as "cooldown unavailable" and the gate fails open.
  //   expiresAt: 0 = GTC (no expiry). Non-zero = unix-seconds.
  //   fillMode: 0 Partial / 1 AON / 2 IOC.
  //
  // All three are optional even though the indexer always emits
  // them post-0014: the frontend and indexer are deployed
  // independently, so a rollback to a pre-0014 worker shape can
  // omit these keys mid-traffic. The mapper
  // (`indexedToRawOffer`) coerces missing values to 0 before
  // `BigInt` conversion so `BigInt(undefined)` doesn't throw and
  // break the indexer-fed offer-list path at runtime.
  createdAt?: number;
  expiresAt?: number;
  fillMode?: number;
}

export interface OfferStats {
  chainId: number;
  active: number;
  accepted: number;
  cancelled: number;
  expired: number;
  total: number;
  indexer: { lastBlock: number; updatedAt: number } | null;
}

export interface ActiveOffersPage {
  chainId: number;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export interface CreatorOffersPage {
  chainId: number;
  creator: string;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export function fetchOfferStats(chainId: number): Promise<OfferStats | null> {
  return getJson<OfferStats>(`/offers/stats?chainId=${chainId}`);
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

// ──────────────────────────────────────────────────────────────────
// Phase B — loans + activity events
// ──────────────────────────────────────────────────────────────────

/**
 * T-086 step 13 — Seaport prepay-listing payload nested on the
 * indexer's `/loans/:id` response when a live listing exists for
 * the loan. The indexer joins from the `prepay_listings` table.
 * Absent when no listing is live.
 */
export interface IndexedPrepayListing {
  orderHash: string;       // 0x-prefixed bytes32
  askPrice: string;        // string-uint256 (principal asset wei)
  conduit: string;         // 0x-prefixed lowercase
  lister: string;          // current borrower-position-NFT holder at post time
  postedAt: number;        // unix seconds (block timestamp)
  updatedAt: number;       // unix seconds (re-sign anchor; equals postedAt until first update)
  gracePeriodEnd: number;  // unix seconds; permissionless cancelExpired becomes callable at strict `>`
  // T-086 Round-5 Block A (#313) — borrower-controlled sign-time
  // inputs the indexer persists from the post/update event payload.
  // Nullable for pre-migration rows where the columns hadn't been
  // populated yet.
  conduitKey: string | null; // 0x-prefixed bytes32 — Seaport conduit key (NOT the conduit address)
  salt: string | null;       // string-uint256 — borrower's per-sign nonce
  executor: string | null;   // 0x-prefixed lowercase — pinned at post time, survives governance rotation
  // T-086 Round-5 Block B (#309) — Dutch-decay fields.
  // `auctionMode == 0` = fixed-price, `1` = Dutch.
  endAskPrice: string | null;    // string-uint256 — Dutch decay floor; equals askPrice for fixed-price
  auctionEndTime: number | null; // unix seconds — Dutch Seaport endTime; 0/null for fixed-price
  auctionMode: number | null;    // 0 = fixed-price, 1 = Dutch
}

export interface IndexedLoan {
  chainId: number;
  loanId: number;
  offerId: number;
  status: 'active' | 'repaid' | 'defaulted' | 'liquidated' | 'settled';
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
  /** T-086 step 4 — lender consent flag for the prepay-listing flow. */
  allowsPrepayListing?: boolean;
  startBlock: number;
  startAt: number;
  terminalBlock: number | null;
  terminalAt: number | null;
  updatedAt: number;
  /** T-086 step 13 — present iff a Seaport prepay listing is live. */
  prepayListing?: IndexedPrepayListing;
}

/**
 * Map an indexer JSON loan row to the `LoanSummary` shape Dashboard
 * renders. Caller provides the wallet's role on this loan (the
 * by-lender / by-borrower endpoint already filtered live ownerOf,
 * so the caller knows which side fed the row).
 *
 * Status mapping: indexer's string status ('active', 'repaid', etc.)
 * → numeric LoanStatus enum used by the rendering pipeline.
 */
export const INDEXER_STATUS_TO_ENUM: Record<string, number> = {
  active: 0,
  repaid: 1,
  defaulted: 2,
  liquidated: 3,
  settled: 4,
};

export function indexedToLoanSummary(
  o: IndexedLoan,
  role: 'lender' | 'borrower',
): {
  id: bigint;
  principal: bigint;
  principalAsset: string;
  assetType: number;
  principalTokenId: bigint;
  interestRateBps: bigint;
  durationDays: bigint;
  startTime: bigint;
  status: number;
  role: 'lender' | 'borrower';
  collateralAsset: string;
  collateralAmount: bigint;
  collateralAssetType: number;
  collateralTokenId: bigint;
  lenderTokenId: bigint;
  borrowerTokenId: bigint;
  allowsPartialRepay: boolean;
} {
  return {
    id: BigInt(o.loanId),
    principal: BigInt(o.principal),
    principalAsset: o.lendingAsset,
    assetType: o.assetType,
    principalTokenId: BigInt(o.tokenId),
    interestRateBps: BigInt(o.interestRateBps),
    durationDays: BigInt(o.durationDays),
    startTime: BigInt(o.startTime),
    status: INDEXER_STATUS_TO_ENUM[o.status] ?? 0,
    role,
    collateralAsset: o.collateralAsset,
    collateralAmount: BigInt(o.collateralAmount),
    collateralAssetType: o.collateralAssetType,
    collateralTokenId: BigInt(o.collateralTokenId),
    lenderTokenId: BigInt(o.lenderTokenId),
    borrowerTokenId: BigInt(o.borrowerTokenId),
    allowsPartialRepay: o.allowsPartialRepay,
  };
}

export interface ActiveLoansPage {
  chainId: number;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export interface ParticipantLoansPage {
  chainId: number;
  side: 'lender' | 'borrower';
  address: string;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export function fetchActiveLoans(
  chainId: number,
  opts: { limit?: number; before?: number } = {},
): Promise<ActiveLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<ActiveLoansPage>(`/loans/active?${params}`);
}

export function fetchLoanById(
  chainId: number,
  loanId: number,
): Promise<IndexedLoan | null> {
  return getJson<IndexedLoan>(`/loans/${loanId}?chainId=${chainId}`);
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

/** Page returned by /loans/by-current-holder/:addr. Same shape as
 *  ParticipantLoansPage minus `side` — the response is the UNION of
 *  lender + borrower side holdings, and downstream can compare each
 *  loan's `lenderCurrentOwner` / `borrowerCurrentOwner` columns to
 *  infer which side(s) apply. */
export interface HolderLoansPage {
  chainId: number;
  address: string;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

/**
 * GET /loans/by-current-holder/:addr — returns loans where `addr`
 * is the CURRENT holder of either the lender- or borrower-position
 * NFT. Backed by the lender_current_owner / borrower_current_owner
 * D1 columns maintained by the indexer's Transfer event handler.
 * Zero RPC cost; trade-off is staleness up to one cron tick
 * (~minutes) on a fresh Transfer.
 */
export function fetchLoansByCurrentHolder(
  chainId: number,
  holder: string,
  opts: { limit?: number; before?: number } = {},
): Promise<HolderLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<HolderLoansPage>(
    `/loans/by-current-holder/${holder.toLowerCase()}?${params}`,
  );
}

/** Page returned by /offers/by-current-holder/:addr. */
export interface HolderOffersPage {
  chainId: number;
  address: string;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

/**
 * GET /offers/by-current-holder/:addr — returns offers where `addr`
 * CURRENTLY holds the creator-position NFT (via the
 * creator_current_owner D1 column). Covers secondary-market
 * recipients whose `creator` (LoanInitiated-time participant)
 * wouldn't match.
 */
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

export interface RecentLoansPage {
  chainId: number;
  loans: IndexedLoan[];
  nextBefore: number | null;
}

export function fetchRecentLoans(
  chainId: number,
  opts: { limit?: number; before?: number } = {},
): Promise<RecentLoansPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<RecentLoansPage>(`/loans/recent?${params}`);
}

export interface RecentOffersPage {
  chainId: number;
  offers: IndexedOffer[];
  nextBefore: number | null;
}

export function fetchRecentOffers(
  chainId: number,
  opts: { limit?: number; before?: number } = {},
): Promise<RecentOffersPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return getJson<RecentOffersPage>(`/offers/recent?${params}`);
}

export interface LoanStats {
  chainId: number;
  active: number;
  repaid: number;
  defaulted: number;
  liquidated: number;
  settled: number;
  total: number;
  erc20ActiveLoans: number;
  nftRentalsActive: number;
  /** Map of lowercased lending-asset address → decimal-string sum of
   *  principals across all loans of that asset. Caller does BigInt
   *  math + USD pricing client-side. */
  volumeByAsset: Record<string, string>;
  /** Map of lowercased lending-asset address → loan count. Pairs
   *  with `volumeByAsset` for the assetBreakdown table on Analytics. */
  loansByAsset: Record<string, number>;
  averageInterestRateBps: number | null;
  indexer: { lastBlock: number; updatedAt: number } | null;
}

export function fetchLoanStats(chainId: number): Promise<LoanStats | null> {
  return getJson<LoanStats>(`/loans/stats?chainId=${chainId}`);
}

export type LoanTimeseriesRange = '24h' | '7d' | '30d' | '90d' | 'All';

export interface LoanTimeseriesBucket {
  /** Unix-seconds at bucket start (midnight UTC for daily buckets,
   *  hour-aligned for 24h). */
  t: number;
  /** Per-asset principal sum at this bucket, decimal-string for
   *  BigInt-safe parsing. */
  principalByAsset: Record<string, string>;
  /** Per-asset earned interest at this bucket (principal × rate-bps
   *  / 10_000), decimal-string for BigInt-safe parsing. */
  interestByAsset: Record<string, string>;
}

export interface LoanTimeseriesPage {
  chainId: number;
  range: LoanTimeseriesRange;
  buckets: LoanTimeseriesBucket[];
}

export function fetchLoanTimeseries(
  chainId: number,
  range: LoanTimeseriesRange = '30d',
): Promise<LoanTimeseriesPage | null> {
  return getJson<LoanTimeseriesPage>(
    `/loans/timeseries?chainId=${chainId}&range=${range}`,
  );
}

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

export interface ActivityFilters {
  actor?: string;
  loanId?: number;
  offerId?: number;
  kind?: string;
  limit?: number;
  before?: string;
}

/** Map an indexer JSON activity row to the shape `lib/logIndex.ts`
 *  emits (`ActivityEvent`). The Activity page + LoanTimeline +
 *  per-wallet history filter on `participants.includes(wallet)`,
 *  which the indexer's single `actor` column doesn't capture
 *  exhaustively (e.g. OfferAccepted concerns BOTH acceptor AND
 *  creator). We re-derive the full participants list from
 *  `args` here so the consumer code is shape-identical to the
 *  per-browser scan. */
export function indexedToActivityEvent(o: IndexedActivityEvent): {
  kind: string;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  participants: string[];
  args: Record<string, unknown>;
} {
  const args = (typeof o.args === 'string' ? {} : o.args) as Record<string, unknown>;
  const participants: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      participants.push(v.toLowerCase());
    }
  };
  // Walk the args bag for every address-shaped field — covers all
  // current event kinds without per-kind switch logic. New events
  // adding new actor fields work automatically.
  for (const v of Object.values(args)) push(v);
  if (o.actor) participants.push(o.actor.toLowerCase());
  return {
    kind: o.kind,
    blockNumber: o.blockNumber,
    logIndex: o.logIndex,
    txHash: o.txHash,
    participants: Array.from(new Set(participants)),
    args,
  };
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

export function fetchActivity(
  chainId: number,
  filters: ActivityFilters = {},
): Promise<ActivityPage | null> {
  const params = new URLSearchParams({ chainId: String(chainId) });
  if (filters.actor) params.set('actor', filters.actor.toLowerCase());
  if (filters.loanId !== undefined) params.set('loanId', String(filters.loanId));
  if (filters.offerId !== undefined) params.set('offerId', String(filters.offerId));
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.before) params.set('before', filters.before);
  return getJson<ActivityPage>(`/activity?${params}`);
}

/** Map an indexer JSON row to the OfferBook's `RawOffer` shape so it
 *  flows through the same `toOfferData` mapper used for direct
 *  on-chain reads. Centralised here so any future field tweak (e.g.
 *  the matcher field landing in Phase 2) only touches one site.  */
export function indexedToRawOffer(o: IndexedOffer): {
  id: bigint;
  creator: string;
  offerType: number;
  lendingAsset: string;
  amount: bigint;
  // T-086 Round-8 §19.7e + Codex round-18 P2 #1 — Range Orders Phase 2
  // canonical mapping (#183): borrower offers store displayed APR
  // CEILING in `interestRateBpsMax` and floor in `interestRateBps`
  // (the floor sits at `0` so the lender-side discoverability ladder
  // works). The MyOffersTable sold-row branch reads `interestRateBpsMax`
  // first; bubble it through here so the rate cell shows the actual
  // posted rate instead of `0%` on every sold offer. Same fix needed
  // for `amountMax` so future range-orders consumers see the ceiling
  // they expect.
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAsset: string;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  durationDays: bigint;
  principalLiquidity: number;
  collateralLiquidity: number;
  accepted: boolean;
  assetType: number;
  tokenId: bigint;
  allowsPartialRepay: boolean;
  // #164 / #241 — surfaced for the MyOffers cancel-cooldown
  // predicate, which needs `createdAt` + `amountFilled` to evaluate
  // the 5-minute window. `createdAt` is the ON-CHAIN
  // `Offer.createdAt` stamp (uint64, post-#164), NOT the indexer's
  // `firstSeenAt`. The latter is the indexer's ingestion clock; on
  // a fresh indexer, a backfill, or a restart it lags behind the
  // chain by minutes-to-days, and the UI's cancel gate would stay
  // disabled past the contract's window. The on-chain value tracks
  // `OfferCancelFacet.cancelOffer`'s `block.timestamp -
  // createdAt < MIN_OFFER_CANCEL_DELAY` predicate to the second.
  createdAt: bigint;
  amountFilled: bigint;
  // #195 / #125 — surfaced for the GTT expiry chip and the
  // fill-mode badge. Default 0 sentinels keep legacy rows
  // (GTC + Partial) rendering identically.
  expiresAt: bigint;
  fillMode: number;
  // T-086 Round-8 §19.7e (#358) + Codex round-13 P2 #2 — surfaced for
  // the MyOffersTable "Sold" row's collateral cell, which renders
  // NFT-shape collateral by reading `collateralAssetType` + `collateralTokenId`
  // (NFT collateral is the only kind eligible for the
  // `consumed_by_sale` parallel-sale terminal). The indexer already
  // carries both fields on `IndexedOffer`; this entry just bubbles them
  // up through the RawOffer → OfferData mapper.
  collateralAssetType: number;
  collateralTokenId: bigint;
  // T-086 Round-8 §19.7e + Codex round-16 P2 #1 — ERC1155 NFT
  // collateral "number of copies". For ERC721 PrincipalCell ignores
  // it (always 1); for ERC1155 this is what renders as the "N ×"
  // multiplier. Surfaced here so sold rows pass the proper count to
  // the cell instead of mis-reading `collateralAmount` (which is the
  // principal amount for ERC20 borrows).
  collateralQuantity: bigint;
  // #735 item 3 — the NFT-rental prepayment token. Surfaced so the accept flow
  // can rebuild the EXACT risk-access PairId (the gate keys an NFT-rental lend
  // leg off the prepay token, not the rented NFT) when recording a strict-mode
  // mid-tier acknowledgement. Zero address for non-rental offers.
  prepayAsset: string;
} {
  // Optional field narrowing for indexer/frontend version skew —
  // see the IndexedOffer doc-block. Each new-since-0014 field is
  // coerced to 0 before `BigInt` conversion so an undefined value
  // (older worker response shape) doesn't throw at runtime.
  return {
    id: BigInt(o.offerId),
    creator: o.creator,
    offerType: o.offerType,
    lendingAsset: o.lendingAsset,
    amount: BigInt(o.amount),
    amountMax: BigInt(o.amountMax ?? o.amount),
    interestRateBps: BigInt(o.interestRateBps),
    interestRateBpsMax: BigInt(o.interestRateBpsMax ?? o.interestRateBps),
    collateralAsset: o.collateralAsset,
    collateralAmount: BigInt(o.collateralAmount),
    // The indexer doesn't expose `collateralAmountMax` on IndexedOffer
    // today; fall back to the floor so the wire shape matches Phase 2.
    collateralAmountMax: BigInt(o.collateralAmount),
    durationDays: BigInt(o.durationDays),
    principalLiquidity: o.principalLiquidity,
    collateralLiquidity: o.collateralLiquidity,
    // Active offers are by definition not accepted; the indexer flips
    // status to 'accepted' on terminal events, but this mapper is
    // only ever called from the active-only path.
    accepted: o.status === 'accepted',
    assetType: o.assetType,
    tokenId: BigInt(o.tokenId),
    allowsPartialRepay: o.allowsPartialRepay,
    createdAt: BigInt(o.createdAt ?? 0),
    amountFilled: BigInt(o.amountFilled),
    expiresAt: BigInt(o.expiresAt ?? 0),
    fillMode: o.fillMode ?? 0,
    collateralAssetType: o.collateralAssetType,
    collateralTokenId: BigInt(o.collateralTokenId ?? '0'),
    collateralQuantity: BigInt(o.collateralQuantity ?? '0'),
    // #735 item 3 — default to the zero address for older indexer rows that
    // predate the field, matching the contract's "no prepay" sentinel.
    prepayAsset: o.prepayAsset ?? '0x0000000000000000000000000000000000000000',
  };
}


/** #335 — record a Match-rotation breadcrumb. Called from
 *  `OpenSeaOffersSection.onMatchOffer` after the rotation tx
 *  receipt resolves. Best-effort: any failure (network blip,
 *  indexer down, validation reject) is logged but never thrown
 *  back to the caller — the rotation tx is already on-chain by
 *  the time this fires.
 *
 *  Returns `true` on 2xx, `false` on every other outcome
 *  (transport error / non-2xx / `VITE_INDEXER_ORIGIN` unset).
 *  Caller is expected to NOT branch on the return value — the
 *  bool is for telemetry / tests only. */
export async function postPrepayMatchSource(
  chainId: number,
  loanId: bigint,
  body: {
    txHash: `0x${string}`;
    orderHash: string;
    bidder: string;
    matchedAt: number;
  },
): Promise<boolean> {
  const root = baseUrl();
  if (!root) return false;
  // Codex round-2 P3 #343 — use AbortController + setTimeout
  // instead of AbortSignal.timeout. The latter throws on
  // browsers/runtimes that don't ship the newer static method,
  // which would silently drop every breadcrumb in those clients
  // (older WebViews, embedded iframes). Mirrors the existing
  // `getJson` pattern in this file.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${root}/loans/${loanId.toString()}/prepay-listing/match-source?chainId=${chainId}`,
      {
        method: "POST",
        // Codex round-4 P3 #343 — `text/plain` (a CORS-simple
        // Content-Type) keeps the breadcrumb POST a "simple
        // request" so the browser doesn't issue a preflight
        // OPTIONS before the POST. During tab close / full
        // navigation the preflight can fail to complete even
        // with `keepalive: true` set, which would defeat the
        // round-3 close-the-tab fix. The Worker calls
        // `await req.json()` to parse the body — that's
        // Content-Type-agnostic on the Workers runtime, so
        // the parse stays correct.
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
        // Same TIMEOUT_MS as the reads; the rotation tx already
        // landed, so dragging the UI on this POST is pointless.
        signal: controller.signal,
        // Codex round-3 P3 #343 — `keepalive: true` lets the
        // browser finish this small JSON POST during page
        // unload (tab close / full-page navigation right after
        // the receipt arrives). Without it, the browser is
        // free to cancel non-keepalive fetches at unload, which
        // is exactly the close-the-tab case the early-fire
        // callback in `useNFTPrepayListing` is trying to cover.
        keepalive: true,
      },
    );
    if (!res.ok) {
      // Codex round-3 P3 #343 — surface non-2xx breadcrumb
      // failures (rate-limit 429, D1 500, payload-rejection
      // 400) in the console. Both hook callers discard the
      // boolean return with `void`, so without this log the
      // failure is invisible even though the contract with
      // the UI is "failures are logged".
      // eslint-disable-next-line no-console
      console.warn(
        "[postPrepayMatchSource] non-2xx response — breadcrumb dropped",
        { status: res.status, statusText: res.statusText },
      );
    }
    return res.ok;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[postPrepayMatchSource] best-effort POST failed", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
