/**
 * T-041 — unified chain indexer Worker module.
 *
 * Each cron tick performs ONE `getContractEvents` pass across the
 * full event allow-list, then dispatches the decoded logs to per-
 * domain handlers. Per-domain detail refreshes (`getOfferDetails`,
 * `getLoanDetails`, etc.) run separately, batched per tick. All
 * handlers share a single cursor (`kind='diamond'`) so a freshly
 * added domain in a later phase doesn't re-scan blocks that the
 * offer handler already paged through.
 *
 * Phase split:
 *   - Phase A (this commit): offers.
 *   - Phase B: loans + activity events. Adds `processLoanLogs`
 *              alongside `processOfferLogs`. Cross-domain reuse:
 *              loan rows JOIN to the offers table for asset
 *              metadata (lendingAsset, collateralAsset, durations)
 *              instead of re-fetching the offer struct.
 *   - Phase C: NFT lifecycle (Transfer events from VaipakamNFTFacet).
 *   - Phase D: VPFI deposit/withdraw history.
 *   - Phase E: claimables view derived from Phase B's terminal events.
 *
 * Frontend reads via `/offers/...`, `/loans/...`, `/activity`, etc.
 * REST endpoints in `index.ts`. The browser's existing
 * `lib/logIndex.ts` stays as fallback — the worker is a CACHE, not
 * an oracle.
 *
 * Per-chain scope: the worker only indexes the chain whose RPC is
 * configured. Multi-chain coverage will fan out across configured
 * RPCs in a follow-up — schema PKs already include `chain_id`.
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import type { Env, ChainConfig } from './env';
import { getChainConfigs } from './env';
import { getDeployment } from './deployments';
import { DIAMOND_OFFER_DETAILS_ABI, DIAMOND_LOAN_DETAILS_ABI } from './diamondAbi';

/** Resolve a chain's deployBlock from the consolidated deployments
 *  JSON — the indexer's first-run fallback when no cursor exists. */
function getDeployBlock(chainId: number): number | undefined {
  return getDeployment(chainId)?.deployBlock;
}

/** Combined event allow-list — all events any domain handler in this
 *  module wants to consume. ONE `getContractEvents` call covers the
 *  whole set per scan window so a new handler can be added without
 *  another RPC round trip per tick. Same shape as the frontend's
 *  `lib/logIndex.ts` allow-list. */
