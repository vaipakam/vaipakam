import {
  decodeAbiParameters,
  keccak256,
  numberToHex,
  parseAbiParameters,
  toBytes,
  type Hex,
} from 'viem';

/** Raw `eth_getLogs` log — we talk to the RPC via a direct `fetch` rather
 *  than viem's `publicClient.request` so we can OR together 15 event
 *  topic0s in one request instead of 15 separate calls, AND avoid viem's
 *  typed-request wrapping (some public RPCs — `rpc.sepolia.org` in
 *  particular — reject viem's body shape with "JSON is not a valid
 *  request object", even though it's spec-compliant). Hand-rolling the
 *  JSON-RPC body keeps this scan compatible with every upstream. */
interface RawLog {
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  address: Hex;
  data: Hex;
  topics: Hex[];
  removed: boolean;
}

const id = (sig: string): Hex => keccak256(toBytes(sig));

// Topic0 for ERC-721 Transfer(address,address,uint256). We filter by topic
// hash rather than by event name because the combined Diamond ABI exposes
// two identical `Transfer` fragments (the ERC-721 facet is bundled twice
// in the generated ABI); higher-level event-by-name filtering refuses to
// resolve with duplicates, so raw topic filtering sidesteps that.
const TRANSFER_TOPIC0 = id('Transfer(address,address,uint256)');
// Same defensive pattern for LoanInitiated — filtering by topic hash avoids
// any ABI-fragment resolution ambiguity in the combined Diamond ABI.
// Signature must match the 6-arg form in `LoanFacet.sol` exactly — an earlier
// 4-arg hash silently matched nothing and left the loan cache permanently
// empty (which surfaced as "Total Loans = 0" on Dashboard even after loans
// landed on-chain).
const LOAN_INITIATED_TOPIC0 = id(
  'LoanInitiated(uint256,uint256,address,address,uint256,uint256)',
);
// `OfferCreated(uint256 indexed offerId, address indexed creator, uint8 offerType)`
// — topic[1] carries the offerId. We only need the ID universe; full offer
// details are fetched via `getOffer(id)` on demand.
const OFFER_CREATED_TOPIC0 = id('OfferCreated(uint256,address,uint8)');
// Terminal transitions for an offer. Both carry `offerId` as the first
// indexed topic, which lets us prune the open-offer set without any
// `getOffer` round-trip.
const OFFER_ACCEPTED_TOPIC0 = id('OfferAccepted(uint256,address,uint256)');
const OFFER_CANCELED_TOPIC0 = id('OfferCanceled(uint256,address)');
// Companion of `OfferCanceled` that carries the full offer terms for
// cancelled-row reconstruction (see OfferFacet.sol). The legacy
// `OfferCanceled` keeps emitting for historical consumers; this one
// is what hydrates the "Your Offers / Cancelled" rows.
const OFFER_CANCELED_DETAILS_TOPIC0 = id(
  'OfferCanceledDetails(uint256,address,uint8,uint8,address,uint256,uint256,address,uint256,uint256,uint256)',
);
// Extended lifecycle events surfaced by the Activity page. These are purely
// additive: they don't feed the loan/offer aggregates above, they're
// captured into a parallel `events[]` stream so Activity can render a
// per-user on-chain history without hitting the RPC again.
const LOAN_REPAID_TOPIC0 = id('LoanRepaid(uint256,address,uint256,uint256)');
const LOAN_DEFAULTED_TOPIC0 = id('LoanDefaulted(uint256,bool)');
const LENDER_CLAIMED_TOPIC0 = id(
  'LenderFundsClaimed(uint256,address,address,uint256)',
);
const BORROWER_CLAIMED_TOPIC0 = id(
  'BorrowerFundsClaimed(uint256,address,address,uint256)',
);
const COLLATERAL_ADDED_TOPIC0 = id(
  'CollateralAdded(uint256,address,uint256,uint256,uint256,uint256)',
);
// Lender early-withdrawal via BUY-offer path: burns the original lender's
// position NFT and mints a new LoanInitiated-status NFT to the new lender in
// the same tx. Carries `loanId`, `originalLender`, `newLender` indexed.
const LOAN_SOLD_TOPIC0 = id('LoanSold(uint256,address,address,uint256)');
// Borrower obligation transfer via PrecloseFacet's offset flow: burns the
// original borrower NFT and mints a new one to the new borrower in the same
// tx. Carries `loanId`, `originalBorrower`, `newBorrower` indexed.
const LOAN_OBLIGATION_TRANSFERRED_TOPIC0 = id(
  'LoanObligationTransferred(uint256,address,address,uint256)',
);
// VPFI token activities surfaced on the Activity page so users can see
// their fixed-rate buys and their escrow deposits/unstakes alongside
// lending events. All three carry the user address as the first indexed
// topic; non-indexed amounts live in `data`. Signatures pinned to the
// VPFIDiscountFacet ABI.
const VPFI_PURCHASED_TOPIC0 = id(
  'VPFIPurchasedWithETH(address,uint256,uint256)',
);
const VPFI_DEPOSITED_TOPIC0 = id(
  'VPFIDepositedToEscrow(address,uint256)',
);
const VPFI_WITHDRAWN_TOPIC0 = id(
  'VPFIWithdrawnFromEscrow(address,uint256)',
);
// Loan-lifecycle breakdown events powering the Loan Details timeline.
// `LoanSettlementBreakdown` records the proper-close split (principal
// returned + interest split into lender-share + treasury-share + late
// fee). `LiquidationFallback` + `LiquidationFallbackSplit` record the
// fallback path (DEX swap reverted or > 6% slippage) — first names the
// lender, second carries the three-way collateral allocation.
// `LoanSettled` marks the end of life (both sides claimed).
// `PartialRepaid` traces partial repayments. `ClaimRetryExecuted`
// records claim-time swap-retry attempts. `BorrowerLifRebateClaimed`
// traces the borrower's VPFI fee-discount rebate payout.
const LOAN_SETTLEMENT_BREAKDOWN_TOPIC0 = id(
  'LoanSettlementBreakdown(uint256,uint256,uint256,uint256,uint256,uint256)',
);
const LIQUIDATION_FALLBACK_TOPIC0 = id(
  'LiquidationFallback(uint256,address,uint256)',
);
const LIQUIDATION_FALLBACK_SPLIT_TOPIC0 = id(
  'LiquidationFallbackSplit(uint256,uint256,uint256,uint256)',
);
const LOAN_SETTLED_TOPIC0 = id('LoanSettled(uint256)');
const PARTIAL_REPAID_TOPIC0 = id(
  'PartialRepaid(uint256,uint256,uint256)',
);
const CLAIM_RETRY_EXECUTED_TOPIC0 = id(
  'ClaimRetryExecuted(uint256,bool,uint256)',
);
const BORROWER_LIF_REBATE_CLAIMED_TOPIC0 = id(
  'BorrowerLifRebateClaimed(uint256,address,uint256)',
);
const STAKING_REWARDS_CLAIMED_TOPIC0 = id(
  'StakingRewardsClaimed(address,uint256)',
);
const INTERACTION_REWARDS_CLAIMED_TOPIC0 = id(
  'InteractionRewardsClaimed(address,uint256,uint256,uint256)',
);

/**
 * Event-driven loan + position-NFT ownership cache.
 *
 * The indexer pages two event streams off the Diamond — `LoanInitiated`
 * (every loan the platform has ever initiated) and `Transfer` (every
 * mint / burn / secondary-market move of a Vaipakam position NFT) —
 * through `Contract.queryFilter`, so the scan shares the connected
 * provider with no separate JSON-RPC handle.
 *
 * Both streams are merged into a cache keyed by (chainId, diamond) in
 * localStorage. The next scan resumes from `lastBlock + 1`, and the
 * `owners` map on the cache lets the hooks read current NFT holders
 * without a live `ownerOf` round-trip for every loan.
 */

