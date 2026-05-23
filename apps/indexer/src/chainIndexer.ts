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
  decodeEventLog,
  http,
  toEventSignature,
  type Abi,
  type AbiEvent,
  type Address,
  type PublicClient,
} from 'viem';
import type { Env, ChainConfig } from './env';
import { getChainConfigs } from './env';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { DIAMOND_OFFER_DETAILS_ABI, DIAMOND_LOAN_DETAILS_ABI } from './diamondAbi';

/** Resolve a chain's deployBlock from the consolidated deployments
 *  JSON — the indexer's first-run fallback when no cursor exists. */
function getDeployBlock(chainId: number): number | undefined {
  return getDeployment(chainId)?.deployBlock;
}

/** Combined event allow-list — EVERY event the Diamond can emit,
 *  derived from the compiled contract ABI bundle (`DIAMOND_ABI_VIEM`)
 *  rather than hand-typed signatures.
 *
 *  Why derived, not hand-maintained: a hand-typed `parseAbi([...])`
 *  list silently drifts. As of this rewrite it was wrong for SEVEN
 *  events — `LoanRepaid` (4 args typed vs 7 emitted), `LoanDefaulted`
 *  (2 vs 3), `PartialRepaid` (3 vs 4), `OfferAccepted` (3 vs 6),
 *  `OfferMatched` (8 vs 10), `LenderFundsClaimed` / `BorrowerFundsClaimed`
 *  (4 vs 5), `BorrowerLifRebateClaimed` (3 vs 4). A wrong arg count
 *  changes the keccak event signature → different topic0 → the indexer
 *  never matches the log → loans silently stay `active` forever. Same
 *  drift class the CLAUDE.md "Watcher offer-decode" incident warns
 *  about. Deriving from the compiler-emitted ABI makes it impossible.
 *
 *  Dedup: the bundle re-exports each facet verbatim from
 *  `forge inspect <Facet> abi`, so some events appear in several facets
 *  (`LoanSettlementBreakdown` in RepayFacet + PrecloseFacet, `OfferClosed`
 *  in OfferCancelFacet + OfferMatchFacet, the `SwapAdapter*` trio across
 *  three facets, `Transfer`/`Approval`/`ApprovalForAll` twice within
 *  VaipakamNFTFacet). `decodeEventLog` throws on ambiguous selectors, so
 *  dedupe by canonical event signature, keeping the first occurrence
 *  (identical signature → identical selector → harmless to drop dupes). */