const EVENT_ABI = parseAbi([
  // Phase A — offers
  'event OfferCreated(uint256 indexed offerId, address indexed creator, uint8 offerType)',
  'event OfferAccepted(uint256 indexed offerId, address indexed acceptor, uint256 loanId)',
  'event OfferCanceled(uint256 indexed offerId, address indexed creator)',
  // Phase B — loan lifecycle
  'event LoanInitiated(uint256 indexed loanId, uint256 indexed offerId, address indexed lender, address borrower, uint256 principal, uint256 collateralAmount)',
  'event LoanRepaid(uint256 indexed loanId, address indexed repayer, uint256 interestPaid, uint256 lateFeePaid)',
  'event PartialRepaid(uint256 indexed loanId, uint256 amountRepaid, uint256 newPrincipal)',
  'event LoanDefaulted(uint256 indexed loanId, bool fallbackConsentFromBoth)',
  'event LoanLiquidated(uint256 indexed loanId, uint256 proceeds, uint256 treasuryFee)',
  'event LoanSettlementBreakdown(uint256 indexed loanId, uint256 principal, uint256 interest, uint256 lateFee, uint256 treasuryShare, uint256 lenderShare)',
  // Phase D — VPFI history. Captured into the unified activity
  // ledger; no per-domain table. The frontend's VPFIPanel hits
  // `/activity?actor=<wallet>&kind=VPFIDepositedToEscrow` etc.
  'event VPFIDepositedToEscrow(address indexed user, uint256 amount)',
  'event VPFIWithdrawnFromEscrow(address indexed user, uint256 amount)',
  'event VPFIPurchasedWithETH(address indexed buyer, uint256 vpfiAmount, uint256 ethAmount)',
  // Phase E — claim activity. `loans.status` already covers terminal
  // state; what `claimables/:addr` needs is "did this wallet's claim
  // event fire yet?" — answered by filtering activity_events.
  'event LenderFundsClaimed(uint256 indexed loanId, address indexed claimant, address asset, uint256 amount)',
  'event BorrowerFundsClaimed(uint256 indexed loanId, address indexed claimant, address asset, uint256 amount)',
  'event LoanSettled(uint256 indexed loanId)',
  'event BorrowerLifRebateClaimed(uint256 indexed loanId, address indexed claimant, uint256 amount)',
  // T-034 PR2 — Periodic Interest Payment lifecycle. PeriodicInterestSettled
  // (just-stamp + repay-fold inline advance) + AutoLiquidated (collateral
  // sale) advance the on-chain `lastPeriodicInterestSettledAt`; the
  // watcher mirrors that into the `loans` table so the pre-notify
  // cron lane can compute the next checkpoint without re-reading the
  // loan struct on every pass. SlippageOverBuffer is informational
  // (off-chain monitors aggregate it). RepayPartialPeriodAdvanced
  // pairs with PeriodicInterestSettled when the borrower's voluntary
  // repayment crossed a period boundary inline.
  'event PeriodicInterestSettled(uint256 indexed loanId, uint256 periodEndAt, uint256 expected, uint256 paidByBorrower, address indexed settler)',
  'event PeriodicInterestAutoLiquidated(uint256 indexed loanId, uint256 periodEndAt, uint256 shortfall, uint256 collateralSold, uint256 lenderProceeds, uint256 settlerBonus, uint256 treasuryShare, address indexed settler)',
  'event PeriodicSlippageOverBuffer(uint256 indexed loanId, uint256 expectedShortfall, uint256 actualLenderProceeds)',
  'event RepayPartialPeriodAdvanced(uint256 indexed loanId, uint256 periodEndAt, uint256 expected, address indexed advancedBy)',
  // Position-NFT lifecycle. Standard ERC-721 Transfer covers mint
  // (from = 0x0), trade (between holders), and burn (to = 0x0).
  // Captured into activity_events for the public audit trail of
  // ownership changes — there's no separate nft_positions table, the
  // current owner is queried live via ownerOf at /loans/by-lender etc.
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

const SCAN_LOOKBACK_BLOCKS = 500n;
const MAX_RANGE_PER_CALL = 5_000n;
const DETAILS_REFRESH_BATCH = 50;

/** Single shared cursor across every domain handler. Adding a new
 *  domain in Phase B+ does NOT add a new cursor row — every handler
 *  consumes the same scan window. */
const CURSOR_KIND = 'diamond';

/** Conservative reorg-horizon buffer used when an RPC doesn't support
 *  the `safe` block tag. Ethereum's exact finality is 32 blocks; L2s
 *  (Base / Arb / OP / Polygon zkEVM) settle well within ~10. 32 covers
 *  every chain we ship on with a comfortable margin. */
const SAFE_FALLBACK_BUFFER = 32n;

interface ChainIndexerResult {
  chainId?: number;
  scannedFrom: bigint;
  scannedTo: bigint;
  newOffers: number;
  statusUpdates: number;
  detailRefreshes: number;
  newLoans: number;
  loanStatusUpdates: number;
  activityEvents: number;
  skipped?: string;
}

/**
 * Top-level entry — fans out across every configured chain in one
 * cron tick. Each chain's pass is independent (its own cursor + per-
 * chain RPC client), and a failure on one chain doesn't wedge the
 * others. Single-worker for now per the user's call; future scaling
 * = one worker per chain (no schema changes needed — `chain_id` PK
 * already keys every table).
 */
export async function runChainIndexer(env: Env): Promise<ChainIndexerResult[]> {
  const chains = getChainConfigs(env);
  const results: ChainIndexerResult[] = [];
  for (const chain of chains) {
    try {
      const r = await runChainIndexerForChain(env, chain);
      results.push(r);
    } catch (err) {
      console.error(`[chainIndexer] chain ${chain.id} failed`, err);
      results.push({ ...emptyResult('chain-error'), chainId: chain.id });
    }
  }
  return results;
}

async function runChainIndexerForChain(
  env: Env,
  chain: ChainConfig,
): Promise<ChainIndexerResult> {
  const chainId = chain.id;
  const diamond = chain.diamond as Address;
  // Each chain has its own deployBlock; resolved via getChainConfigs
  // → deployments.json. We re-look it up here because ChainConfig
  // intentionally exposes only the runtime essentials.
  const deployBlock = BigInt(getDeployBlock(chainId) ?? 0);

  const client = createPublicClient({ transport: http(chain.rpc) });
  // Use the safe-tag head, NOT latest. Caching events from the unsafe
  // tip would mean a 1- to 32-block reorg could remove a block whose
  // OfferAccepted / LoanInitiated we already wrote to D1, and the next
  // cron run (resuming from `cursor + 1`) would skip the reorged
  // block, leaving the stale row in D1 forever. Reading at the safe
  // head keeps the cursor reorg-proof — by the time a block is
  // safe-tagged its reorg horizon is past. Falls back to
  // `latest - SAFE_FALLBACK_BUFFER` when the RPC doesn't support the
  // safe tag (older nodes / some private RPCs).
  let head: bigint;
  try {
    const safeBlock = await client.getBlock({ blockTag: 'safe' });
    head = safeBlock.number;
  } catch {
    const latest = await client.getBlockNumber();
    head = latest > SAFE_FALLBACK_BUFFER ? latest - SAFE_FALLBACK_BUFFER : 0n;
  }

  // Resume cursor: last block we successfully processed. On first
  // run, start from deployBlock — but cap the per-tick work at
  // SCAN_LOOKBACK_BLOCKS so a cold start doesn't blow the worker's
  // CPU budget. Subsequent ticks make progress on the backfill until
  // they catch up to `head`.
  const cursorRow = await env.DB.prepare(
    `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
  )
    .bind(chainId, CURSOR_KIND)
    .first<{ last_block: number }>();
  const lastBlock = cursorRow ? BigInt(cursorRow.last_block) : deployBlock - 1n;
  const scanFrom = lastBlock + 1n;
  if (scanFrom > head) {
    return {
      scannedFrom: scanFrom,
      scannedTo: scanFrom - 1n,
      newOffers: 0,
      statusUpdates: 0,
      detailRefreshes: 0,
      newLoans: 0,
      loanStatusUpdates: 0,
      activityEvents: 0,
      skipped: 'caught-up',
    };
  }
  const scanTo =
    scanFrom + SCAN_LOOKBACK_BLOCKS * 4n > head
      ? head
      : scanFrom + SCAN_LOOKBACK_BLOCKS * 4n;

  // Single chunked scan across the full event allow-list. Public RPCs
  // (Alchemy free tier, publicnode) reject ranges > 10k blocks, so we
  // page through MAX_RANGE_PER_CALL at a time.
  const allLogs: DecodedLog[] = [];
  let cursor = scanFrom;
  while (cursor <= scanTo) {
    const chunkEnd =
      cursor + MAX_RANGE_PER_CALL - 1n > scanTo
        ? scanTo
        : cursor + MAX_RANGE_PER_CALL - 1n;
    try {
      const logs = await client.getContractEvents({
        address: diamond,
        abi: EVENT_ABI,
        fromBlock: cursor,
        toBlock: chunkEnd,
      });
      for (const log of logs) {
        allLogs.push(log as unknown as DecodedLog);
      }
    } catch (err) {
      console.error(
        `[chainIndexer] getContractEvents ${cursor}-${chunkEnd} failed`,
        err,
      );
      // Don't advance the cursor on partial failure — the next tick
      // retries from the same `scanFrom`. Bail early so we don't
      // skip blocks.
      return {
        scannedFrom: scanFrom,
        scannedTo: cursor - 1n,
        newOffers: 0,
        statusUpdates: 0,
        detailRefreshes: 0,
        newLoans: 0,
        loanStatusUpdates: 0,
        activityEvents: 0,
        skipped: 'rpc-error',
      };
    }
    cursor = chunkEnd + 1n;
  }

  // ── Per-domain dispatch ─────────────────────────────────────────
  // We need block timestamps for activity_events.block_at. Fetch
  // them once per unique block in the scan window, not per log; a
  // single LoanInitiated tx can carry 3+ events in the same block,
  // and burning ~3× the eth_getBlockByNumber budget for no reason
  // shows up as P95 cron-tick latency on a busy day.
  const uniqueBlocks = new Set<bigint>();
  for (const log of allLogs) uniqueBlocks.add(log.blockNumber);
  const blockTimestamps = new Map<bigint, number>();
  for (const blockNum of uniqueBlocks) {
    try {
      const block = await client.getBlock({ blockNumber: blockNum });
      blockTimestamps.set(blockNum, Number(block.timestamp));
    } catch {
      // On RPC hiccup just stamp now() as a sentinel — the block
      // ordering still works because activity_events keys on
      // (block_number, log_index), not block_at.
      blockTimestamps.set(blockNum, Math.floor(Date.now() / 1000));
    }
  }

  const offerStats = await processOfferLogs(allLogs, env, chainId);
  const loanStats = await processLoanLogs(allLogs, env, chainId, blockTimestamps);
  // Activity ledger captures EVERY decoded event in `allLogs`. Phase
  // A and Phase B handlers above mutate domain tables; this writer
  // appends one row per log to the unified feed for the Activity
  // page + LoanTimeline + per-wallet history surfaces.
  const activityEvents = await recordActivityEvents(allLogs, env, chainId, blockTimestamps);

  // Per-domain detail refresh, batched per tick.
  const detailRefreshes = await refreshStaleOfferDetails(
    client,
    diamond,
    chainId,
    env,
  );
  // Bootstrap loan position-NFT token IDs (lender_token_id /
  // borrower_token_id) for any newly-inserted loan rows. One
  // getLoanDetails call per loan, batched per tick. After bootstrap
  // the values are immutable for the loan's lifetime; the next tick
  // skips them via the `lender_token_id = '0'` predicate.
  await refreshStaleLoanTokenIds(client, diamond, chainId, env);

  // Advance cursor only after every step succeeded — atomic from the
  // cron's perspective.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (chain_id, kind) DO UPDATE SET
       last_block = excluded.last_block,
       updated_at = excluded.updated_at`,
  )
    .bind(chainId, CURSOR_KIND, Number(scanTo), now)
    .run();

  return {
    scannedFrom: scanFrom,
    scannedTo: scanTo,
    newOffers: offerStats.newOffers,
    statusUpdates: offerStats.statusUpdates,
    detailRefreshes,
    newLoans: loanStats.newLoans,
    loanStatusUpdates: loanStats.statusUpdates,
    activityEvents,
  };
}

// ──────────────────────────────────────────────────────────────────
// Phase A — offer-domain handler.
// ──────────────────────────────────────────────────────────────────

interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

async function processOfferLogs(
  logs: DecodedLog[],
  env: Env,
  chainId: number,
): Promise<{ newOffers: number; statusUpdates: number }> {
  // Bucket by event name — all the OfferCreated rows first (so the
  // row exists before any later status flip in the same scan window),
  // then the terminal events.
  const created: { offerId: bigint; creator: Address; offerType: number; blockNumber: bigint }[] = [];
  const accepted: { offerId: bigint; loanId: bigint }[] = [];
  const cancelled: { offerId: bigint }[] = [];
  for (const log of logs) {
    const a = log.args;
    if (log.eventName === 'OfferCreated') {
      created.push({
        offerId: a.offerId as bigint,
        creator: a.creator as Address,
        offerType: Number(a.offerType),
        blockNumber: log.blockNumber,
      });
    } else if (log.eventName === 'OfferAccepted') {
      accepted.push({
        offerId: a.offerId as bigint,
        // loanId stays around for Phase B's loans-table seeding —
        // the OfferAccepted event already carries it, so Phase B's
        // loan handler doesn't need a parallel scan of this same
        // event.
        loanId: a.loanId as bigint,
      });
    } else if (log.eventName === 'OfferCanceled') {
      cancelled.push({ offerId: a.offerId as bigint });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  let newOffers = 0;
  for (const o of created) {
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO offers
        (chain_id, offer_id, status, creator, offer_type, lending_asset,
         collateral_asset, asset_type, collateral_asset_type,
         principal_liquidity, collateral_liquidity,
         amount, interest_rate_bps, collateral_amount, duration_days,
         first_seen_block, first_seen_at, updated_at)
       VALUES
        (?, ?, 'active', ?, ?, '0x', '0x', 0, 0, 1, 1, '0', 0, '0', 0, ?, ?, ?)`,
    )
      .bind(
        chainId,
        Number(o.offerId),
        o.creator.toLowerCase(),
        o.offerType,
        Number(o.blockNumber),
        now,
        now,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) newOffers++;
  }

  let statusUpdates = 0;
  for (const a of accepted) {
    const r = await env.DB.prepare(
      `UPDATE offers SET status = 'accepted', updated_at = ?
       WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(now, chainId, Number(a.offerId))
      .run();
    if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
  }
  for (const c of cancelled) {
    const r = await env.DB.prepare(
      `UPDATE offers SET status = 'cancelled', updated_at = ?
       WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(now, chainId, Number(c.offerId))
      .run();
    if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
  }

  return { newOffers, statusUpdates };
}

/**
 * Refresh `getOfferDetails` for every offer whose row was inserted as
 * a placeholder OR whose status flipped (in case a partial-fill
 * ratcheted `amountFilled`). Bound by DETAILS_REFRESH_BATCH per tick.
 */
async function refreshStaleOfferDetails(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  env: Env,
): Promise<number> {
  const stale = await env.DB.prepare(
    `SELECT offer_id FROM offers
     WHERE chain_id = ? AND (lending_asset = '0x' OR status = 'active')
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(chainId, DETAILS_REFRESH_BATCH)
    .all<{ offer_id: number }>();
  let refreshed = 0;
  for (const row of stale.results ?? []) {
    const ok = await refreshOfferDetails(client, diamond, chainId, row.offer_id, env);
    if (ok) refreshed++;
  }
  return refreshed;
}

/**
 * Pull `getOfferDetails(offerId)` from the Diamond and persist every
 * field into the offer row. Soft-skip on read failure (e.g. the
 * chain returns a struct shape that doesn't match what we expect —
 * shouldn't happen if ABIs are in sync, but if it does, leave the
 * placeholder row in place rather than blank-out a partially-good
 * row).
 */
async function refreshOfferDetails(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  offerId: number,
  env: Env,
): Promise<boolean> {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = (await client.readContract({
      address: diamond,
      abi: DIAMOND_OFFER_DETAILS_ABI,
      functionName: 'getOfferDetails',
      args: [BigInt(offerId)],
    })) as Record<string, unknown>;
  } catch (err) {
    console.error(`[chainIndexer] getOfferDetails(${offerId}) failed`, err);
    return false;
  }
  if (!detail) return false;
  const now = Math.floor(Date.now() / 1000);
  const o = detail as {
    creator: Address;
    offerType: number;
    principalLiquidity: number;
    collateralLiquidity: number;
    accepted: boolean;
    assetType: number;
    collateralAssetType: number;
    useFullTermInterest: boolean;
    creatorFallbackConsent: boolean;
    allowsPartialRepay: boolean;
    lendingAsset: Address;
    amount: bigint;
    interestRateBps: bigint;
    collateralAsset: Address;
    collateralAmount: bigint;
    durationDays: bigint;
    tokenId: bigint;
    positionTokenId: bigint;
    quantity: bigint;
    collateralTokenId: bigint;
    collateralQuantity: bigint;
    prepayAsset: Address;
    amountMax?: bigint;
    amountFilled?: bigint;
    interestRateBpsMax?: bigint;
  };
  await env.DB.prepare(
    `UPDATE offers SET
       creator = ?, offer_type = ?, lending_asset = ?, collateral_asset = ?,
       asset_type = ?, collateral_asset_type = ?,
       principal_liquidity = ?, collateral_liquidity = ?, token_id = ?,
       collateral_token_id = ?, quantity = ?, collateral_quantity = ?,
       amount = ?, amount_max = ?, amount_filled = ?,
       interest_rate_bps = ?, interest_rate_bps_max = ?,
       collateral_amount = ?, duration_days = ?, position_token_id = ?,
       prepay_asset = ?, use_full_term_interest = ?,
       creator_fallback_consent = ?, allows_partial_repay = ?,
       updated_at = ?
     WHERE chain_id = ? AND offer_id = ?`,
  )
    .bind(
      o.creator.toLowerCase(),
      o.offerType,
      o.lendingAsset.toLowerCase(),
      o.collateralAsset.toLowerCase(),
      o.assetType,
      o.collateralAssetType,
      o.principalLiquidity,
      o.collateralLiquidity,
      o.tokenId.toString(),
      o.collateralTokenId.toString(),
      o.quantity.toString(),
      o.collateralQuantity.toString(),
      o.amount.toString(),
      (o.amountMax ?? 0n).toString(),
      (o.amountFilled ?? 0n).toString(),
      Number(o.interestRateBps),
      Number(o.interestRateBpsMax ?? 0n),
      o.collateralAmount.toString(),
      Number(o.durationDays),
      o.positionTokenId.toString(),
      o.prepayAsset.toLowerCase(),
      o.useFullTermInterest ? 1 : 0,
      o.creatorFallbackConsent ? 1 : 0,
      o.allowsPartialRepay ? 1 : 0,
      now,
      chainId,
      offerId,
    )
    .run();
  return true;
}

// ──────────────────────────────────────────────────────────────────
// Loan position-NFT token-ID bootstrap.
// ──────────────────────────────────────────────────────────────────

const LOAN_TOKEN_ID_BATCH = 50;

/**
 * Pull `getLoanDetails(loanId).{lenderTokenId, borrowerTokenId}` for
 * any loan rows where the columns are still '0'. Bootstraps the
 * one-time mapping (loanId → lender NFT, borrower NFT) so the
 * by-lender / by-borrower / claimables endpoints can multicall
 * `ownerOf` against current chain state.
 *
 * The field is immutable for the loan's lifetime — once written, the
 * next tick's `WHERE lender_token_id = '0'` predicate filters this
 * loan out. So this is a per-loan one-time cost.
 */
async function refreshStaleLoanTokenIds(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  env: Env,
): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT loan_id FROM loans
     WHERE chain_id = ? AND lender_token_id = '0'
     ORDER BY loan_id DESC LIMIT ?`,
  )
    .bind(chainId, LOAN_TOKEN_ID_BATCH)
    .all<{ loan_id: number }>();
  for (const row of stale.results ?? []) {
    try {
      const detail = (await client.readContract({
        address: diamond,
        abi: DIAMOND_LOAN_DETAILS_ABI,
        functionName: 'getLoanDetails',
        args: [BigInt(row.loan_id)],
      })) as {
        lenderTokenId: bigint;
        borrowerTokenId: bigint;
        interestRateBps: bigint;
        startTime: bigint;
        allowsPartialRepay: boolean;
        periodicInterestCadence: number;
        lastPeriodicInterestSettledAt: bigint;
      };
      // T-034 — capture the Periodic Interest Payment fields at the
      // same getLoanDetails bootstrap so the pre-notify cron lane
      // can filter by cadence + compute the next checkpoint without
      // re-fetching the loan struct on every pass.
      await env.DB.prepare(
        `UPDATE loans SET lender_token_id = ?, borrower_token_id = ?,
                          interest_rate_bps = ?, start_time = ?,
                          allows_partial_repay = ?,
                          periodic_interest_cadence = ?,
                          last_period_settled_at = ?,
                          updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          detail.lenderTokenId.toString(),
          detail.borrowerTokenId.toString(),
          Number(detail.interestRateBps),
          Number(detail.startTime),
          detail.allowsPartialRepay ? 1 : 0,
          Number(detail.periodicInterestCadence ?? 0),
          Number(detail.lastPeriodicInterestSettledAt ?? 0n),
          Math.floor(Date.now() / 1000),
          chainId,
          row.loan_id,
        )
        .run();
    } catch (err) {
      console.error(`[chainIndexer] getLoanDetails(${row.loan_id}) failed`, err);
      // Soft-skip: leave row at '0', next tick retries.
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// Phase B — loan-domain handler.
// ──────────────────────────────────────────────────────────────────

async function processLoanLogs(
  logs: DecodedLog[],
  env: Env,
  chainId: number,
  blockTimestamps: Map<bigint, number>,
): Promise<{ newLoans: number; statusUpdates: number }> {
  // Walk in scan order so a LoanInitiated and a LoanRepaid in the
  // same window (cron caught up after a stretch of downtime) write
  // the row first then flip status second.
  let newLoans = 0;
  let statusUpdates = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const log of logs) {
    const a = log.args;
    if (log.eventName === 'LoanInitiated') {
      const loanId = Number(a.loanId as bigint);
      const offerId = Number(a.offerId as bigint);
      // Cross-domain reuse: pull asset metadata from the offers row
      // populated by Phase A's offer-detail refresh. If that row
      // doesn't exist yet (cold start before offers caught up), the
      // INSERT still lands with default zero/empty values; the next
      // tick's offer refresh will not back-fill the loan row, but a
      // subsequent terminal-event UPDATE will see the JOIN ready.
      // Fail-soft: missing offer row → loan row still recorded with
      // default placeholder asset fields.
      const offerRow = await env.DB.prepare(
        `SELECT asset_type, collateral_asset_type, lending_asset,
                collateral_asset, duration_days, token_id, collateral_token_id
         FROM offers WHERE chain_id = ? AND offer_id = ?`,
      )
        .bind(chainId, offerId)
        .first<{
          asset_type: number;
          collateral_asset_type: number;
          lending_asset: string;
          collateral_asset: string;
          duration_days: number;
          token_id: string;
          collateral_token_id: string;
        }>();
      const blockAt = blockTimestamps.get(log.blockNumber) ?? now;
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO loans
          (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount,
           asset_type, collateral_asset_type, lending_asset, collateral_asset,
           duration_days, token_id, collateral_token_id,
           start_block, start_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          chainId,
          loanId,
          offerId,
          (a.lender as string).toLowerCase(),
          (a.borrower as string).toLowerCase(),
          (a.principal as bigint).toString(),
          (a.collateralAmount as bigint).toString(),
          offerRow?.asset_type ?? 0,
          offerRow?.collateral_asset_type ?? 0,
          offerRow?.lending_asset ?? '0x0000000000000000000000000000000000000000',
          offerRow?.collateral_asset ?? '0x0000000000000000000000000000000000000000',
          offerRow?.duration_days ?? 0,
          offerRow?.token_id ?? '0',
          offerRow?.collateral_token_id ?? '0',
          Number(log.blockNumber),
          blockAt,
          now,
        )
        .run();
      if ((result.meta?.changes ?? 0) > 0) newLoans++;
    } else if (log.eventName === 'LoanRepaid') {
      const r = await flipLoanStatus(env, chainId, a, log, 'repaid');
      if (r) statusUpdates++;
    } else if (log.eventName === 'LoanDefaulted') {
      const r = await flipLoanStatus(env, chainId, a, log, 'defaulted');
      if (r) statusUpdates++;
    } else if (log.eventName === 'LoanLiquidated') {
      const r = await flipLoanStatus(env, chainId, a, log, 'liquidated');
      if (r) statusUpdates++;
    } else if (log.eventName === 'LoanSettled') {
      // LoanSettled fires when both sides have claimed and the loan
      // is fully wound down. We re-flip whatever the prior terminal
      // status was to 'settled' to mark "all claims resolved" — the
      // status order is logical (active → repaid/defaulted/liquidated
      // → settled), and querying for "is anything left to claim"
      // becomes `status != 'settled'` instead of joining activity_events.
      const r = await env.DB.prepare(
        `UPDATE loans SET status = 'settled', terminal_block = ?, terminal_at = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ? AND status IN ('repaid', 'defaulted', 'liquidated')`,
      )
        .bind(
          Number(log.blockNumber),
          Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000),
          chainId,
          Number(a.loanId as bigint),
        )
        .run();
      if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
    } else if (
      log.eventName === 'PeriodicInterestSettled' ||
      log.eventName === 'PeriodicInterestAutoLiquidated' ||
      log.eventName === 'RepayPartialPeriodAdvanced'
    ) {
      // T-034 PR2 — advance the mirrored `last_period_settled_at` to
      // match the on-chain advance. The on-chain advance is exactly
      // one cadence interval per event; we mirror that by walking
      // `last_period_settled_at` forward by `intervalDays(cadence) ×
      // 1 day`. Doing the increment in SQL keeps it cheap and avoids a
      // round-trip read of the full loan struct.
      const loanId = Number(a.loanId as bigint);
      // periodEndAt is the BOUNDARY that just closed — the new
      // `last_period_settled_at` lands exactly there. Both PR2
      // settle events carry it as the second arg (`periodEndAt`),
      // matching the inline-fold event's shape.
      const periodEndAt = Number(a.periodEndAt as bigint);
      await env.DB.prepare(
        `UPDATE loans SET last_period_settled_at = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(periodEndAt, now, chainId, loanId)
        .run();
      // PeriodicInterestSettled / AutoLiquidated do NOT flip terminal
      // status — the loan stays active across periodic checkpoints.
      // No statusUpdates increment.
    }
    // PartialRepaid + LoanSettlementBreakdown don't flip terminal
    // status — they're surfaced through activity_events for the
    // LoanTimeline and not reflected in `loans.status`. Partial
    // repayments leave the loan 'active'; the breakdown event is
    // emitted alongside terminal events that DO flip status.
    // PeriodicSlippageOverBuffer is informational-only (off-chain
    // monitors aggregate it); no row update needed.
  }
  return { newLoans, statusUpdates };
}

async function flipLoanStatus(
  env: Env,
  chainId: number,
  args: Record<string, unknown>,
  log: DecodedLog,
  status: 'repaid' | 'defaulted' | 'liquidated' | 'settled',
): Promise<boolean> {
  const loanId = Number(args.loanId as bigint);
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    `UPDATE loans SET status = ?, terminal_block = ?, terminal_at = ?, updated_at = ?
     WHERE chain_id = ? AND loan_id = ? AND status = 'active'`,
  )
    .bind(status, Number(log.blockNumber), now, now, chainId, loanId)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

// ──────────────────────────────────────────────────────────────────
// Unified activity event ledger.
// ──────────────────────────────────────────────────────────────────

async function recordActivityEvents(
  logs: DecodedLog[],
  env: Env,
  chainId: number,
  blockTimestamps: Map<bigint, number>,
): Promise<number> {
  let inserted = 0;
  for (const log of logs) {
    const args = log.args;
    const { actor, loanId, offerId } = pluckActivityRefs(log.eventName, args);
    const argsJson = serializeArgs(args);
    const blockAt = blockTimestamps.get(log.blockNumber) ?? Math.floor(Date.now() / 1000);
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO activity_events
        (chain_id, block_number, log_index, tx_hash, kind,
         loan_id, offer_id, actor, args_json, block_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        chainId,
        Number(log.blockNumber),
        log.logIndex,
        log.transactionHash.toLowerCase(),
        log.eventName,
        loanId,
        offerId,
        actor,
        argsJson,
        blockAt,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) inserted++;
  }
  return inserted;
}

/** Map a decoded event to the cross-domain reference columns the
 *  activity_events ledger denormalizes for fast filtering. The full
 *  args bag is preserved separately in `args_json`. */
function pluckActivityRefs(
  eventName: string,
  args: Record<string, unknown>,
): { actor: string | null; loanId: number | null; offerId: number | null } {
  switch (eventName) {
    case 'OfferCreated':
      return {
        actor: (args.creator as string)?.toLowerCase() ?? null,
        loanId: null,
        offerId: Number(args.offerId as bigint),
      };
    case 'OfferAccepted':
      return {
        actor: (args.acceptor as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: Number(args.offerId as bigint),
      };
    case 'OfferCanceled':
      return {
        actor: (args.creator as string)?.toLowerCase() ?? null,
        loanId: null,
        offerId: Number(args.offerId as bigint),
      };
    case 'LoanInitiated':
      return {
        actor: (args.borrower as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: Number(args.offerId as bigint),
      };
    case 'LoanRepaid':
      return {
        actor: (args.repayer as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'PartialRepaid':
      return {
        actor: null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'LoanDefaulted':
    case 'LoanLiquidated':
    case 'LoanSettlementBreakdown':
    case 'LoanSettled':
      return {
        actor: null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'LenderFundsClaimed':
    case 'BorrowerFundsClaimed':
    case 'BorrowerLifRebateClaimed':
      return {
        actor: (args.claimant as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    // T-034 PR2 — settler / advancer is the meaningful actor.
    case 'PeriodicInterestSettled':
    case 'PeriodicInterestAutoLiquidated':
      return {
        actor: (args.settler as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'RepayPartialPeriodAdvanced':
      return {
        actor: (args.advancedBy as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'PeriodicSlippageOverBuffer':
      return {
        actor: null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'VPFIDepositedToEscrow':
    case 'VPFIWithdrawnFromEscrow':
      return {
        actor: (args.user as string)?.toLowerCase() ?? null,
        loanId: null,
        offerId: null,
      };
    case 'VPFIPurchasedWithETH':
      return {
        actor: (args.buyer as string)?.toLowerCase() ?? null,
        loanId: null,
        offerId: null,
      };
    case 'Transfer':
      // Position-NFT lifecycle. The "actor" for activity-feed filter
      // purposes is the recipient (`to`) — that's the wallet that
      // gained ownership and most likely cares to see the event in
      // their feed. The sender (`from`) appears in args_json; a
      // future enhancement could surface a second row per Transfer
      // keyed on `from` if the per-wallet feed needs to show
      // "outgoing" transfers explicitly.
      return {
        actor: (args.to as string)?.toLowerCase() ?? null,
        loanId: null,
        offerId: null,
      };
    default:
      return { actor: null, loanId: null, offerId: null };
  }
}

/** JSON-serialize an event's args bag, coercing bigints to strings.
 *  Browsers and SQLite both choke on `JSON.stringify` of native
 *  bigint — the replacer normalises to TEXT. */
function serializeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
}

function emptyResult(skipped: string): ChainIndexerResult {
  return {
    scannedFrom: 0n,
    scannedTo: 0n,
    newOffers: 0,
    statusUpdates: 0,
    detailRefreshes: 0,
    newLoans: 0,
    loanStatusUpdates: 0,
    activityEvents: 0,
    skipped,
  };
}