export interface LoanIndexEntry {
  loanId: bigint;
  lender: string;
  borrower: string;
}

/**
 * A decoded on-chain event surfaced for the Activity timeline. One per log
 * entry from our event allow-list. `args` is a kind-specific bag — the Activity
 * renderer dispatches on `kind`. Timestamps are not included: block times are
 * fetched lazily by the UI to avoid an N-block header round-trip in the scan.
 */
export type ActivityEventKind =
  | 'OfferCreated'
  | 'OfferAccepted'
  | 'OfferCanceled'
  | 'OfferCanceledDetails'
  | 'LoanInitiated'
  | 'LoanRepaid'
  | 'LoanDefaulted'
  | 'LenderFundsClaimed'
  | 'BorrowerFundsClaimed'
  | 'CollateralAdded'
  | 'LoanSold'
  | 'LoanObligationTransferred'
  | 'LoanSettlementBreakdown'
  | 'LiquidationFallback'
  | 'LiquidationFallbackSplit'
  | 'LoanSettled'
  | 'PartialRepaid'
  | 'ClaimRetryExecuted'
  | 'BorrowerLifRebateClaimed'
  | 'StakingRewardsClaimed'
  | 'InteractionRewardsClaimed'
  | 'VPFIPurchasedWithETH'
  | 'VPFIDepositedToEscrow'
  | 'VPFIWithdrawnFromEscrow';

export interface ActivityEvent {
  kind: ActivityEventKind;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** Every participating address (lowercased). The Activity page filters on
   *  `participants.includes(wallet)` so it doesn't have to know event-specific
   *  field locations. */
  participants: string[];
  /** Kind-specific payload. All bigints are stored as decimal strings in cache
   *  and rehydrated on read — JSON.stringify can't round-trip BigInt. */
  args: Record<string, string | number | boolean>;
}

export interface LogIndexResult {
  loans: LoanIndexEntry[];
  /** Offer IDs seen via `OfferCreated`. Sorted ascending. */
  offerIds: bigint[];
  /** `offerIds` minus any that have been Accepted or Canceled. Sorted ascending. */
  openOfferIds: bigint[];
  /** Offer IDs that have reached a terminal state (Accepted or Canceled).
   *  Used by the OfferBook "Closed" tab so historical / filled liquidity is
   *  still browsable after the open side dries up. Sorted ascending. */
  closedOfferIds: bigint[];
  /** Most recently accepted offer (from `OfferAccepted`), or null. */
  lastAcceptedOfferId: bigint | null;
  /** Rolling list of the last {@link RECENT_ACCEPTED_CAP} accepted offer
   *  IDs in NEWEST-FIRST order. Lets the OfferBook compute a per-filter
   *  market anchor — pick the freshest match that passes the current
   *  `matchesFilter` rather than relying on a single global "last accepted"
   *  rate that vanishes the moment any filter narrows past it. */
  recentAcceptedOfferIds: bigint[];
  /** All decoded user-facing events in ascending (block, logIndex) order.
   *  Consumed by the Activity page; filters on `participants`. */
  events: ActivityEvent[];
  /** Current owner of `tokenId` per the last indexed Transfer, or null. */
  getOwner: (tokenId: bigint) => string | null;
  /** Raw last indexed owner including the zero address (i.e. burned). Returns
   *  null only when the tokenId has never been touched by a Transfer. Used
   *  by the NFT Verifier to distinguish "burned" from "never existed". */
  getLastOwner: (tokenId: bigint) => string | null;
  /** For a burned tokenId, the address that held it immediately before the
   *  burn Transfer. Returns null for live NFTs (use `getOwner`) or for
   *  tokenIds the index has never seen. Used by the NFT Verifier to show the
   *  last known holder of a burned position so a prospective buyer can
   *  correlate the seller to on-chain history. */
  getPreviousOwner: (tokenId: bigint) => string | null;
  /** Reverse lookup: position-NFT tokenId → the `LoanInitiated` event that
   *  minted it, plus whether it's the lender or borrower side. Resolved at
   *  scan time via tx-hash correlation between `LoanInitiated` and the two
   *  mint `Transfer` events in the same transaction. Lets the NFT Verifier
   *  reconstruct a burned token's historical loan context purely from the
   *  event index — no `getLoanDetails` round-trip needed. */
  getLoanInitiatedForToken: (tokenId: bigint) =>
    | { loanId: string; role: 'lender' | 'borrower'; event: ActivityEvent }
    | null;
  /** Reverse lookup: position-NFT tokenId → the `OfferCreated` event that
   *  minted it. Useful for burned NFTs whose offer never turned into a loan
   *  (canceled before acceptance), so the Verifier can still surface the
   *  offer status instead of falling back to "unknown". */
  getOfferForToken: (tokenId: bigint) =>
    | {
        offerId: string;
        creator: string;
        status: 'accepted' | 'canceled' | 'open';
        event: ActivityEvent;
      }
    | null;
}

interface CachedShape {
  lastBlock: number;
  // bigints don't JSON-round-trip; store as decimal strings.
  loans: Array<{ loanId: string; lender: string; borrower: string }>;
  // tokenId (decimal string) -> owner address (lowercased); zero addr = burned.
  owners: Record<string, string>;
  /** tokenId → the address that held the NFT immediately before the burn
   *  Transfer (i.e. the `from` on the Transfer-to-zero). Only populated for
   *  burned tokens; live tokens read the current holder from `owners`. Lets
   *  the Verifier surface the last known holder of a burned position NFT so
   *  a prospective buyer can correlate the seller to the on-chain history. */
  prevOwners?: Record<string, string>;
  // Offer IDs (decimal strings) from OfferCreated.
  offerIds: string[];
  /** Offer IDs that have reached a terminal state (accepted or canceled). */
  closedOfferIds?: string[];
  /** Highest (most recent) offerId seen in `OfferAccepted`, or null. */
  lastAcceptedOfferId?: string | null;
  /** Last N accepted offer IDs in OLDEST-FIRST scan order. Hydrated to
   *  newest-first on the public {@link LogIndexResult}. */
  recentAcceptedOfferIds?: string[];
  /** Decoded activity events in scan order. Keyed by (txHash, logIndex) to
   *  keep dedupe cheap on cache merge. */
  events?: ActivityEvent[];
}

// Block range per `eth_getLogs` call. Overridable via `VITE_LOG_INDEX_CHUNK`
// because RPC providers disagree wildly: Alchemy free tier caps at 10 blocks,
// Infura free at ~1k, publicnode at ~10k. Default to a conservative 10 so the
// app works out-of-the-box on free Alchemy; bump it via env for real RPCs.
const DEFAULT_CHUNK = 10;
/** Max recent-accepted offers retained per chain. 20 is plenty for the
 *  Offer Book's filter-scoped anchor lookup — most filters will hit a
 *  match within the first 1–3 entries, and beyond ~20 the rates are
 *  stale enough that "no anchor" is more honest than a dusty quote. */
const RECENT_ACCEPTED_CAP = 20;
const CHUNK = (() => {
  try {
    const v = Number(import.meta.env.VITE_LOG_INDEX_CHUNK);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_CHUNK;
  } catch {
    return DEFAULT_CHUNK;
  }
})();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Cache version is part of the localStorage key. Bumping forces a
 * fresh scan from `deployBlock` for every existing browser cache
 * (the old key becomes unreachable, the new key is empty).
 *
 * **Bump when** the cache shape changes, the topic-filter OR-set
 * changes, or the scanner logic changes in a way that affects
 * stored data (so historical caches would be silently wrong).
 *
 * **Don't bump for** purely-additive client-side projections
 * (e.g., `recentAcceptedOfferIds` was added without a bump because
 * `readCache` backfills it from the cached `events` array on hydrate).
 *
 * Started fresh at `v1` during pre-live development — no production
 * users existed yet, so historical migration carries no value. Going
 * forward, increment normally when invalidation is required.
 */