const EVENT_ABI: readonly AbiEvent[] = (() => {
  const seen = new Set<string>();
  const out: AbiEvent[] = [];
  for (const item of DIAMOND_ABI_VIEM as Abi) {
    if (item.type !== 'event') continue;
    const ev = item as AbiEvent;
    let sig: string;
    try {
      sig = toEventSignature(ev);
    } catch {
      continue; // malformed entry — skip rather than crash the worker
    }
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(ev);
  }
  return out;
})();

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
  if (chains.length === 0) return [];

  // Round-robin: process exactly ONE chain per cron invocation. Free-tier
  // Workers cap at 50 subrequests per invocation; backfill on a single
  // chain can spend ~38 (events + inline-fetch + token-id refresh).
  // Processing all chains serially in one tick blew past 50 and dropped
  // events for chains 2 and 3. Pointer-stepping spreads the budget
  // across N invocations; combined with a 1-min cron the per-chain
  // refresh cadence is `len(chains) * 1min` ≈ 3 min today.
  //
  // Pointer is stored in `indexer_cursor` under
  // `(chain_id=0, kind='roundrobin')` — `chain_id=0` is a reserved
  // "meta" sentinel that doesn't collide with any real chain (EIP-155
  // chain IDs are >= 1). `last_block` is repurposed as the pointer
  // value; `updated_at` is its tick timestamp for diagnostics.
  const ROUND_ROBIN_KIND = 'roundrobin';
  const META_CHAIN_ID = 0;
  const pointerRow = await env.DB.prepare(
    `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
  )
    .bind(META_CHAIN_ID, ROUND_ROBIN_KIND)
    .first<{ last_block: number }>();
  const pointer = pointerRow?.last_block ?? 0;
  const idx = pointer % chains.length;
  const chain = chains[idx];

  const results: ChainIndexerResult[] = [];
  try {
    const r = await runChainIndexerForChain(env, chain);
    results.push(r);
  } catch (err) {
    console.error(`[chainIndexer] chain ${chain.id} failed`, err);
    results.push({ ...emptyResult('chain-error'), chainId: chain.id });
  }

  // Advance pointer regardless of pass success — sticking on a failing
  // chain would starve the others. The chain's cursor stays where it
  // was (transactional with the per-chain pass), so the next round-trip
  // retries from the same point.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chain_id, kind) DO UPDATE SET
       last_block = excluded.last_block,
       updated_at = excluded.updated_at`,
  )
    .bind(META_CHAIN_ID, ROUND_ROBIN_KIND, pointer + 1, now)
    .run();

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
      // Plain address-filtered `eth_getLogs` (no topic filter), then
      // decode each log against EVENT_ABI ourselves. NOT
      // `getContractEvents({ abi: EVENT_ABI })` — that builds a topic0
      // OR-filter of every event in the ABI (~80 of them now that
      // EVENT_ABI is derived from the full Diamond ABI), and several
      // RPC providers reject `eth_getLogs` filters with that many
      // OR'd topics → the call errors → the cron bails on the same
      // window forever → Cloudflare backs the cron off entirely. An
      // unfiltered address query has no such limit; we decode + filter
      // client-side instead. Logs whose topic0 isn't in EVENT_ABI
      // (config-facet events, ERC-721 Approval, etc.) throw on decode
      // and are skipped.
      const rawLogs = await client.getLogs({
        address: diamond,
        fromBlock: cursor,
        toBlock: chunkEnd,
      });
      for (const raw of rawLogs) {
        let decoded: { eventName: string; args: Record<string, unknown> };
        try {
          decoded = decodeEventLog({
            abi: EVENT_ABI,
            topics: raw.topics,
            data: raw.data,
          }) as { eventName: string; args: Record<string, unknown> };
        } catch {
          continue; // event not in EVENT_ABI — not ours, skip
        }
        allLogs.push({
          ...raw,
          eventName: decoded.eventName,
          args: decoded.args,
        } as unknown as DecodedLog);
      }
    } catch (err) {
      console.error(
        `[chainIndexer] getLogs ${cursor}-${chunkEnd} failed`,
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

  const offerStats = await processOfferLogs(
    allLogs,
    env,
    chainId,
    client,
    diamond,
  );
  const loanStats = await processLoanLogs(
    allLogs,
    env,
    chainId,
    blockTimestamps,
    client,
    diamond,
  );
  // Activity ledger captures EVERY decoded event in `allLogs`. Phase
  // A and Phase B handlers above mutate domain tables; this writer
  // appends one row per log to the unified feed for the Activity
  // page + LoanTimeline + per-wallet history surfaces.
  const activityEvents = await recordActivityEvents(allLogs, env, chainId, blockTimestamps);

  // Per-domain detail refresh, batched per tick.
  const detailRefreshes = await refreshStubOffers(
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
  await refreshStubLoans(client, diamond, chainId, env);

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
  client: PublicClient,
  diamond: Address,
): Promise<{ newOffers: number; statusUpdates: number }> {
  // Bucket by event name — all the OfferCreated rows first (so the
  // row exists before any later status flip in the same scan window),
  // then the terminal events.
  const created: { offerId: bigint; creator: Address; offerType: number; blockNumber: bigint }[] = [];
  const accepted: { offerId: bigint; loanId: bigint }[] = [];
  const cancelled: { offerId: bigint }[] = [];
  // Range-Orders Phase 1 — partial-fill ratchet + terminal close.
  // Both replace the prior cron-driven `OR status = 'active'` refresh
  // sweep with single-field event-driven UPDATEs.
  const matched: {
    lenderOfferId: bigint;
    matchAmount: bigint;
    lenderRemainingPostMatch: bigint;
  }[] = [];
  const closed: { offerId: bigint; reason: number }[] = [];
  // #193 / Codex round-1 P1 — OfferModified and OfferMatched MUST be
  // applied in chain log order (not bucketed by type) because
  // `OfferMatched`'s UPDATE reads `amount_max` from the row at apply
  // time, and `OfferModified` may have just rewritten it. If chain
  // order is "modify then match", the indexer must reflect the
  // post-modify amount_max when computing amount_filled; if chain
  // order is "match then modify", the amount_filled computed against
  // the pre-modify amount_max is the correct value and the
  // subsequent modify just rewrites amount_max without touching
  // amount_filled. Either way, replaying in log order gets it right.
  // Other events (Created, Accepted, Cancelled, Closed) stay bucketed
  // because they don't depend on amount_max for their UPDATE
  // semantics; bucketing them keeps the Created handler's
  // getOfferDetails read-back coalesced under one pass.
  type ModifiedOrMatched =
    | { kind: 'modified';
        offerId: bigint;
        amount: bigint;
        amountMax: bigint;
        interestRateBps: bigint;
        interestRateBpsMax: bigint;
        collateralAmount: bigint;
        collateralAmountMax: bigint; }
    | { kind: 'matched';
        lenderOfferId: bigint;
        matchAmount: bigint;
        lenderRemainingPostMatch: bigint; };
  const orderedMatchAndModify: ModifiedOrMatched[] = [];
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
    } else if (log.eventName === 'OfferMatched') {
      // #193 / Codex round-1 P1 — flow into the log-order pass below
      // (interleaved with OfferModified) instead of the bucketed
      // matched array. Preserves chain order for the amount_max +
      // amount_filled interdependency.
      orderedMatchAndModify.push({
        kind: 'matched',
        lenderOfferId: a.lenderOfferId as bigint,
        matchAmount: a.matchAmount as bigint,
        lenderRemainingPostMatch: a.lenderRemainingPostMatch as bigint,
      });
    } else if (log.eventName === 'OfferClosed') {
      closed.push({
        offerId: a.offerId as bigint,
        reason: Number(a.reason),
      });
    } else if (log.eventName === 'OfferModified') {
      // #193 — full post-image arrives in the event payload so we can
      // refresh the row without a follow-up getOfferDetails read.
      // Log-order pass below replays this alongside OfferMatched.
      orderedMatchAndModify.push({
        kind: 'modified',
        offerId: a.offerId as bigint,
        amount: a.amount as bigint,
        amountMax: a.amountMax as bigint,
        interestRateBps: a.interestRateBps as bigint,
        interestRateBpsMax: a.interestRateBpsMax as bigint,
        collateralAmount: a.collateralAmount as bigint,
        collateralAmountMax: a.collateralAmountMax as bigint,
      });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  let newOffers = 0;
  for (const o of created) {
    // Try to fetch the full Offer struct inline — saves a later
    // UPDATE from `refreshStubOffers` and closes the
    // stub-row window so no downstream reader (loan handler,
    // loanRoutes API, frontend) ever sees `'0x'` placeholder
    // assets. Cost: same number of RPC calls (one per OfferCreated)
    // either way, just shifted earlier; one fewer D1 write per
    // offer (no follow-up UPDATE).
    //
    // Fail-soft: if the RPC reverts or times out, fall through to
    // the placeholder INSERT — `refreshStubOffers` retries
    // on the next cron tick. No event is dropped on the floor.
    let detail: Record<string, unknown> | null = null;
    try {
      detail = (await client.readContract({
        address: diamond,
        abi: DIAMOND_OFFER_DETAILS_ABI,
        functionName: 'getOfferDetails',
        args: [o.offerId],
      })) as Record<string, unknown>;
    } catch (err) {
      console.error(
        `[chainIndexer] inline getOfferDetails(${Number(o.offerId)}) failed; falling back to stub`,
        err,
      );
    }

    if (detail) {
      const od = detail as {
        creator: Address;
        offerType: number;
        principalLiquidity: number;
        collateralLiquidity: number;
        accepted: boolean;
        assetType: number;
        collateralAssetType: number;
        useFullTermInterest: boolean;
        creatorRiskAndTermsConsent: boolean;
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
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO offers
          (chain_id, offer_id, status, creator, offer_type,
           lending_asset, collateral_asset,
           asset_type, collateral_asset_type,
           principal_liquidity, collateral_liquidity,
           amount, amount_max, amount_filled,
           interest_rate_bps, interest_rate_bps_max,
           collateral_amount, duration_days,
           token_id, collateral_token_id,
           quantity, collateral_quantity, position_token_id,
           prepay_asset,
           use_full_term_interest, creator_fallback_consent, allows_partial_repay,
           creator_current_owner,
           is_stub,
           first_seen_block, first_seen_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
        .bind(
          chainId,
          Number(o.offerId),
          od.accepted ? 'accepted' : 'active',
          od.creator.toLowerCase(),
          od.offerType,
          od.lendingAsset.toLowerCase(),
          od.collateralAsset.toLowerCase(),
          od.assetType,
          od.collateralAssetType,
          od.principalLiquidity,
          od.collateralLiquidity,
          od.amount.toString(),
          (od.amountMax ?? 0n).toString(),
          (od.amountFilled ?? 0n).toString(),
          Number(od.interestRateBps),
          Number(od.interestRateBpsMax ?? 0n),
          od.collateralAmount.toString(),
          Number(od.durationDays),
          od.tokenId.toString(),
          od.collateralTokenId.toString(),
          od.quantity.toString(),
          od.collateralQuantity.toString(),
          od.positionTokenId.toString(),
          od.prepayAsset.toLowerCase(),
          od.useFullTermInterest ? 1 : 0,
          od.creatorRiskAndTermsConsent ? 1 : 0,
          od.allowsPartialRepay ? 1 : 0,
          // Seed current-owner to the creator (any later Transfer
          // for this position-token overwrites via the loan-block
          // Transfer handler).
          od.creator.toLowerCase(),
          Number(o.blockNumber),
          now,
          now,
        )
        .run();
      if ((result.meta?.changes ?? 0) > 0) newOffers++;
      continue;
    }

    // Fallback: RPC failed during the inline fetch. Record the offer
    // as a stub (`is_stub = 1`) so `refreshStubOffers` heals
    // it on a later tick. The targeted predicate selects on this
    // boolean, not on `lending_asset` content — once
    // `refreshOfferDetails` UPDATEs canonical data + flips `is_stub`
    // to 0, the row drops out of the refresh queue forever.
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO offers
        (chain_id, offer_id, status, creator, offer_type, lending_asset,
         collateral_asset, asset_type, collateral_asset_type,
         principal_liquidity, collateral_liquidity,
         amount, interest_rate_bps, collateral_amount, duration_days,
         creator_current_owner,
         is_stub,
         first_seen_block, first_seen_at, updated_at)
       VALUES
        (?, ?, 'active', ?, ?, '0x', '0x', 0, 0, 1, 1, '0', 0, '0', 0, ?, 1, ?, ?, ?)`,
    )
      .bind(
        chainId,
        Number(o.offerId),
        o.creator.toLowerCase(),
        o.offerType,
        // Seed current-owner = creator. Heal path doesn't touch this
        // column; subsequent Transfer events overwrite as needed.
        o.creator.toLowerCase(),
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
    // Stamp `cancelled_at` alongside `status` so the Dashboard
    // "Cancelled" filter can serve the row directly from D1
    // (the contract's `cancelOffer` deletes the storage slot, so
    // a re-read returns the zero creator and a follow-up
    // `getOffer(id)` can't disambiguate "cancelled" from "never
    // existed"). The retention prune in `pruneOldCancelledOffers`
    // uses this timestamp to drop rows past the operator-chosen
    // window.
    const r = await env.DB.prepare(
      `UPDATE offers SET status = 'cancelled', cancelled_at = ?, updated_at = ?
       WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(now, now, chainId, Number(c.offerId))
      .run();
    if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
  }

  // #193 / Codex round-1 P1 — log-order replay of OfferMatched and
  // OfferModified. Both events are interleaved in `orderedMatchAndModify`
  // in their emit order so amount_filled (computed in the matched
  // handler from `current amount_max - lenderRemainingPostMatch`) is
  // always derived from the contract's actual amount_max at the time
  // of the match. Mixing this into a single log-order loop replaces
  // the two prior per-type buckets and closes the cross-event
  // ordering hole Codex called out: under the old order, a
  // modify-then-match within the same indexed batch would compute
  // amount_filled against the PRE-modify amount_max, then overwrite
  // amount_max with the new value — leaving the row's
  // (amount_filled / amount_max) ratio inconsistent.
  //
  // Note: borrower-side partial fills are out of Phase 1 scope (the
  // borrowerOfferId is single-fill). The `OfferMatched` event still
  // fires for them but `lenderRemainingPostMatch` semantics only
  // apply to the lender-side row, so we filter on `lenderOfferId`
  // only when applying.
  for (const ev of orderedMatchAndModify) {
    if (ev.kind === 'matched') {
      const r = await env.DB.prepare(
        `UPDATE offers
         SET amount_filled = CAST(amount_max AS INTEGER) - ?,
             updated_at = ?
         WHERE chain_id = ? AND offer_id = ? AND amount_max != '0'`,
      )
        .bind(
          ev.lenderRemainingPostMatch.toString(),
          now,
          chainId,
          Number(ev.lenderOfferId),
        )
        .run();
      if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
    } else {
      // OfferModified — full post-image. Status stays 'active'
      // (modifications are only allowed on unaccepted offers;
      // OfferAlreadyAccepted reverts the modify call), so we don't
      // touch the status column.
      const r = await env.DB.prepare(
        `UPDATE offers
         SET amount = ?,
             amount_max = ?,
             interest_rate_bps = ?,
             interest_rate_bps_max = ?,
             collateral_amount = ?,
             collateral_amount_max = ?,
             updated_at = ?
         WHERE chain_id = ? AND offer_id = ?`,
      )
        .bind(
          ev.amount.toString(),
          ev.amountMax.toString(),
          Number(ev.interestRateBps),
          Number(ev.interestRateBpsMax),
          ev.collateralAmount.toString(),
          ev.collateralAmountMax.toString(),
          now,
          chainId,
          Number(ev.offerId),
        )
        .run();
      if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
    }
  }

  // Range-Orders Phase 1 — terminal close. Maps the OfferCloseReason
  // enum to the indexer's status string. Mainline contract enum:
  //   0 = FullyFilled  → status 'fullyFilled'
  //   1 = Dust         → status 'fullyFilled' (dust remainder is
  //                      semantically "no more lending available";
  //                      indexers can filter via amount_filled vs
  //                      amount_max if they want the distinction)
  //   2 = Cancelled    → status 'cancelled' (also handled by the
  //                      OfferCanceled UPDATE above; idempotent)
  for (const cl of closed) {
    let status: string;
    if (cl.reason === 0 || cl.reason === 1) {
      status = 'fullyFilled';
    } else if (cl.reason === 2) {
      status = 'cancelled';
    } else {
      // Future-proof: unknown reason codes don't break the watcher.
      console.warn(
        `[chainIndexer] OfferClosed(${Number(cl.offerId)}) unknown reason ${cl.reason}`,
      );
      continue;
    }
    // OfferClosed reason=2 ('cancelled') also stamps `cancelled_at`
    // so the row falls under the same retention window as a row
    // that flipped status via the bare OfferCanceled event above.
    // Other reasons (fullyFilled / dust) leave cancelled_at NULL.
    if (status === 'cancelled') {
      const r = await env.DB.prepare(
        `UPDATE offers SET status = ?, cancelled_at = ?, updated_at = ?
         WHERE chain_id = ? AND offer_id = ?`,
      )
        .bind(status, now, now, chainId, Number(cl.offerId))
        .run();
      if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
    } else {
      const r = await env.DB.prepare(
        `UPDATE offers SET status = ?, updated_at = ?
         WHERE chain_id = ? AND offer_id = ?`,
      )
        .bind(status, now, chainId, Number(cl.offerId))
        .run();
      if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
    }
  }

  return { newOffers, statusUpdates };
}

/**
 * Refresh `getOfferDetails` for every offer whose row was inserted as
 * a placeholder OR whose status flipped (in case a partial-fill
 * ratcheted `amountFilled`). Bound by DETAILS_REFRESH_BATCH per tick.
 */
async function refreshStubOffers(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  env: Env,
): Promise<number> {
  // Targeted refresh: only rows actually flagged as stub. Every row
  // INSERTed via the inline-success path lands with `is_stub = 0`, and
  // `refreshOfferDetails` flips the flag back to 0 once it writes
  // canonical data. Active-offer churn is handled event-driven via the
  // `OfferMatched` / `OfferClosed` handlers in `processOfferLogs`, so
  // no `OR status = 'active'` clause is needed here. Cheap on free
  // tier — `idx_offers_chain_is_stub` keeps the lookup index-only.
  const stale = await env.DB.prepare(
    `SELECT offer_id FROM offers
     WHERE chain_id = ? AND is_stub = 1
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
    creatorRiskAndTermsConsent: boolean;
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
       is_stub = 0,
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
      o.creatorRiskAndTermsConsent ? 1 : 0,
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
 * Heal lane for stub loan rows. Any loan row flagged `is_stub = 1`
 * (created by the `LoanInitiated` insert path's fail-soft fallback when
 * a companion-event payload was unavailable / a read-back failed) gets
 * its FULL canonical state re-fetched here via `getLoanDetails(loanId)`
 * — asset metadata (asset_type, collateral_asset_type, lending_asset,
 * collateral_asset, duration_days, token_id, collateral_token_id), the
 * position-NFT IDs (lender_token_id, borrower_token_id — needed by the
 * by-lender / by-borrower / claimables endpoints' `ownerOf` multicall
 * and the Transfer handler's WHERE clause), principal, collateral, the
 * periodic-interest fields — then `is_stub` flips to 0 and the row
 * drops out of this predicate forever.
 *
 * `is_stub` mirrors the offers-side flag (migration 0008) and is the
 * authoritative staleness signal — `lender_token_id != '0'` could in
 * principle be legit-but-incomplete, so the explicit boolean is less
 * ambiguous. In steady state this lane rarely fires: the insert path
 * builds the row from the `LoanInitiatedDetails` companion event, so a
 * stub only happens if that event was somehow absent in the scan
 * window — vanishingly rare belt-and-suspenders coverage.
 */
async function refreshStubLoans(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  env: Env,
): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT loan_id FROM loans
     WHERE chain_id = ? AND is_stub = 1
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
        assetType: number;
        collateralAssetType: number;
        principalAsset: Address;
        collateralAsset: Address;
        durationDays: bigint;
        tokenId: bigint;
        collateralTokenId: bigint;
        lenderTokenId: bigint;
        borrowerTokenId: bigint;
        principal: bigint;
        collateralAmount: bigint;
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
      //
      // Also heal asset fields (asset_type, lending_asset, etc.) in
      // case the row was inserted via the stub-fallback path with
      // is_stub = 1 and zero/placeholder asset metadata. The
      // `getLoanDetails` return now carries everything, so a single
      // RPC + UPDATE restores the row to canonical state and flips
      // is_stub back to 0.
      await env.DB.prepare(
        `UPDATE loans SET asset_type = ?, collateral_asset_type = ?,
                          lending_asset = ?, collateral_asset = ?,
                          duration_days = ?, token_id = ?,
                          collateral_token_id = ?,
                          lender_token_id = ?, borrower_token_id = ?,
                          principal = ?, collateral_amount = ?,
                          interest_rate_bps = ?, start_time = ?,
                          allows_partial_repay = ?,
                          periodic_interest_cadence = ?,
                          last_period_settled_at = ?,
                          is_stub = 0,
                          updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          detail.assetType,
          detail.collateralAssetType,
          detail.principalAsset.toLowerCase(),
          detail.collateralAsset.toLowerCase(),
          Number(detail.durationDays),
          detail.tokenId.toString(),
          detail.collateralTokenId.toString(),
          detail.lenderTokenId.toString(),
          detail.borrowerTokenId.toString(),
          detail.principal.toString(),
          detail.collateralAmount.toString(),
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
      // Soft-skip: leave row at is_stub = 1, next tick retries.
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
  client: PublicClient,
  diamond: Address,
): Promise<{ newLoans: number; statusUpdates: number }> {
  // Walk in scan order so a LoanInitiated and a LoanRepaid in the
  // same window (cron caught up after a stretch of downtime) write
  // the row first then flip status second.
  let newLoans = 0;
  let statusUpdates = 0;
  const now = Math.floor(Date.now() / 1000);

  // Pre-index the `LoanInitiatedDetails` companions by loanId. Every
  // `LoanInitiated` is emitted alongside a `LoanInitiatedDetails` in
  // the same tx (so always in the same scan window) — its `details`
  // tuple is the self-sufficient row payload (asset metadata, rates,
  // token ids, …), so the `LoanInitiated` handler can build the whole
  // row from the event without a `getLoanDetails` RPC read-back (which
  // is what produces stub rows when it rate-limits). Pre-computing the
  // map here means the lookup works regardless of the relative log
  // order of the two events within the tx.
  const loanDetailsByLoanId = new Map<number, Record<string, unknown>>();
  for (const log of logs) {
    if (log.eventName === 'LoanInitiatedDetails') {
      const la = log.args as Record<string, unknown>;
      const det = la.details as Record<string, unknown> | undefined;
      if (det) loanDetailsByLoanId.set(Number(la.loanId as bigint), det);
    }
  }

  for (const log of logs) {
    const a = log.args;
    if (log.eventName === 'LoanInitiated') {
      const loanId = Number(a.loanId as bigint);
      const offerId = Number(a.offerId as bigint);
      const blockAt = blockTimestamps.get(log.blockNumber) ?? now;
      const lender = (a.lender as string).toLowerCase();
      const borrower = (a.borrower as string).toLowerCase();
      // Bare LoanInitiated carries (loanId, offerId, lender, borrower,
      // principal, collateralAmount); the LoanInitiatedDetails companion
      // (pre-indexed above) carries the rest of the row.
      const principal = (a.principal as bigint).toString();
      const collateralAmount = (a.collateralAmount as bigint).toString();

      // ── Primary path: build the whole row from the companion event ──
      // No `getLoanDetails` RPC at insert time → no stub-on-rate-limit.
      // `lenderTokenId` / `borrowerTokenId` are present once the contract
      // change carrying them (commit 8376a69) is deployed; until then
      // they're undefined → insert '0' + is_stub=1 and let
      // `refreshStubLoans` backfill just those two fields on a later
      // tick. `startTime` / `lastPeriodicInterestSettledAt` aren't in the
      // event (block.timestamp lives in the log envelope) — at loan
      // creation both equal block.timestamp, so use `blockAt`.
      const det = loanDetailsByLoanId.get(loanId);
      if (det) {
        const lenderTok =
          det.lenderTokenId !== undefined ? String(det.lenderTokenId as bigint) : '0';
        const borrowerTok =
          det.borrowerTokenId !== undefined ? String(det.borrowerTokenId as bigint) : '0';
        const isStub =
          det.lenderTokenId !== undefined && det.borrowerTokenId !== undefined ? 0 : 1;
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO loans
            (chain_id, loan_id, offer_id, status, lender, borrower,
             principal, collateral_amount,
             asset_type, collateral_asset_type, lending_asset, collateral_asset,
             duration_days, token_id, collateral_token_id,
             lender_token_id, borrower_token_id,
             interest_rate_bps, start_time, allows_partial_repay,
             periodic_interest_cadence, last_period_settled_at,
             lender_current_owner, borrower_current_owner,
             is_stub,
             start_block, start_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            chainId,
            loanId,
            offerId,
            lender,
            borrower,
            principal,
            collateralAmount,
            Number(det.assetType ?? 0),
            Number(det.collateralAssetType ?? 0),
            String((det.principalAsset as string | undefined) ?? '0x0000000000000000000000000000000000000000').toLowerCase(),
            String((det.collateralAsset as string | undefined) ?? '0x0000000000000000000000000000000000000000').toLowerCase(),
            Number(det.durationDays ?? 0n),
            String((det.tokenId as bigint | undefined) ?? 0n),
            String((det.collateralTokenId as bigint | undefined) ?? 0n),
            lenderTok,
            borrowerTok,
            Number(det.interestRateBps ?? 0n),
            blockAt,
            det.allowsPartialRepay ? 1 : 0,
            Number(det.periodicInterestCadence ?? 0),
            blockAt,
            // Seed current-owner to the LoanInitiated participants; a
            // later Transfer for these tokenIds overwrites. Correct for
            // the no-transfer case (most loans) without waiting on a
            // Transfer to fire.
            lender,
            borrower,
            isStub,
            Number(log.blockNumber),
            blockAt,
            now,
          )
          .run();
        if ((result.meta?.changes ?? 0) > 0) newLoans++;
        continue;
      }

      // ── Fallback A: companion event absent (shouldn't happen — it's
      //    emitted in the same tx) — fall back to the getLoanDetails
      //    read-back. ──
      type LoanDetail = {
        lender: Address;
        borrower: Address;
        assetType: number;
        collateralAssetType: number;
        principalAsset: Address;
        collateralAsset: Address;
        durationDays: bigint;
        tokenId: bigint;
        collateralTokenId: bigint;
        lenderTokenId: bigint;
        borrowerTokenId: bigint;
        principal: bigint;
        collateralAmount: bigint;
        interestRateBps: bigint;
        startTime: bigint;
        allowsPartialRepay: boolean;
        periodicInterestCadence: number;
        lastPeriodicInterestSettledAt: bigint;
      };
      let loanDetail: LoanDetail | null = null;
      try {
        loanDetail = (await client.readContract({
          address: diamond,
          abi: DIAMOND_LOAN_DETAILS_ABI,
          functionName: 'getLoanDetails',
          args: [BigInt(loanId)],
        })) as LoanDetail;
      } catch (err) {
        console.error(
          `[chainIndexer] LoanInitiatedDetails missing for loan ${loanId} AND getLoanDetails read-back failed; stub INSERT`,
          err,
        );
      }
      if (loanDetail) {
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO loans
            (chain_id, loan_id, offer_id, status, lender, borrower,
             principal, collateral_amount,
             asset_type, collateral_asset_type, lending_asset, collateral_asset,
             duration_days, token_id, collateral_token_id,
             lender_token_id, borrower_token_id,
             interest_rate_bps, start_time, allows_partial_repay,
             periodic_interest_cadence, last_period_settled_at,
             lender_current_owner, borrower_current_owner,
             is_stub,
             start_block, start_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
          .bind(
            chainId,
            loanId,
            offerId,
            loanDetail.lender.toLowerCase(),
            loanDetail.borrower.toLowerCase(),
            loanDetail.principal.toString(),
            loanDetail.collateralAmount.toString(),
            loanDetail.assetType,
            loanDetail.collateralAssetType,
            loanDetail.principalAsset.toLowerCase(),
            loanDetail.collateralAsset.toLowerCase(),
            Number(loanDetail.durationDays),
            loanDetail.tokenId.toString(),
            loanDetail.collateralTokenId.toString(),
            loanDetail.lenderTokenId.toString(),
            loanDetail.borrowerTokenId.toString(),
            Number(loanDetail.interestRateBps),
            Number(loanDetail.startTime),
            loanDetail.allowsPartialRepay ? 1 : 0,
            Number(loanDetail.periodicInterestCadence ?? 0),
            Number(loanDetail.lastPeriodicInterestSettledAt ?? 0n),
            loanDetail.lender.toLowerCase(),
            loanDetail.borrower.toLowerCase(),
            Number(log.blockNumber),
            blockAt,
            now,
          )
          .run();
        if ((result.meta?.changes ?? 0) > 0) newLoans++;
        continue;
      }

      // ── Fallback B: stub INSERT (is_stub=1) — refreshStubLoans heals. ──
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO loans
          (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount,
           asset_type, collateral_asset_type, lending_asset, collateral_asset,
           duration_days, token_id, collateral_token_id,
           lender_current_owner, borrower_current_owner,
           is_stub,
           start_block, start_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 0, 0, '0x', '0x', 0, '0', '0', ?, ?, 1, ?, ?, ?)`,
      )
        .bind(
          chainId,
          loanId,
          offerId,
          lender,
          borrower,
          principal,
          collateralAmount,
          lender,
          borrower,
          Number(log.blockNumber),
          blockAt,
          now,
        )
        .run();
      if ((result.meta?.changes ?? 0) > 0) newLoans++;
    } else if (log.eventName === 'LoanRepaid') {
      // Full repay (or a FallbackPending-cure repay). On-chain this is
      // a transition to Repaid; the indexer's `status = 'active'` guard
      // in flipLoanStatus is fine — through any fallback episode the D1
      // status stays 'active' (we don't mirror FallbackPending), so the
      // terminal Repaid still applies.
      const r = await flipLoanStatus(env, chainId, a, log, 'repaid');
      if (r) statusUpdates++;
    } else if (log.eventName === 'LoanPreclosedDirect') {
      // Preclose Option 1 — borrower closes early. Transition Active→Repaid.
      const r = await flipLoanStatus(env, chainId, a, log, 'repaid');
      if (r) statusUpdates++;
    } else if (log.eventName === 'OffsetCompleted') {
      // Preclose Option 3 — offsetWithNewOffer + completeOffset. The
      // *original* loan transitions Active→Repaid (the new loan emits
      // its own LoanInitiated). Keyed by `originalLoanId`, not `loanId`.
      const r = await flipLoanStatus(
        env,
        chainId,
        a,
        log,
        'repaid',
        Number(a.originalLoanId as bigint),
      );
      if (r) statusUpdates++;
    } else if (log.eventName === 'LoanRefinanced') {
      // Refinance — the *old* loan transitions Active→Repaid (the new
      // loan emits its own LoanInitiated). Keyed by `oldLoanId`.
      const r = await flipLoanStatus(
        env,
        chainId,
        a,
        log,
        'repaid',
        Number(a.oldLoanId as bigint),
      );
      if (r) statusUpdates++;
    } else if (log.eventName === 'PartialRepaid') {
      // Partial repayment — loan stays Active, but `principal` shrinks.
      // The event carries the post-state `newPrincipal`, so mirror it.
      await env.DB.prepare(
        `UPDATE loans SET principal = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          String(a.newPrincipal as bigint),
          Math.floor(Date.now() / 1000),
          chainId,
          Number(a.loanId as bigint),
        )
        .run();
    } else if (log.eventName === 'CollateralAdded') {
      // Borrower topped up collateral — loan stays Active, but
      // `collateral_amount` grows. The event carries `newCollateralAmount`.
      await env.DB.prepare(
        `UPDATE loans SET collateral_amount = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          String(a.newCollateralAmount as bigint),
          Math.floor(Date.now() / 1000),
          chainId,
          Number(a.loanId as bigint),
        )
        .run();
    } else if (log.eventName === 'LoanObligationTransferred') {
      // Preclose Option 2 — the borrower obligation moves to a new
      // borrower; the loan stays Active. The position-NFT Transfer
      // handler below already updates `borrower_current_owner`; mirror
      // the canonical `borrower` column too so direct reads stay
      // consistent. (Collateral / duration / rate also change on this
      // path, but the event doesn't carry the new collateral amount —
      // see the contract-side payload-completeness follow-up.)
      await env.DB.prepare(
        `UPDATE loans SET borrower = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          String(a.newBorrower as string).toLowerCase(),
          Math.floor(Date.now() / 1000),
          chainId,
          Number(a.loanId as bigint),
        )
        .run();
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
    } else if (log.eventName === 'InternalMatchExecuted') {
      // PR3-PR5 of internal-match work (B.2). Two or three loans
      // partial-match across each other; each loan's principal is
      // cleared by ITS leg's notional, each loan's collateral is
      // consumed by the NEXT loan's leg notional.
      //
      // 2-way (loanIdC == 0):
      //   A.principal     -= notionalA  (movedX)
      //   A.collateral    -= notionalB  (movedY)
      //   B.principal     -= notionalB  (movedY)
      //   B.collateral    -= notionalA  (movedX)
      //
      // 3-way A→B→C→A (loanIdC != 0):
      //   A.principal     -= notionalA
      //   A.collateral    -= notionalC
      //   B.principal     -= notionalB
      //   B.collateral    -= notionalA
      //   C.principal     -= notionalC
      //   C.collateral    -= notionalB
      //
      // When a loan's principal hits zero the indexer flips its
      // status to 'internal_matched'. Partial matches leave the
      // loan in 'active' with reduced principal/collateral —
      // a subsequent block's match attempt may close it, or it
      // falls through to external liquidation once LTV crosses
      // the priority-window ceiling.
      const loanIdA = Number(a.loanIdA as bigint);
      const loanIdB = Number(a.loanIdB as bigint);
      const loanIdC = Number(a.loanIdC as bigint);
      const nA = BigInt(a.notionalA as bigint);
      const nB = BigInt(a.notionalB as bigint);
      const nC = BigInt(a.notionalC as bigint);
      const isThreeWay = loanIdC !== 0;

      // Apply per-loan principal+collateral decrements then flip
      // status when fully cleared. Loop helper inlined to avoid a
      // separate function — each loan's two notionals are the only
      // input.
      async function applyMatch(loanId: number, principalDelta: bigint, collateralDelta: bigint) {
        if (loanId === 0) return;
        // Read current values, decrement in JS (bigint), write back.
        const cur = await env.DB.prepare(
          `SELECT principal, collateral_amount FROM loans WHERE chain_id = ? AND loan_id = ?`
        ).bind(chainId, loanId).first<{ principal: string; collateral_amount: string }>();
        if (!cur) return;
        const newPrincipal = BigInt(cur.principal) - principalDelta;
        const newCollateral = BigInt(cur.collateral_amount) - collateralDelta;
        if (newPrincipal === 0n) {
          await env.DB.prepare(
            `UPDATE loans SET principal = ?, collateral_amount = ?, status = 'internal_matched', terminal_block = ?, terminal_at = ?, updated_at = ? WHERE chain_id = ? AND loan_id = ? AND status = 'active'`,
          )
            .bind(
              newPrincipal.toString(),
              newCollateral.toString(),
              Number(log.blockNumber),
              now,
              now,
              chainId,
              loanId,
            )
            .run();
          statusUpdates++;
        } else {
          await env.DB.prepare(
            `UPDATE loans SET principal = ?, collateral_amount = ?, updated_at = ? WHERE chain_id = ? AND loan_id = ?`,
          )
            .bind(
              newPrincipal.toString(),
              newCollateral.toString(),
              now,
              chainId,
              loanId,
            )
            .run();
        }
      }

      if (isThreeWay) {
        await applyMatch(loanIdA, nA, nC);
        await applyMatch(loanIdB, nB, nA);
        await applyMatch(loanIdC, nC, nB);
      } else {
        await applyMatch(loanIdA, nA, nB);
        await applyMatch(loanIdB, nB, nA);
      }
    }
    // Notes on events deliberately not state-mutating here:
    //  - LoanSettlementBreakdown / PeriodicSlippageOverBuffer /
    //    SwapAdapter* — informational only; surfaced via activity_events
    //    for the LoanTimeline, no `loans` row change.
    //  - LoanFallbackPending / LoanCuredFromFallback — the FallbackPending
    //    state is transient (cured → Active, or lender-claim → Defaulted);
    //    the indexer keeps `loans.status = 'active'` through the episode
    //    and the eventual terminal event (LoanRepaid / LoanDefaulted)
    //    still applies correctly.
    //  - LoanSold / LoanSaleCompleted / LoanSaleOfferLinked
    //    (EarlyWithdrawal) — the *original* loan stays Active with a new
    //    lender (covered by the position-NFT Transfer handler below);
    //    the internal "temp loan" the sale spins up transitions
    //    Active→Repaid on-chain but does NOT currently emit a status
    //    event, so the indexer can't mirror it — see the contract-side
    //    payload-completeness follow-up.
    //  - LoanKeeperEnabled / OfferKeeperEnabled / *Details companions /
    //    OffsetOfferCreated — not modelled in the indexer schema.
    //
    // ─── Position-NFT Transfer: maintain current_owner columns ───
    // ERC721 Transfer events (mint = from 0x0, trade between holders,
    // burn = to 0x0) are projected into the loans/offers tables'
    // `*_current_owner` columns so the by-current-holder routes
    // can resolve in O(log N) without a per-request `ownerOf` RPC.
    //
    // The same tokenId can sit on either a loan position or an
    // offer position at any moment (not both — the offer's tokenId
    // transitions to a loan's lender/borrower-tokenId at offer
    // accept). We fire all 3 UPDATEs blindly; only the matching
    // row gets touched, the others no-op.
    else if (log.eventName === 'Transfer') {
      const tokenId = String(a.tokenId as bigint);
      const to = String(a.to as string).toLowerCase();
      // Skip burns (to=0x0) — current_owner stays as whatever the last
      // non-zero holder was. The position is "burned" but the row
      // remains for history; null'ing current_owner would falsely
      // signal an active holder of address(0).
      if (to !== '0x0000000000000000000000000000000000000000') {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE loans SET lender_current_owner = ?, updated_at = ?
             WHERE chain_id = ? AND lender_token_id = ?`,
          ).bind(to, now, chainId, tokenId),
          env.DB.prepare(
            `UPDATE loans SET borrower_current_owner = ?, updated_at = ?
             WHERE chain_id = ? AND borrower_token_id = ?`,
          ).bind(to, now, chainId, tokenId),
          env.DB.prepare(
            `UPDATE offers SET creator_current_owner = ?, updated_at = ?
             WHERE chain_id = ? AND position_token_id = ?`,
          ).bind(to, now, chainId, tokenId),
        ]);
      }
    }
  }
  return { newLoans, statusUpdates };
}

async function flipLoanStatus(
  env: Env,
  chainId: number,
  args: Record<string, unknown>,
  log: DecodedLog,
  status: 'repaid' | 'defaulted' | 'liquidated' | 'settled',
  /** Some terminal events key the loan by a non-`loanId` arg —
   *  `OffsetCompleted.originalLoanId`, `LoanRefinanced.oldLoanId`. Pass
   *  that loanId here; defaults to `args.loanId` otherwise. */
  loanIdOverride?: number,
): Promise<boolean> {
  const loanId = loanIdOverride ?? Number(args.loanId as bigint);
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
    case 'OfferModified':
      // #193 / Codex round-2 P2 — denormalize the actor (= creator;
      // OfferMutateFacet's access gate guarantees msg.sender ==
      // offer.creator) + offerId so per-offer and per-wallet
      // activity filters surface modify events alongside the other
      // offer-mutation rows. Without this mapping the event lands
      // in activity_events with NULL refs and falls out of the
      // dashboard's offer-timeline + wallet-history queries.
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
    case 'InternalMatchExecuted':
      // Indexed leg A as the canonical loanId for the activity
      // event row (the dashboard's loan-timeline query keys on
      // this column). The full multi-leg payload is in
      // `args_json` for clients that need both leg B and the
      // optional leg C. Actor is the matcher (msg.sender of the
      // entry-point call).
      return {
        actor: (args.matcher as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanIdA as bigint),
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
    case 'VPFIDepositedToVault':
    case 'VPFIWithdrawnFromVault':
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