function storageKey(chainId: number, diamond: string): string {
  return `vaipakam:logIndex:v1:${chainId}:${diamond.toLowerCase()}`;
}

function emptyCache(deployBlock: number): CachedShape {
  return {
    lastBlock: deployBlock - 1,
    loans: [],
    owners: {},
    prevOwners: {},
    offerIds: [],
    closedOfferIds: [],
    lastAcceptedOfferId: null,
    recentAcceptedOfferIds: [],
    events: [],
  };
}

function readCache(chainId: number, diamond: string): CachedShape | null {
  try {
    const raw = localStorage.getItem(storageKey(chainId, diamond));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedShape>;
    if (typeof parsed.lastBlock !== 'number' || !Array.isArray(parsed.loans)) return null;
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    // Backfill `recentAcceptedOfferIds` from the cached events array when the
    // field is missing or empty. The field was added 2026-04-28 without a
    // cache-key bump, so a v7 cache written before that date can have
    // `lastBlock` past the OfferAccepted that should be the market anchor —
    // the incremental scan only re-reads blocks beyond `lastBlock`, so the
    // historical event would otherwise never make it into the rolling list.
    // `events` is sorted oldest-first; we keep that order to match the
    // mid-scan in-memory convention (the result is reversed at hydrate time).
    const cachedRecent = Array.isArray(parsed.recentAcceptedOfferIds)
      ? parsed.recentAcceptedOfferIds
      : [];
    const recentAcceptedOfferIds = cachedRecent.length > 0
      ? cachedRecent
      : events
          .filter((ev) => ev.kind === 'OfferAccepted' && typeof ev.args.offerId === 'string')
          .map((ev) => ev.args.offerId as string)
          .slice(-RECENT_ACCEPTED_CAP);
    return {
      lastBlock: parsed.lastBlock,
      loans: parsed.loans,
      owners: parsed.owners ?? {},
      prevOwners: parsed.prevOwners ?? {},
      offerIds: Array.isArray(parsed.offerIds) ? parsed.offerIds : [],
      closedOfferIds: Array.isArray(parsed.closedOfferIds) ? parsed.closedOfferIds : [],
      lastAcceptedOfferId: parsed.lastAcceptedOfferId ?? null,
      recentAcceptedOfferIds,
      events,
    };
  } catch {
    return null;
  }
}

function writeCache(chainId: number, diamond: string, value: CachedShape): void {
  try {
    localStorage.setItem(storageKey(chainId, diamond), JSON.stringify(value));
  } catch {
    // Quota / private-mode: tolerate — next load will just refetch.
  }
}

interface GetLogsFilter {
  address?: string;
  topics?: (string | string[] | null)[];
  fromBlock?: number;
  toBlock?: number;
}

/**
 * Hand-rolled `eth_getLogs` via `fetch`. Used instead of viem's
 * `publicClient.getLogs` / `publicClient.request` for two reasons:
 *   1. We OR together many event topic0 signatures in one RPC, and
 *      viem's typed `getLogs` only accepts ABI-typed `event` / `events`.
 *   2. Some public RPCs (`rpc.sepolia.org` in particular) reject viem's
 *      typed-request body shape with "JSON is not a valid request
 *      object" — a direct JSON-RPC body is the lowest-common-denominator
 *      shape that every upstream accepts.
 */
async function jsonRpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  // Public RPCs often return the real error (e.g. "query returned more
  // than 10000 results") in the JSON body even when the HTTP status is
  // 400 — so read the body first and only fall back to the HTTP code
  // if parsing fails. This is how the downstream block-range-size
  // detector gets the strings it needs to halve the chunk and recover.
  const body = await response
    .json()
    .catch(() => null) as
    | { result?: T; error?: { code?: number; message?: string } }
    | null;
  if (body?.error) {
    throw new Error(body.error.message ?? `${method} failed`);
  }
  if (!response.ok) {
    throw new Error(
      `${method}: HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }
  return (body?.result as T) ?? (undefined as T);
}

async function rawGetLogs(
  rpcUrl: string,
  filter: GetLogsFilter,
): Promise<RawLog[]> {
  const params: {
    address?: string;
    topics?: (string | string[] | null)[];
    fromBlock?: string;
    toBlock?: string;
  } = {};
  if (filter.address) params.address = filter.address;
  if (filter.topics) params.topics = filter.topics;
  if (typeof filter.fromBlock === 'number') {
    params.fromBlock = numberToHex(filter.fromBlock);
  }
  if (typeof filter.toBlock === 'number') {
    params.toBlock = numberToHex(filter.toBlock);
  }
  return jsonRpcCall<RawLog[]>(rpcUrl, 'eth_getLogs', [params]);
}

/**
 * `eth_getLogs` wrapper that rethrows the richest available message on
 * failure. Without this, RPC failures surface as opaque errors from the
 * transport layer.
 */
const MAX_RETRIES = 8;
const BASE_BACKOFF_MS = 400;
const JITTER_MS = 600;

function extractErrorMessage(err: unknown): string {
  const e = err as {
    shortMessage?: string;
    message?: string;
    info?: { error?: { message?: string; code?: number } };
    error?: { message?: string; code?: number };
    errors?: Array<{ message?: string; shortMessage?: string }>;
  };
  return (
    e?.info?.error?.message ??
    e?.error?.message ??
    e?.errors?.[0]?.shortMessage ??
    e?.errors?.[0]?.message ??
    e?.shortMessage ??
    e?.message ??
    'unknown getLogs failure'
  );
}

function isRateLimitError(message: string): boolean {
  return (
    /compute units|throughput|rate limit|429|too many requests|exceeded.*capacity/i.test(message)
  );
}

/**
 * Provider rejected the call because the *shape* of the request is too big —
 * either the block range exceeds the plan's cap, or the matching log set
 * would exceed the response-size cap. Different error strings across
 * providers, same remediation: halve the chunk and retry.
 *
 * - Alchemy free:  "...up to a 10 block range..."
 * - Alchemy paid:  "Log response size exceeded..."
 * - Infura:        "query returned more than 10000 results"
 * - QuickNode:     "eth_getLogs is limited to a ... block range"
 */
function isBlockRangeOrSizeError(message: string): boolean {
  return /block range|range.*too (?:large|wide|big)|response size|query returned more than|too many (?:logs|results)/i.test(
    message,
  );
}

async function safeGetLogs(
  rpcUrl: string,
  filter: GetLogsFilter,
): Promise<RawLog[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await rawGetLogs(rpcUrl, filter);
    } catch (err) {
      const inner = extractErrorMessage(err);
      const retryable = isRateLimitError(inner);
      if (retryable && attempt < MAX_RETRIES) {
        // Exponential backoff with wide jitter. Alchemy CUPS resets per-second,
        // and concurrent scanners tend to retry in lockstep — wide jitter
        // breaks the herd. Schedule: ~0.4-1 / 0.8-1.4 / 1.6-2.2 / 3.2-3.8 / ...
        const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * JITTER_MS;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      console.error('[logIndex] getLogs failed', { filter, attempt, message: inner, raw: err });
      throw new Error(`getLogs ${filter.fromBlock}-${filter.toBlock}: ${inner}`);
    }
  }
  // Unreachable — loop always returns or throws.
  throw new Error(`getLogs ${filter.fromBlock}-${filter.toBlock}: exhausted retries`);
}

async function getBlockNumber(rpcUrl: string): Promise<number> {
  try {
    const hex = await jsonRpcCall<string>(rpcUrl, 'eth_blockNumber', []);
    return Number(hex);
  } catch {
    return 0;
  }
}

/**
 * In-flight scan promises keyed by (chainId, diamond). Multiple hooks on the
 * same page (`useProtocolStats`, `useUserStats`, `useRecentOffers`, …) all
 * call `loadLoanIndex` on mount — without this, each hook independently
 * paginates the same block range and the 5× amplification blows past
 * Alchemy's CUPS (compute-units-per-second) quota. Coalescing to one
 * in-flight scan per (chainId, diamond) is what keeps us under the cap.
 */
const inflight = new Map<string, Promise<LogIndexResult>>();

/**
 * Synchronous snapshot of the cached index without doing any RPC work.
 * Returns null when no cache entry exists for this (chainId, diamond).
 *
 * Callers use this to paint the UI instantly on mount with whatever the last
 * scan left behind, then kick off `loadLoanIndex` in the background to
 * refresh. Without this, every mount blocked on paginating `eth_getLogs`
 * from `cached.lastBlock + 1` up to head — which on a slow public RPC
 * (e.g. Sepolia's default) can stall the dashboard for tens of seconds on
 * return visits even when the cache is fully populated.
 */
export function peekLoanIndex(
  chainId: number,
  diamondAddress: string,
): LogIndexResult | null {
  const cached = readCache(chainId, diamondAddress);
  if (!cached) return null;
  return hydrate(cached);
}

/**
 * Paginated scan of `LoanInitiated` + `Transfer` logs, merged with the
 * cached snapshot. Returns the superset of known loans plus an
 * `ownerOf`-style lookup derived from the Transfer stream.
 *
 * Scans are deduplicated per (chainId, diamond): if a scan is already in
 * flight, concurrent callers subscribe to the same promise instead of
 * starting their own paging loop.
 */
export async function loadLoanIndex(
  rpcUrl: string,
  diamondAddress: string,
  deployBlock: number,
  chainId: number,
  /** Optional hint: the indexer's most-recent indexed block. When the
   *  indexer is healthy, the local log scan can fast-forward its
   *  `fromBlock` to this hint and skip the long history the indexer
   *  has already covered — typical scan window collapses to "indexer
   *  tail → safe head" (~60 s of blocks). The hint is ignored when
   *  it's behind the local cache's own cursor (i.e. the local scan
   *  has already gone further than the indexer). When no hint is
   *  given (indexer unreachable / disabled), behaviour matches the
   *  original cache-cursor-based incremental scan. */
  indexerLastBlockHint?: number,
): Promise<LogIndexResult> {
  const key = storageKey(chainId, diamondAddress);
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = runScan(
    rpcUrl,
    diamondAddress,
    deployBlock,
    chainId,
    indexerLastBlockHint,
  ).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

async function runScan(
  rpcUrl: string,
  diamondAddress: string,
  deployBlock: number,
  chainId: number,
  indexerLastBlockHint?: number,
): Promise<LogIndexResult> {
  const cached = readCache(chainId, diamondAddress) ?? emptyCache(deployBlock);
  const head = await getBlockNumber(rpcUrl);
  // Three-way max: deploy block (lower bound for any scan), the
  // local cache cursor (don't re-scan blocks we already cached), and
  // the indexer's lastBlock (skip the long history the indexer has
  // already covered when it's healthy). The indexer hint only fires
  // when it's strictly ahead of both other lower bounds — otherwise
  // the local cache holds richer information and we keep scanning
  // from there.
  const baseFrom = Math.max(cached.lastBlock + 1, deployBlock);
  const fromBlock =
    indexerLastBlockHint && indexerLastBlockHint + 1 > baseFrom
      ? indexerLastBlockHint + 1
      : baseFrom;

  if (fromBlock > head) return hydrate(cached);

  const merged = new Map<string, CachedShape['loans'][number]>();
  for (const row of cached.loans) merged.set(row.loanId, row);
  const owners: Record<string, string> = { ...cached.owners };
  const prevOwners: Record<string, string> = { ...(cached.prevOwners ?? {}) };
  const offerIdSet = new Set<string>(cached.offerIds);
  const closedOfferIdSet = new Set<string>(cached.closedOfferIds ?? []);
  let lastAcceptedOfferId: bigint | null = cached.lastAcceptedOfferId
    ? BigInt(cached.lastAcceptedOfferId)
    : null;
  // Oldest-first list during scan; trimmed to RECENT_ACCEPTED_CAP at write
  // time. Hydrated to newest-first on the public result.
  const recentAcceptedOfferIds: string[] = [
    ...(cached.recentAcceptedOfferIds ?? []),
  ];
  // (txHash, logIndex) → decoded ActivityEvent. Merged rather than appended so
  // repeated scans over the same block range don't double-count.
  const eventMap = new Map<string, ActivityEvent>();
  for (const ev of cached.events ?? []) {
    eventMap.set(`${ev.txHash}:${ev.logIndex}`, ev);
  }
  // txHash → list of position-NFT mints (from = 0x0) seen in this scan.
  // Used after the scan loop to attribute `lenderTokenId` / `borrowerTokenId`
  // onto each `LoanInitiated` event so burned-NFT lookups resolve purely
  // from the event index. Only mints from THIS scan are tracked; cached
  // LoanInitiated rows from a prior v2 scan won't get retro-attributed —
  // that's why the cache version is bumped (forcing one full rescan).
  const mintsByTx = new Map<string, Array<{ tokenId: string; to: string }>>();

  // Raw `eth_getLogs` via `publicClient.request` — viem's higher-level
  // `getLogs` requires ABI-typed `event`/`events`, but our filter here
  // OR's 15 different topic0 hashes in one request, which only the raw
  // topic-array filter form supports.
  //
  // `effectiveChunk` starts at the configured CHUNK and halves whenever the
  // provider rejects a chunk as too wide or too large a response. Sticky for
  // the rest of this scan — once we discover the provider's real cap there's
  // no point rediscovering it every chunk.
  let effectiveChunk = CHUNK;
  let cursor = fromBlock;

  while (cursor <= head) {
    const toBlock = Math.min(cursor + effectiveChunk - 1, head);

    // One `getLogs` per chunk with an OR'd topic0 array, dispatched below by
    // `topics[0]`. Cuts per-chunk call count from 5→1 and is supported by
    // every RPC that implements the JSON-RPC `eth_getLogs` spec (Alchemy,
    // Infura, QuickNode, publicnode, direct node RPCs).
    let logs: RawLog[];
    try {
      logs = await safeGetLogs(rpcUrl, {
        address: diamondAddress,
        topics: [
          [
            LOAN_INITIATED_TOPIC0,
            TRANSFER_TOPIC0,
            OFFER_CREATED_TOPIC0,
            OFFER_ACCEPTED_TOPIC0,
            OFFER_CANCELED_TOPIC0,
            // OFFER_CANCELED_DETAILS_TOPIC0 intentionally omitted from
            // the filter array. publicnode (and other free-tier RPCs)
            // silently return empty results when the topic OR-list
            // exceeds an internal cap (~24 entries observed). Adding
            // this topic pushed the array to 25 and broke event capture
            // for every event kind. The companion event isn't emitted
            // by any deployed Vaipakam Diamond on Sepolia today
            // (contract redeploy hasn't happened yet) so omitting it
            // costs nothing in practice. Re-add when (a) we move off
            // free-tier RPC OR (b) split into a second eth_getLogs
            // call. The decoder branch below stays in case logs of
            // this kind ever land via a wider scan.
            LOAN_REPAID_TOPIC0,
            LOAN_DEFAULTED_TOPIC0,
            LENDER_CLAIMED_TOPIC0,
            BORROWER_CLAIMED_TOPIC0,
            COLLATERAL_ADDED_TOPIC0,
            LOAN_SOLD_TOPIC0,
            LOAN_OBLIGATION_TRANSFERRED_TOPIC0,
            LOAN_SETTLEMENT_BREAKDOWN_TOPIC0,
            LIQUIDATION_FALLBACK_TOPIC0,
            LIQUIDATION_FALLBACK_SPLIT_TOPIC0,
            LOAN_SETTLED_TOPIC0,
            PARTIAL_REPAID_TOPIC0,
            CLAIM_RETRY_EXECUTED_TOPIC0,
            BORROWER_LIF_REBATE_CLAIMED_TOPIC0,
            STAKING_REWARDS_CLAIMED_TOPIC0,
            INTERACTION_REWARDS_CLAIMED_TOPIC0,
            VPFI_PURCHASED_TOPIC0,
            VPFI_DEPOSITED_TOPIC0,
            VPFI_WITHDRAWN_TOPIC0,
          ],
        ],
        fromBlock: cursor,
        toBlock,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isBlockRangeOrSizeError(msg) && effectiveChunk > 1) {
        const next = Math.max(1, Math.floor(effectiveChunk / 2));
        console.warn(
          `[logIndex] provider rejected ${effectiveChunk}-block chunk, downshifting to ${next}: ${msg}`,
        );
        effectiveChunk = next;
        continue; // retry same cursor with the smaller chunk
      }
      throw err;
    }

    // Small inter-chunk pause — keeps us under Alchemy free-tier CUPS without
    // relying purely on retry/backoff. ~30ms ≈ 30 chunks/sec.
    await new Promise((r) => setTimeout(r, 30));

    for (const event of logs) {
      const topics = event.topics;
      if (!topics || topics.length === 0) continue;
      const topic0 = topics[0];
      const eventKey = `${event.transactionHash}:${event.logIndex}`;
      const addEvent = (kind: ActivityEventKind, participants: string[], args: ActivityEvent['args']) => {
        eventMap.set(eventKey, {
          kind,
          blockNumber: Number(event.blockNumber),
          logIndex: Number(event.logIndex),
          txHash: event.transactionHash,
          participants: participants.filter((p) => p && p !== ZERO_ADDRESS).map((p) => p.toLowerCase()),
          args,
        });
      };

      if (topic0 === OFFER_CREATED_TOPIC0) {
        if (topics.length < 3) continue;
        const offerId = BigInt(topics[1]).toString();
        const creator = ('0x' + topics[2].slice(26)).toLowerCase();
        offerIdSet.add(offerId);
        let offerType = 0;
        try {
          const [t] = decodeAbiParameters(parseAbiParameters('uint8'), event.data);
          offerType = Number(t);
        } catch {
          // malformed — keep offerType default
        }
        addEvent('OfferCreated', [creator], { offerId, creator, offerType });
      } else if (topic0 === OFFER_ACCEPTED_TOPIC0) {
        if (topics.length < 3) continue;
        const offerId = BigInt(topics[1]);
        const acceptor = ('0x' + topics[2].slice(26)).toLowerCase();
        closedOfferIdSet.add(offerId.toString());
        lastAcceptedOfferId = offerId;
        recentAcceptedOfferIds.push(offerId.toString());
        let loanId = '0';
        try {
          const [l] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          loanId = (l as bigint).toString();
        } catch {
          // malformed — keep loanId default
        }
        addEvent('OfferAccepted', [acceptor], {
          offerId: offerId.toString(),
          acceptor,
          loanId,
        });
      } else if (topic0 === OFFER_CANCELED_TOPIC0) {
        if (topics.length < 3) continue;
        const offerId = BigInt(topics[1]).toString();
        const creator = ('0x' + topics[2].slice(26)).toLowerCase();
        closedOfferIdSet.add(offerId);
        addEvent('OfferCanceled', [creator], { offerId, creator });
      } else if (topic0 === OFFER_CANCELED_DETAILS_TOPIC0) {
        // Companion to OfferCanceled — same offer, but with the full
        // financial terms folded into args. Decoded so `useMyOffers`
        // can reconstruct cancelled-row detail without a per-create
        // localStorage snapshot. `OfferCanceled` already added the
        // id to closedOfferIdSet on the prior iteration; this branch
        // is purely additive (event-kind-only, no extra index keys).
        if (topics.length < 3) continue;
        const offerId = BigInt(topics[1]).toString();
        const creator = ('0x' + topics[2].slice(26)).toLowerCase();
        try {
          const [
            offerType,
            assetType,
            lendingAsset,
            amount,
            tokenId,
            collateralAsset,
            collateralAmount,
            interestRateBps,
            durationDays,
          ] = decodeAbiParameters(
            parseAbiParameters(
              'uint8, uint8, address, uint256, uint256, address, uint256, uint256, uint256',
            ),
            event.data,
          );
          addEvent('OfferCanceledDetails', [creator], {
            offerId,
            creator,
            offerType: (offerType as number).toString(),
            assetType: (assetType as number).toString(),
            lendingAsset: (lendingAsset as string).toLowerCase(),
            amount: (amount as bigint).toString(),
            tokenId: (tokenId as bigint).toString(),
            collateralAsset: (collateralAsset as string).toLowerCase(),
            collateralAmount: (collateralAmount as bigint).toString(),
            interestRateBps: (interestRateBps as bigint).toString(),
            durationDays: (durationDays as bigint).toString(),
          });
        } catch {
          // Malformed payload — fall back to the bare OfferCanceled
          // entry already recorded; the cancelled row renders compact.
        }
      } else if (topic0 === LOAN_INITIATED_TOPIC0) {
        if (topics.length < 4) continue;
        // LoanInitiated(loanId indexed, offerId indexed, lender indexed,
        //               borrower, principal, collateralAmount)
        const loanId = BigInt(topics[1]).toString();
        const offerId = BigInt(topics[2]).toString();
        const lender = ('0x' + topics[3].slice(26)).toLowerCase();
        let borrower = ZERO_ADDRESS;
        let principal = '0';
        let collateralAmount = '0';
        try {
          const [b, p, c] = decodeAbiParameters(parseAbiParameters('address, uint256, uint256'), event.data);
          borrower = (b as string).toLowerCase();
          principal = (p as bigint).toString();
          collateralAmount = (c as bigint).toString();
        } catch {
          // Malformed data — skip decode but keep the row.
        }
        merged.set(loanId, { loanId, lender, borrower });
        addEvent('LoanInitiated', [lender, borrower], {
          loanId,
          offerId,
          lender,
          borrower,
          principal,
          collateralAmount,
        });
      } else if (topic0 === LOAN_REPAID_TOPIC0) {
        if (topics.length < 3) continue;
        const loanId = BigInt(topics[1]).toString();
        const repayer = ('0x' + topics[2].slice(26)).toLowerCase();
        let interestPaid = '0';
        let lateFeePaid = '0';
        try {
          const [i, l] = decodeAbiParameters(parseAbiParameters('uint256, uint256'), event.data);
          interestPaid = (i as bigint).toString();
          lateFeePaid = (l as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('LoanRepaid', [repayer], { loanId, repayer, interestPaid, lateFeePaid });
      } else if (topic0 === LOAN_DEFAULTED_TOPIC0) {
        if (topics.length < 2) continue;
        const loanId = BigInt(topics[1]).toString();
        let fallbackConsentFromBoth = false;
        try {
          const [b] = decodeAbiParameters(parseAbiParameters('bool'), event.data);
          fallbackConsentFromBoth = Boolean(b);
        } catch {
          // malformed — keep default
        }
        // No indexed user on this event — participants populated later by the
        // UI from the known lender/borrower of `loanId`. Store without
        // participants so the Activity filter still catches it via the loan
        // lookup path.
        addEvent('LoanDefaulted', [], { loanId, fallbackConsentFromBoth });
      } else if (topic0 === LENDER_CLAIMED_TOPIC0) {
        if (topics.length < 3) continue;
        const loanId = BigInt(topics[1]).toString();
        const claimant = ('0x' + topics[2].slice(26)).toLowerCase();
        let asset = ZERO_ADDRESS;
        let amount = '0';
        try {
          const [a, am] = decodeAbiParameters(parseAbiParameters('address, uint256'), event.data);
          asset = (a as string).toLowerCase();
          amount = (am as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('LenderFundsClaimed', [claimant], { loanId, claimant, asset, amount });
      } else if (topic0 === BORROWER_CLAIMED_TOPIC0) {
        if (topics.length < 3) continue;
        const loanId = BigInt(topics[1]).toString();
        const claimant = ('0x' + topics[2].slice(26)).toLowerCase();
        let asset = ZERO_ADDRESS;
        let amount = '0';
        try {
          const [a, am] = decodeAbiParameters(parseAbiParameters('address, uint256'), event.data);
          asset = (a as string).toLowerCase();
          amount = (am as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('BorrowerFundsClaimed', [claimant], { loanId, claimant, asset, amount });
      } else if (topic0 === LOAN_SOLD_TOPIC0) {
        if (topics.length < 4) continue;
        const loanId = BigInt(topics[1]).toString();
        const originalLender = ('0x' + topics[2].slice(26)).toLowerCase();
        const newLender = ('0x' + topics[3].slice(26)).toLowerCase();
        let shortfallPaid = '0';
        try {
          const [s] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          shortfallPaid = (s as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('LoanSold', [originalLender, newLender], {
          loanId,
          originalLender,
          newLender,
          shortfallPaid,
        });
      } else if (topic0 === LOAN_OBLIGATION_TRANSFERRED_TOPIC0) {
        if (topics.length < 4) continue;
        const loanId = BigInt(topics[1]).toString();
        const originalBorrower = ('0x' + topics[2].slice(26)).toLowerCase();
        const newBorrower = ('0x' + topics[3].slice(26)).toLowerCase();
        let shortfallPaid = '0';
        try {
          const [s] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          shortfallPaid = (s as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('LoanObligationTransferred', [originalBorrower, newBorrower], {
          loanId,
          originalBorrower,
          newBorrower,
          shortfallPaid,
        });
      } else if (topic0 === COLLATERAL_ADDED_TOPIC0) {
        if (topics.length < 3) continue;
        const loanId = BigInt(topics[1]).toString();
        const borrower = ('0x' + topics[2].slice(26)).toLowerCase();
        let amountAdded = '0';
        let newCollateralAmount = '0';
        try {
          const [a, n] = decodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256'), event.data);
          amountAdded = (a as bigint).toString();
          newCollateralAmount = (n as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('CollateralAdded', [borrower], {
          loanId,
          borrower,
          amountAdded,
          newCollateralAmount,
        });
      } else if (topic0 === VPFI_PURCHASED_TOPIC0) {
        // VPFIPurchasedWithETH(buyer indexed, vpfiAmount, ethAmount)
        if (topics.length < 2) continue;
        const buyer = ('0x' + topics[1].slice(26)).toLowerCase();
        let vpfiAmount = '0';
        let ethAmount = '0';
        try {
          const [v, e] = decodeAbiParameters(parseAbiParameters('uint256, uint256'), event.data);
          vpfiAmount = (v as bigint).toString();
          ethAmount = (e as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('VPFIPurchasedWithETH', [buyer], {
          buyer,
          vpfiAmount,
          ethAmount,
        });
      } else if (topic0 === VPFI_DEPOSITED_TOPIC0) {
        // VPFIDepositedToEscrow(user indexed, amount)
        if (topics.length < 2) continue;
        const user = ('0x' + topics[1].slice(26)).toLowerCase();
        let amount = '0';
        try {
          const [a] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          amount = (a as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('VPFIDepositedToEscrow', [user], { user, amount });
      } else if (topic0 === VPFI_WITHDRAWN_TOPIC0) {
        // VPFIWithdrawnFromEscrow(user indexed, amount)
        if (topics.length < 2) continue;
        const user = ('0x' + topics[1].slice(26)).toLowerCase();
        let amount = '0';
        try {
          const [a] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          amount = (a as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('VPFIWithdrawnFromEscrow', [user], { user, amount });
      } else if (topic0 === LOAN_SETTLEMENT_BREAKDOWN_TOPIC0) {
        // LoanSettlementBreakdown(loanId indexed, principal, interest,
        // lateFee, treasuryShare, lenderShare). Source-of-truth for the
        // proper-close five-line breakdown rendered on the Loan Details
        // timeline. No participants — surface anyone who can see the loan.
        if (topics.length < 2) continue;
        const loanId = BigInt(topics[1]).toString();
        let principal = '0';
        let interest = '0';
        let lateFee = '0';
        let treasuryShare = '0';
        let lenderShare = '0';
        try {
          const [p, i, l, t, ls] = decodeAbiParameters(
            parseAbiParameters('uint256, uint256, uint256, uint256, uint256'),
            event.data,
          );
          principal = (p as bigint).toString();
          interest = (i as bigint).toString();
          lateFee = (l as bigint).toString();
          treasuryShare = (t as bigint).toString();
          lenderShare = (ls as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('LoanSettlementBreakdown', [], {
          loanId,
          principal,
          interest,
          lateFee,
          treasuryShare,
          lenderShare,
        });
      } else if (topic0 === LIQUIDATION_FALLBACK_TOPIC0) {
        // LiquidationFallback(loanId indexed, lender indexed, collateralAmount)
        if (topics.length < 3) continue;
        const loanId = BigInt(topics[1]).toString();
        const lender = ('0x' + topics[2].slice(26)).toLowerCase();
        let collateralAmount = '0';
        try {
          const [c] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          collateralAmount = (c as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('LiquidationFallback', [lender], {
          loanId,
          lender,
          collateralAmount,
        });
      } else if (topic0 === LIQUIDATION_FALLBACK_SPLIT_TOPIC0) {
        // LiquidationFallbackSplit(loanId indexed, lenderCol, treasuryCol, borrowerCol)
        if (topics.length < 2) continue;
        const loanId = BigInt(topics[1]).toString();
        let lenderCollateral = '0';
        let treasuryCollateral = '0';
        let borrowerCollateral = '0';
        try {
          const [l, t, b] = decodeAbiParameters(
            parseAbiParameters('uint256, uint256, uint256'),
            event.data,
          );
          lenderCollateral = (l as bigint).toString();
          treasuryCollateral = (t as bigint).toString();
          borrowerCollateral = (b as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('LiquidationFallbackSplit', [], {
          loanId,
          lenderCollateral,
          treasuryCollateral,
          borrowerCollateral,
        });
      } else if (topic0 === LOAN_SETTLED_TOPIC0) {
        // LoanSettled(loanId indexed) — both sides claimed; loan is final.
        if (topics.length < 2) continue;
        const loanId = BigInt(topics[1]).toString();
        addEvent('LoanSettled', [], { loanId });
      } else if (topic0 === PARTIAL_REPAID_TOPIC0) {
        // PartialRepaid(loanId indexed, amountRepaid, newPrincipal)
        if (topics.length < 2) continue;
        const loanId = BigInt(topics[1]).toString();
        let amountRepaid = '0';
        let newPrincipal = '0';
        try {
          const [a, n] = decodeAbiParameters(
            parseAbiParameters('uint256, uint256'),
            event.data,
          );
          amountRepaid = (a as bigint).toString();
          newPrincipal = (n as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('PartialRepaid', [], {
          loanId,
          amountRepaid,
          newPrincipal,
        });
      } else if (topic0 === CLAIM_RETRY_EXECUTED_TOPIC0) {
        // ClaimRetryExecuted(loanId indexed, succeeded, proceeds)
        if (topics.length < 2) continue;
        const loanId = BigInt(topics[1]).toString();
        let succeeded = false;
        let proceeds = '0';
        try {
          const [s, p] = decodeAbiParameters(
            parseAbiParameters('bool, uint256'),
            event.data,
          );
          succeeded = s as boolean;
          proceeds = (p as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('ClaimRetryExecuted', [], {
          loanId,
          succeeded,
          proceeds,
        });
      } else if (topic0 === BORROWER_LIF_REBATE_CLAIMED_TOPIC0) {
        // BorrowerLifRebateClaimed(loanId indexed, claimant indexed, amount)
        if (topics.length < 3) continue;
        const loanId = BigInt(topics[1]).toString();
        const claimant = ('0x' + topics[2].slice(26)).toLowerCase();
        let amount = '0';
        try {
          const [a] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          amount = (a as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('BorrowerLifRebateClaimed', [claimant], {
          loanId,
          claimant,
          amount,
        });
      } else if (topic0 === STAKING_REWARDS_CLAIMED_TOPIC0) {
        // StakingRewardsClaimed(user indexed, amount). Per-user, no loanId.
        if (topics.length < 2) continue;
        const user = ('0x' + topics[1].slice(26)).toLowerCase();
        let amount = '0';
        try {
          const [a] = decodeAbiParameters(parseAbiParameters('uint256'), event.data);
          amount = (a as bigint).toString();
        } catch {
          // malformed — keep default
        }
        addEvent('StakingRewardsClaimed', [user], { user, amount });
      } else if (topic0 === INTERACTION_REWARDS_CLAIMED_TOPIC0) {
        // InteractionRewardsClaimed(user indexed, fromDay, toDay, amount).
        // Drives the lifetime-claimed total surfaced on the Claim Center
        // interaction-rewards card — frontend sums `amount` across every
        // matching event for the user.
        if (topics.length < 2) continue;
        const user = ('0x' + topics[1].slice(26)).toLowerCase();
        let fromDay = '0';
        let toDay = '0';
        let amount = '0';
        try {
          const [f, t, a] = decodeAbiParameters(
            parseAbiParameters('uint256, uint256, uint256'),
            event.data,
          );
          fromDay = (f as bigint).toString();
          toDay = (t as bigint).toString();
          amount = (a as bigint).toString();
        } catch {
          // malformed — keep defaults
        }
        addEvent('InteractionRewardsClaimed', [user], {
          user,
          fromDay,
          toDay,
          amount,
        });
      } else if (topic0 === TRANSFER_TOPIC0) {
        // ERC-721 Transfer(from, to, tokenId) — all three fields indexed, so
        // topics[1..3] carry from / to / tokenId. Rows with a different topic
        // layout (e.g. ERC-20 Transfer where value isn't indexed) are skipped.
        if (topics.length < 4) continue;
        const from = ('0x' + topics[1].slice(26)).toLowerCase();
        const to = ('0x' + topics[2].slice(26)).toLowerCase();
        const tokenId = BigInt(topics[3]).toString();
        // Burn: capture the owner right before burn so the Verifier can show
        // the last known holder of a burned position NFT. We read `from` from
        // the event itself rather than `owners[tokenId]` so cache-merge
        // ordering doesn't matter.
        if (to === ZERO_ADDRESS && from !== ZERO_ADDRESS) {
          prevOwners[tokenId] = from;
        }
        owners[tokenId] = to;
        // Mint (from == 0x0) records the tokenId under its tx for later
        // correlation with the LoanInitiated event in the same tx.
        if (from === ZERO_ADDRESS) {
          const txHash = event.transactionHash;
          const entry = { tokenId, to };
          const list = mintsByTx.get(txHash);
          if (list) list.push(entry);
          else mintsByTx.set(txHash, [entry]);
        }
      }
    }

    cursor = toBlock + 1;
  }

  // Attribute the acceptor-side mint tokenId onto each `LoanInitiated` event
  // via tx-hash correlation. Only the acceptor's NFT is minted in the
  // `initiateLoan` tx — the creator's NFT was minted earlier when the offer
  // was created, so creator-side attribution happens against `OfferCreated`
  // below. Events already carrying both IDs (from a prior scan) are skipped.
  for (const ev of eventMap.values()) {
    if (ev.kind !== 'LoanInitiated') continue;
    if (typeof ev.args.lenderTokenId === 'string' && typeof ev.args.borrowerTokenId === 'string') {
      continue;
    }
    const mints = mintsByTx.get(ev.txHash);
    if (!mints || mints.length === 0) continue;
    const lender = String(ev.args.lender ?? '').toLowerCase();
    const borrower = String(ev.args.borrower ?? '').toLowerCase();
    for (const mint of mints) {
      if (mint.to === lender && typeof ev.args.lenderTokenId !== 'string') {
        ev.args.lenderTokenId = mint.tokenId;
      } else if (mint.to === borrower && typeof ev.args.borrowerTokenId !== 'string') {
        ev.args.borrowerTokenId = mint.tokenId;
      }
    }
  }

  // Attribute the creator-side mint tokenId onto each `OfferCreated` event.
  // `OfferFacet.createOffer` mints the creator's position NFT in the same tx
  // as `OfferCreated`, so the single mint in `mintsByTx[txHash]` whose `to`
  // matches the creator resolves tokenId → offerId. Hydrate joins this with
  // `LoanInitiated.offerId` to map a burned creator-side tokenId to its loan.
  for (const ev of eventMap.values()) {
    if (ev.kind !== 'OfferCreated') continue;
    if (typeof ev.args.offerCreatorTokenId === 'string') continue;
    const mints = mintsByTx.get(ev.txHash);
    if (!mints || mints.length === 0) continue;
    const creator = String(ev.args.creator ?? '').toLowerCase();
    for (const mint of mints) {
      if (mint.to === creator) {
        ev.args.offerCreatorTokenId = mint.tokenId;
        break;
      }
    }
  }

  // Attribute the migrated-position mint tokenId onto each `LoanSold` /
  // `LoanObligationTransferred` event. Migration flows burn the original
  // position NFT and mint a fresh LoanInitiated-status NFT to the new
  // counterparty in the same tx; the mint in `mintsByTx[txHash]` whose `to`
  // matches `newLender` / `newBorrower` resolves to the new tokenId.
  for (const ev of eventMap.values()) {
    if (ev.kind === 'LoanSold') {
      if (typeof ev.args.newLenderTokenId === 'string') continue;
      const mints = mintsByTx.get(ev.txHash);
      if (!mints || mints.length === 0) continue;
      const newLender = String(ev.args.newLender ?? '').toLowerCase();
      for (const mint of mints) {
        if (mint.to === newLender) {
          ev.args.newLenderTokenId = mint.tokenId;
          break;
        }
      }
    } else if (ev.kind === 'LoanObligationTransferred') {
      if (typeof ev.args.newBorrowerTokenId === 'string') continue;
      const mints = mintsByTx.get(ev.txHash);
      if (!mints || mints.length === 0) continue;
      const newBorrower = String(ev.args.newBorrower ?? '').toLowerCase();
      for (const mint of mints) {
        if (mint.to === newBorrower) {
          ev.args.newBorrowerTokenId = mint.tokenId;
          break;
        }
      }
    }
  }

  const sortedEvents = Array.from(eventMap.values()).sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });
  const next: CachedShape = {
    lastBlock: head,
    loans: Array.from(merged.values()).sort(
      (a, b) => Number(BigInt(a.loanId) - BigInt(b.loanId)),
    ),
    owners,
    prevOwners,
    offerIds: Array.from(offerIdSet).sort((a, b) => Number(BigInt(a) - BigInt(b))),
    closedOfferIds: Array.from(closedOfferIdSet).sort((a, b) => Number(BigInt(a) - BigInt(b))),
    lastAcceptedOfferId: lastAcceptedOfferId ? lastAcceptedOfferId.toString() : null,
    // Trim to the trailing RECENT_ACCEPTED_CAP (most recent), preserving
    // oldest-first scan order so the cache stays append-friendly across
    // incremental scans.
    recentAcceptedOfferIds: recentAcceptedOfferIds.slice(-RECENT_ACCEPTED_CAP),
    events: sortedEvents,
  };
  writeCache(chainId, diamondAddress, next);
  return hydrate(next);
}

function hydrate(cached: CachedShape): LogIndexResult {
  const loans = cached.loans.map((r) => ({
    loanId: BigInt(r.loanId),
    lender: r.lender,
    borrower: r.borrower,
  }));
  const owners = cached.owners;
  const prevOwners = cached.prevOwners ?? {};
  const offerIds = cached.offerIds.map((s) => BigInt(s));
  const closedRaw = cached.closedOfferIds ?? [];
  const closed = new Set(closedRaw);
  const openOfferIds = cached.offerIds
    .filter((s) => !closed.has(s))
    .map((s) => BigInt(s));
  const closedOfferIds = closedRaw
    .map((s) => BigInt(s))
    .sort((a, b) => Number(a - b));
  const lastAcceptedOfferId = cached.lastAcceptedOfferId
    ? BigInt(cached.lastAcceptedOfferId)
    : null;
  // Cache stores oldest-first; expose newest-first so callers can do
  // `recentAcceptedOfferIds.find(...)` to get the freshest match.
  const recentAcceptedOfferIds = (cached.recentAcceptedOfferIds ?? [])
    .slice()
    .reverse()
    .map((s) => BigInt(s));
  const events = cached.events ?? [];
  // tokenId (decimal string) → attributed `LoanInitiated` event + role. Built
  // once on hydrate so lookups are O(1). Two attribution paths:
  //   - Acceptor side: `lenderTokenId`/`borrowerTokenId` on LoanInitiated
  //     (mint in the initiateLoan tx).
  //   - Creator side: join `offerCreatorTokenId` on OfferCreated with the
  //     matching LoanInitiated.offerId, then pick lender/borrower by
  //     comparing creator against LoanInitiated.lender.
  const offerCreatorToken = new Map<
    string,
    { tokenId: string; creator: string }
  >();
  for (const ev of events) {
    if (ev.kind !== 'OfferCreated') continue;
    if (typeof ev.args.offerCreatorTokenId !== 'string') continue;
    const offerId =
      typeof ev.args.offerId === 'string' ? ev.args.offerId : String(ev.args.offerId ?? '');
    const creator = String(ev.args.creator ?? '').toLowerCase();
    offerCreatorToken.set(offerId, {
      tokenId: ev.args.offerCreatorTokenId,
      creator,
    });
  }

  const tokenToLoan = new Map<
    string,
    { loanId: string; role: 'lender' | 'borrower'; event: ActivityEvent }
  >();
  for (const ev of events) {
    if (ev.kind !== 'LoanInitiated') continue;
    const loanId = typeof ev.args.loanId === 'string' ? ev.args.loanId : String(ev.args.loanId ?? '');
    const offerId =
      typeof ev.args.offerId === 'string' ? ev.args.offerId : String(ev.args.offerId ?? '');
    const lender = String(ev.args.lender ?? '').toLowerCase();
    if (typeof ev.args.lenderTokenId === 'string') {
      tokenToLoan.set(ev.args.lenderTokenId, { loanId, role: 'lender', event: ev });
    }
    if (typeof ev.args.borrowerTokenId === 'string') {
      tokenToLoan.set(ev.args.borrowerTokenId, { loanId, role: 'borrower', event: ev });
    }
    // Creator-side tokenId — minted in the offer's creation tx, not here.
    const creatorMint = offerCreatorToken.get(offerId);
    if (creatorMint && !tokenToLoan.has(creatorMint.tokenId)) {
      const role: 'lender' | 'borrower' =
        creatorMint.creator === lender ? 'lender' : 'borrower';
      tokenToLoan.set(creatorMint.tokenId, { loanId, role, event: ev });
    }
  }
  // Migration-mint tokens: each migration burns the prior counterparty NFT
  // and mints a replacement, so the new tokenId needs an independent entry
  // in the tokenToLoan map (the prior tokenId is already covered above).
  for (const ev of events) {
    if (ev.kind === 'LoanSold' && typeof ev.args.newLenderTokenId === 'string') {
      const loanId =
        typeof ev.args.loanId === 'string' ? ev.args.loanId : String(ev.args.loanId ?? '');
      if (!tokenToLoan.has(ev.args.newLenderTokenId)) {
        tokenToLoan.set(ev.args.newLenderTokenId, { loanId, role: 'lender', event: ev });
      }
    } else if (
      ev.kind === 'LoanObligationTransferred' &&
      typeof ev.args.newBorrowerTokenId === 'string'
    ) {
      const loanId =
        typeof ev.args.loanId === 'string' ? ev.args.loanId : String(ev.args.loanId ?? '');
      if (!tokenToLoan.has(ev.args.newBorrowerTokenId)) {
        tokenToLoan.set(ev.args.newBorrowerTokenId, {
          loanId,
          role: 'borrower',
          event: ev,
        });
      }
    }
  }

  // Build offerId → terminal status so creator-side burned tokens can still
  // surface "this was a canceled offer" in the Verifier. Covers the token-9
  // shape: offer was created (mint) → offer canceled (burn) with no loan ever
  // initiated, so tokenToLoan never gets populated.
  const offerStatus = new Map<string, 'accepted' | 'canceled'>();
  for (const ev of events) {
    if (ev.kind !== 'OfferAccepted' && ev.kind !== 'OfferCanceled') continue;
    const offerId =
      typeof ev.args.offerId === 'string' ? ev.args.offerId : String(ev.args.offerId ?? '');
    offerStatus.set(offerId, ev.kind === 'OfferAccepted' ? 'accepted' : 'canceled');
  }
  const tokenToOfferCtx = new Map<
    string,
    {
      offerId: string;
      creator: string;
      status: 'accepted' | 'canceled' | 'open';
      event: ActivityEvent;
    }
  >();
  for (const ev of events) {
    if (ev.kind !== 'OfferCreated') continue;
    if (typeof ev.args.offerCreatorTokenId !== 'string') continue;
    const offerId =
      typeof ev.args.offerId === 'string' ? ev.args.offerId : String(ev.args.offerId ?? '');
    const creator = String(ev.args.creator ?? '').toLowerCase();
    tokenToOfferCtx.set(ev.args.offerCreatorTokenId, {
      offerId,
      creator,
      status: offerStatus.get(offerId) ?? 'open',
      event: ev,
    });
  }
  return {
    loans,
    offerIds,
    openOfferIds,
    closedOfferIds,
    lastAcceptedOfferId,
    recentAcceptedOfferIds,
    events,
    getOwner: (tokenId: bigint) => {
      const hit = owners[tokenId.toString()];
      if (!hit) return null;
      // A burned NFT (Transfer to zero) is modeled as "no owner" so callers
      // don't accidentally credit claims to the zero address.
      if (hit === ZERO_ADDRESS) return null;
      return hit;
    },
    getLastOwner: (tokenId: bigint) => owners[tokenId.toString()] ?? null,
    getPreviousOwner: (tokenId: bigint) => prevOwners[tokenId.toString()] ?? null,
    getLoanInitiatedForToken: (tokenId: bigint) => tokenToLoan.get(tokenId.toString()) ?? null,
    getOfferForToken: (tokenId: bigint) => tokenToOfferCtx.get(tokenId.toString()) ?? null,
  };
}

/**
 * Test-only: wipes the cached index so subsequent calls refetch from
 * `deployBlock`. Not used in app code.
 */
export function _resetLogIndexCache(chainId: number, diamond: string): void {
  try {
    localStorage.removeItem(storageKey(chainId, diamond));
  } catch {
    // ignore
  }
}
