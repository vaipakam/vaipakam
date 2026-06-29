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
import {
  DIAMOND_OFFER_DETAILS_ABI,
  DIAMOND_LOAN_DETAILS_ABI,
  ERC721_OWNER_OF_ABI,
} from './diamondAbi';
import { indexerPublishPrepayListing } from './openseaPublish';

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

/** `LibVaipakam.LoanStatus` (uint8) → the indexer's TERMINAL status string, for
 *  the subset that are terminal end-of-block states an `InternalMatchExecuted`
 *  block-pinned read can land on (#762/#766). Append-only enum, so the slots are
 *  stable: Active=0, Repaid=1, Defaulted=2, Settled=3, FallbackPending=4,
 *  InternalMatched=5. Active(0) and FallbackPending(4) are deliberately ABSENT:
 *  they're non-terminal-from-a-match (a partial match leaves the loan `Active`;
 *  a partial rescue leaves it `FallbackPending`) and get a numbers-only refresh,
 *  never a status overwrite. An unknown future value also maps to `undefined`
 *  here → numbers-only, so we never write a guessed status. */
const LOAN_STATUS_TO_INDEXER_TERMINAL: Record<number, string> = {
  1: 'repaid',
  2: 'defaulted',
  3: 'settled',
  5: 'internal_matched',
};

/** Conservative reorg-horizon buffer used when an RPC doesn't support
 *  the `safe` block tag. Ethereum's exact finality is 32 blocks; L2s
 *  (Base / Arb / OP / Polygon zkEVM) settle well within ~10. 32 covers
 *  every chain we ship on with a comfortable margin. */
const SAFE_FALLBACK_BUFFER = 32n;

export interface ChainIndexerResult {
  chainId?: number;
  scannedFrom: bigint;
  scannedTo: bigint;
  newOffers: number;
  statusUpdates: number;
  detailRefreshes: number;
  newLoans: number;
  loanStatusUpdates: number;
  /** Stub loan rows healed to canonical state this scan (`refreshStubLoans`).
   *  A heal-only pass changes existing loan metadata without a new loan or a
   *  status transition, so #757 Phase B maps this to a `loan.updated` push. */
  loanDetailRefreshes: number;
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

/**
 * T-086 step 14 round 2 — retry the OpenSea publish for
 * `prepay_listings` rows whose inline event-ingest publish failed
 * (transient OpenSea outage, RPC blip, etc.) and whose
 * `opensea_published_at` is still NULL.
 *
 * Codex round-1 P2 fix on PR #312 — without this sweep, the
 * autonomous safety-net the design depends on can get permanently
 * stuck on its first failure. The retry is intentionally narrow:
 * one batch of up to `SWEEP_BATCH` rows per scheduled tick, scoped
 * to rows whose `posted_at` is at least `SWEEP_MIN_AGE_S` old (so
 * the inline event-ingest publish gets a chance to land first).
 *
 * Subrequest budget: per row we spend ~6 calls (getReceipt +
 * getBlock + getPrepayContext + 2 readContract + 1 OpenSea fetch),
 * so a batch of 5 fits well under the 50/tick free-tier ceiling
 * alongside the normal scan + offer prune.
 */
export async function sweepUnpublishedListings(env: Env): Promise<void> {
  const SWEEP_BATCH = 5;
  const SWEEP_MIN_AGE_S = 60; // give the inline publish a minute.
  const cutoff = Math.floor(Date.now() / 1000) - SWEEP_MIN_AGE_S;
  // Cap by the union of supported chain ids — a row whose chain_id
  // is no longer in the operator's RPC set gets skipped (we can't
  // build a client for it).
  const chains = getChainConfigs(env);
  if (chains.length === 0) return;
  const chainById = new Map(chains.map((c) => [c.id, c]));

  // T-086 Round-5 Block B (#309) post-merge polish — Codex P2:
  // skip expired Dutch rows in the sweep. After `auctionEndTime`,
  // Seaport rejects the order as expired and OpenSea will refuse
  // the publish; without this filter the sweep keeps re-trying
  // the same dead rows on every tick, starving newer publishable
  // listings out of the `LIMIT ?` batch. Fixed-price rows have
  // `auction_mode != 1` so they're left untouched. The
  // `auction_end_time IS NULL` branch covers pre-Block-B rows
  // (migration 0018 added the column nullable).
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT chain_id, loan_id, order_hash, ask_price, conduit_key,
            salt, executor, tx_hash, fee_legs_json,
            end_ask_price, auction_end_time, auction_mode
       FROM prepay_listings
      WHERE opensea_published_at IS NULL
        AND posted_at <= ?
        AND (auction_mode IS NULL OR auction_mode != 1
             OR auction_end_time IS NULL OR auction_end_time > ?)
      ORDER BY posted_at ASC
      LIMIT ?`,
  )
    .bind(cutoff, nowSec, SWEEP_BATCH)
    .all<{
      chain_id: number;
      loan_id: number;
      order_hash: string;
      ask_price: string;
      conduit_key: string | null;
      salt: string | null;
      executor: string | null;
      tx_hash: string;
      fee_legs_json: string | null;
      end_ask_price: string | null;
      auction_end_time: number | null;
      auction_mode: number | null;
    }>();

  if (!rows.results || rows.results.length === 0) return;

  for (const row of rows.results) {
    const chain = chainById.get(row.chain_id);
    if (!chain) continue;
    // Backfill rows from before step-14 won't have conduit_key /
    // salt / executor — skip them. The proper migration window for
    // those is the original-tx redrive, which is out of scope here.
    if (!row.conduit_key || !row.salt || !row.executor) continue;
    const client = createPublicClient({ transport: http(chain.rpc) });
    // T-086 Round-5 Block A (#313) — decode the recorded fee
    // legs from D1 back into the shape the JS reconstruction
    // needs. Rows from before this migration have NULL
    // fee_legs_json (= treat as fee-free for sweep purposes).
    let feeLegs: { recipient: string; startAmount: bigint; endAmount: bigint }[] = [];
    if (row.fee_legs_json) {
      try {
        const parsed = JSON.parse(row.fee_legs_json) as Array<{
          recipient: string; startAmount: string; endAmount: string;
        }>;
        feeLegs = parsed.map((l) => ({
          recipient: l.recipient,
          startAmount: BigInt(l.startAmount),
          endAmount: BigInt(l.endAmount),
        }));
      } catch {
        // Malformed JSON should never happen (we wrote it), but
        // fall back to fee-free rather than crashing the sweep.
        feeLegs = [];
      }
    }
    // T-086 Round-5 Block B (#309) — Dutch params from D1. Rows
    // from before migration 0018 have NULL columns; treat them
    // as fixed-price (mode=0 sentinel) for sweep purposes.
    const dutch =
      row.auction_mode === 1 && row.end_ask_price && row.auction_end_time
        ? {
            startAskPrice: BigInt(row.ask_price),
            endAskPrice: BigInt(row.end_ask_price),
            projectedLenderLeg: 0n,
            projectedTreasuryLeg: 0n,
            auctionEndTime: BigInt(row.auction_end_time),
          }
        : undefined;
    const result = await indexerPublishPrepayListing(
      {
        publicClient: client,
        diamondAddress: chain.diamond as `0x${string}`,
        chainId: chain.id,
        loanId: BigInt(row.loan_id),
        txHash: row.tx_hash as `0x${string}`,
        askPrice: BigInt(row.ask_price),
        salt: BigInt(row.salt),
        conduitKey: row.conduit_key as `0x${string}`,
        executor: row.executor as `0x${string}`,
        expectedOrderHash: row.order_hash as `0x${string}`,
        feeLegs,
        dutch,
      },
      env,
    );
    if (result.published) {
      const now = Math.floor(Date.now() / 1000);
      // #757 (Codex #764) — atomic published-marker. Guard the write on the
      // SAME `order_hash` the sweep just published. If a concurrent re-price
      // (PrepayListingUpdated) rotated the row to a new order between our SELECT
      // and here — resetting `opensea_published_at` to NULL for the NEW order —
      // this UPDATE matches 0 rows, so we never falsely mark the new, still-
      // unpublished order as published; the next sweep republishes it. This
      // closes the read-modify-write race on BOTH the legacy and DO ingest
      // paths (the sweep has always run concurrently with the scan via
      // `ctx.waitUntil`), which is why the sweep no longer needs to be gated
      // off when DO ingest is enabled.
      await env.DB.prepare(
        `UPDATE prepay_listings
           SET opensea_published_at = ?
         WHERE chain_id = ? AND loan_id = ? AND order_hash = ?`,
      )
        .bind(now, chain.id, row.loan_id, row.order_hash)
        .run();
    } else if (result.error?.startsWith('unsupported-chain')) {
      // Terminal sentinel — chain isn't in `OPENSEA_CHAINS` (post
      // 2025-07-23 testnet sunset). Set `opensea_published_at = 0`
      // so the row stops appearing in the NULL-only sweep query
      // and doesn't starve real mainnet retries by occupying the
      // batch budget every tick (Codex P1 on PR #315).
      await env.DB.prepare(
        `UPDATE prepay_listings
           SET opensea_published_at = 0
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chain.id, row.loan_id)
        .run();
    } else {
      // Transient publish failure on a supported chain — leave
      // NULL so the next tick retries.
      // eslint-disable-next-line no-console
      console.warn(
        `[chainIndexer] sweep retry failed loan=${row.loan_id} chain=${chain.id}: ${result.error}`,
      );
    }
  }
}

// #757 — exported so the per-chain ingest Durable Object can drive a scan
// directly (the DO is the single serialized writer; the cron and the webhook
// both route through it). Unchanged behaviour: one cursor-derived,
// safe-head-bounded scan that advances the cursor. `scannedTo` is the new
// cursor, which the DO's catch-up loop compares against its target block.
export async function runChainIndexerForChain(
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
      loanDetailRefreshes: 0,
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
        loanDetailRefreshes: 0,
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
  const loanDetailRefreshes = await refreshStubLoans(
    client,
    diamond,
    chainId,
    env,
  );

  // Advance cursor only after every step succeeded — atomic from the
  // cron's perspective. #757 (Codex #764): the advance is MONOTONIC —
  // `WHERE excluded.last_block > indexer_cursor.last_block` makes a stale or
  // overlapping scan (one that read an older cursor and finished after a newer
  // scan already advanced) a no-op instead of lowering the cursor and forcing a
  // replay. With the safe-head (`blockTag:'safe'`) bound the cursor only ever
  // moves forward legitimately, so a backward write is always spurious. This
  // hardens the DO's single-writer guarantee against a rollout / migration
  // overlap window (belt-and-suspenders with the in-memory `scanRunning` flag).
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (chain_id, kind) DO UPDATE SET
       last_block = excluded.last_block,
       updated_at = excluded.updated_at
     WHERE excluded.last_block > indexer_cursor.last_block`,
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
    loanDetailRefreshes,
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
  // T-086 Round-8 (#358) §19.7e + Codex round-3 P2 #1 — distinct bucket
  // for the no-loan parallel-sale terminal so the D1 row's status flips
  // to 'consumed_by_sale' (NOT 'cancelled'), with its own
  // `consumed_by_sale_at` timestamp. Without this distinction the
  // cancelled-offer retention prune would eventually drop sold-offer
  // history rows the user expects to keep, and the UI couldn't
  // disambiguate "Sold via OpenSea" from a borrower-initiated cancel.
  const consumedBySale: { offerId: bigint }[] = [];
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
        // #760 — block of the OfferMatched log, for the block-pinned
        // absolute `amountFilled` read in the apply loop below.
        blockNumber: bigint; };
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
    } else if (log.eventName === 'OfferConsumedBySale') {
      // T-086 Round-8 (#358) §19.7e + Codex round-3 P2 #1 — Scenario A
      // terminal (buyer-side won the race). Distinct from `cancelled`
      // so the D1 row preserves the "Sold via OpenSea" terminal
      // state + escapes the cancelled-offer retention prune.
      consumedBySale.push({ offerId: a.offerId as bigint });
    } else if (log.eventName === 'OfferMatched') {
      // #193 / Codex round-1 P1 — flow into the log-order pass below
      // (interleaved with OfferModified) instead of the bucketed
      // matched array. Preserves chain order for the amount_max +
      // amount_filled interdependency.
      orderedMatchAndModify.push({
        kind: 'matched',
        lenderOfferId: a.lenderOfferId as bigint,
        // #760 — carried so the matched apply can read the absolute
        // `amountFilled` block-pinned to THIS event (idempotent re-scan).
        blockNumber: log.blockNumber,
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
      // #763 — read at `latest`, NOT pinned to the OfferCreated block. Pinning
      // was reconsidered: (a) the row is already deterministic without it — the
      // `INSERT OR IGNORE` below no-ops a pure re-scan, and a delayed first
      // processing of a since-modified offer is corrected by the subsequent
      // `OfferModified` (event-payload post-image) / `OfferMatched` (#760
      // block-pinned) replay in the same batch; (b) pinning would add an
      // archive-node dependency this fail-soft read can't satisfy on a catch-up;
      // and (c) a block-END read of an offer created AND cancelled in the same
      // block reads the post-`delete` ZERO struct anyway. So we keep `latest`
      // and guard the zero struct directly (below).
      detail = (await client.readContract({
        address: diamond,
        abi: DIAMOND_OFFER_DETAILS_ABI,
        functionName: 'getOfferDetails',
        args: [o.offerId],
      })) as Record<string, unknown>;
      // A `getOfferDetails` for an already-DELETED offer (created then cancelled
      // — `OfferCancelFacet` emits `OfferCanceledDetails` BEFORE
      // `delete s.offers[offerId]`) returns a ZERO struct, not a revert. Writing
      // that as a real detail row persists a zero creator/assets with
      // `is_stub = 0` that the later cancel status-update can't repair. Treat a
      // zero-creator read as a miss → fall through to the stub INSERT; the
      // `OfferCanceled` handler then marks it cancelled.
      if (
        detail &&
        (detail.creator as string | undefined)?.toLowerCase() ===
          '0x0000000000000000000000000000000000000000'
      ) {
        detail = null;
      }
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
        // #164 — on-chain createdAt (uint64 unix-seconds), stamped at
        // `createOffer` and immutable thereafter. Captured here
        // explicitly instead of derived from `first_seen_at` so the
        // partial-fill cooldown predicate in `MyOffersTable` reads
        // the same wall-clock as `OfferCancelFacet.cancelOffer`. A
        // restart, cron lag, or historical backfill would otherwise
        // shift `first_seen_at` forward and leave the UI's Cancel
        // button disabled past the contract's window.
        createdAt?: bigint;
        // #195 — GTT deadline (0 = GTC). #125 — DEX-style fill-mode
        // (0 Partial / 1 AON / 2 IOC). Stamped once at createOffer.
        expiresAt?: bigint;
        fillMode?: number;
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
           created_at, expires_at, fill_mode,
           first_seen_block, first_seen_at, updated_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
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
          // Number() on a bigint up to 2^64-1 is safe through 2106
          // (year of the uint32-second epoch ceiling, well past
          // any reasonable createdAt/expiresAt). 0 sentinel for
          // expiresAt = GTC; 0 fallback for createdAt covers legacy
          // pre-#164 rows (rare on a mainnet deploy past #164,
          // common on a fresh testnet rehearsal that pre-dates it).
          Number(od.createdAt ?? 0n),
          Number(od.expiresAt ?? 0n),
          Number(od.fillMode ?? 0),
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
  // T-086 Round-8 (#358) §19.7e + Codex round-3 P2 #1 — Scenario A
  // terminal. Distinct UPDATE so the row's status is
  // 'consumed_by_sale' (NOT 'cancelled'). Reuses the `cancelled_at`
  // column for the timestamp (a migration to add a dedicated
  // `consumed_by_sale_at` column is queued — for now the column name
  // is a misnomer but the timestamp semantics are the same: when did
  // the offer leave the active set). The retention prune skips
  // consumed_by_sale rows so the sold-through-OpenSea history
  // persists.
  for (const c of consumedBySale) {
    const r = await env.DB.prepare(
      `UPDATE offers SET status = 'consumed_by_sale', cancelled_at = ?, updated_at = ?
       WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(now, now, chainId, Number(c.offerId))
      .run();
    if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
  }

  // #193 — OfferMatched and OfferModified are processed interleaved in
  // `orderedMatchAndModify` (their emit order). #760 made the matched
  // handler write the ABSOLUTE `amount_filled` read block-pinned to the
  // event (not the old `current amount_max - lenderRemainingPostMatch`),
  // so the row's (amount_filled / amount_max) ratio is now consistent and
  // RE-SCAN-idempotent regardless of match/modify ordering within the
  // batch — the prior log-order-dependent delta hole is gone. The
  // interleaving is retained because OfferModified still applies its own
  // post-image to amount_max.
  //
  // Note: borrower-side partial fills are out of Phase 1 scope (the
  // borrowerOfferId is single-fill), so we apply on `lenderOfferId` only.
  for (const ev of orderedMatchAndModify) {
    if (ev.kind === 'matched') {
      // #760 — write the ABSOLUTE `amount_filled` read block-pinned to this
      // event, instead of `amount_max - lenderRemainingPostMatch` computed
      // against the CURRENT D1 `amount_max`. The old delta was non-idempotent
      // under a partial-failure RE-SCAN: if an OfferModified changed
      // `amount_max` in the same batch, the first scan left the modified
      // value in D1, and the re-scan's match then computed `amount_filled`
      // against the wrong (post-modify) base. A block-pinned `getOfferDetails`
      // read returns the same `amountFilled` deterministically on every replay.
      // FAIL-CLOSED (Codex #761 P1): a read failure must PROPAGATE — the scan
      // aborts before `runChainIndexerForChain` advances the cursor, so this
      // event is re-processed on the next scan. Swallowing it here would let the
      // cursor advance past a never-applied update, stranding `amount_filled`
      // stale indefinitely (only stub rows get a later refresh).
      let absFilled: bigint;
      try {
        const od = (await client.readContract({
          address: diamond,
          abi: DIAMOND_OFFER_DETAILS_ABI,
          functionName: 'getOfferDetails',
          args: [ev.lenderOfferId],
          blockNumber: ev.blockNumber,
        })) as { amountFilled?: bigint };
        if (od.amountFilled === undefined) {
          throw new Error('getOfferDetails returned no amountFilled');
        }
        absFilled = BigInt(od.amountFilled);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[chainIndexer] #760 getOfferDetails(${Number(ev.lenderOfferId)}) for OfferMatched failed; aborting scan so the cursor doesn't advance`,
          err,
        );
        throw err;
      }
      const r = await env.DB.prepare(
        `UPDATE offers
         SET amount_filled = ?,
             updated_at = ?
         WHERE chain_id = ? AND offer_id = ? AND amount_max != '0'`,
      )
        .bind(absFilled.toString(), now, chainId, Number(ev.lenderOfferId))
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
  // NB (#763 / Codex #767): we do NOT exclude terminal offers here. A
  // 'cancelled' offer with a PARTIAL fill, and every 'consumed_by_sale' offer,
  // still have their `s.offers[offerId]` struct on-chain (cancel only
  // `delete`s on a zero-fill; `markOfferConsumedBySale` clears only listing
  // metadata) — so they're still healable by `getOfferDetails` and must stay in
  // the refresh set. Genuinely-deleted offers (zero-fill cancels) are handled in
  // `refreshOfferDetails`, which clears `is_stub` on a zero read so the dead row
  // drops out of this queue instead of starving real stubs.
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
  // #763 (Codex #767) — a GENUINELY-DELETED offer (a zero-fill cancel runs
  // `delete s.offers[offerId]`) returns a ZERO struct, not a revert. Don't
  // overwrite the row with a zero creator/assets — that would blank out the
  // event-derived creator on the cancelled row. Instead clear `is_stub` so this
  // permanently-unhealable row drops OUT of the `refreshStubOffers` queue
  // (which orders by `updated_at ASC`) instead of sitting at its head and
  // starving real stubs every tick. Terminal offers that still HAVE storage
  // (partial-fill cancels, `consumed_by_sale`) read real data and fall through
  // to the normal heal below. Shares the inline OfferCreated-path guard.
  if (
    (detail.creator as string | undefined)?.toLowerCase() ===
    '0x0000000000000000000000000000000000000000'
  ) {
    await env.DB.prepare(
      `UPDATE offers SET is_stub = 0, updated_at = ?
       WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(now, chainId, offerId)
      .run();
    return false;
  }
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
    // See parallel definition above — #164 createdAt + #195 GTT +
    // #125 fill-mode.
    createdAt?: bigint;
    expiresAt?: bigint;
    fillMode?: number;
  };
  // #749 (Codex #768) — re-derive the offer's CURRENT position-NFT holder
  // authoritatively. A stub offer was inserted with `position_token_id = '0'`
  // (its inline `getOfferDetails` read had failed), so any ERC721 `Transfer` of
  // the offer NFT BEFORE this heal couldn't match (`WHERE position_token_id = ?`)
  // and was missed — `creator_current_owner` is stuck at the OfferCreated seed.
  // Now that we know the real `positionTokenId`, read its owner ONCE so the
  // D1-only wallet routes (and the LoanInitiated creator-side seed that copies
  // this column) see the true holder. Falls back to the creator on a revert
  // (e.g. an already-burned token) — same as the no-transfer default. One bounded
  // RPC per stub-heal (cron pass, not the hot read path).
  let creatorCurrentOwner = o.creator.toLowerCase();
  if (o.positionTokenId > 0n) {
    try {
      const owner = (await client.readContract({
        address: diamond,
        abi: ERC721_OWNER_OF_ABI,
        functionName: 'ownerOf',
        args: [o.positionTokenId],
      })) as string;
      if (owner) creatorCurrentOwner = owner.toLowerCase();
    } catch {
      // burned / nonexistent token — keep the creator default.
    }
  }
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
       created_at = ?, expires_at = ?, fill_mode = ?,
       creator_current_owner = ?,
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
      Number(o.createdAt ?? 0n),
      Number(o.expiresAt ?? 0n),
      Number(o.fillMode ?? 0),
      creatorCurrentOwner,
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
): Promise<number> {
  let healed = 0;
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
      const updated = await env.DB.prepare(
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
      if ((updated.meta?.changes ?? 0) > 0) healed++;
    } catch (err) {
      console.error(`[chainIndexer] getLoanDetails(${row.loan_id}) failed`, err);
      // Soft-skip: leave row at is_stub = 1, next tick retries.
    }
  }
  return healed;
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
        // #749 — seed the CREATOR side's current-owner from the offer, not the
        // event. `LoanFacet._mintCounterpartyPosition` REUSES the creator's
        // offer-position NFT as one loan side's token (and mints a fresh token
        // for the acceptor); the event's `lender`/`borrower` is the origination
        // record (`loan.lender = offer.creator`), so if that offer NFT was
        // transferred on the secondary market BEFORE accept, its true holder is
        // `offers.creator_current_owner`. The creator side is whichever loan
        // token equals the offer's `position_token_id`; the acceptor side keeps
        // the event party (a fresh mint to them — also re-set by its mint
        // Transfer). Falls back to the event party when the offer row isn't
        // resolvable yet (no-transfer case is identical anyway). The frontend's
        // on-chain verify is the authoritative backstop for the residual stub /
        // same-batch race.
        let lenderOwner = lender;
        let borrowerOwner = borrower;
        const offerRow = await env.DB.prepare(
          `SELECT position_token_id, creator_current_owner FROM offers
            WHERE chain_id = ? AND offer_id = ?`,
        )
          .bind(chainId, offerId)
          .first<{ position_token_id: string; creator_current_owner: string }>();
        if (offerRow?.creator_current_owner) {
          const creatorTok = String(offerRow.position_token_id);
          if (creatorTok !== '0' && creatorTok === lenderTok) {
            lenderOwner = offerRow.creator_current_owner;
          } else if (creatorTok !== '0' && creatorTok === borrowerTok) {
            borrowerOwner = offerRow.creator_current_owner;
          }
        }
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
            // Creator side from the offer's current holder, acceptor side from
            // the event party (see the #749 note above). A later Transfer for
            // these tokenIds still overwrites.
            lenderOwner,
            borrowerOwner,
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
      // T-086 step 12 — clear any live prepay-listing row.
      await _deletePrepayListing(env, chainId, Number(a.loanId as bigint));
    } else if (log.eventName === 'SwapToRepayExecuted') {
      // T-090 Sub 2 — borrower swap-to-repay full close. The contract
      // path transitions Active→Repaid (same status flip as `LoanRepaid`)
      // and atomically calls `LibPrepayCleanup.clearActiveListing`. Mirror
      // the LoanRepaid handler exactly.
      const r = await flipLoanStatus(env, chainId, a, log, 'repaid');
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, Number(a.loanId as bigint));
    } else if (log.eventName === 'SwapToRepayIntentCommitted') {
      // T-090 v1.1 (#389) Sub 2 (#417) — intent-based commit. INSERT
      // a `swap_to_repay_intents` row keyed by (chain_id, loan_id);
      // the loan stays Active in `loans`. At most one live commit
      // per loan is enforced on-chain by `IntentAlreadyCommitted`,
      // so `INSERT OR REPLACE` is safe — a "replace" can only occur
      // through a fill / cancel that the dispatcher would have
      // processed earlier in the same batch, OR through a stale
      // reorg replay (in which case the row content is identical).
      // Stamp `committed_at` with the block timestamp (Codex round-1
      // PR #421 P2 — on a cold-start backfill the worker's `now` is
      // far ahead of the actual on-chain commit time and would make
      // backfilled pending intents look newly committed).
      const blockAt = blockTimestamps.get(log.blockNumber) ?? now;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO swap_to_repay_intents
           (chain_id, loan_id, order_hash, committed_by,
            maker_amount, taker_amount, deadline,
            committed_at, committed_tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          chainId,
          Number(a.loanId as bigint),
          (a.orderHash as string).toLowerCase(),
          (a.committedBy as string).toLowerCase(),
          String(a.makerAmount as bigint),
          String(a.takerAmount as bigint),
          Number(a.deadline as bigint),
          blockAt,
          log.transactionHash,
        )
        .run();
    } else if (log.eventName === 'SwapToRepayIntentFilled') {
      // T-090 v1.1 Sub 2 — Fusion solver filled the intent; the
      // diamond's postInteraction ran the canonical settlement
      // waterfall atomically. Loan transitions Active→Repaid, the
      // active prepay-listing (if any) is cleared, and the intent
      // row is deleted. Mirrors `SwapToRepayExecuted` exactly for
      // the loan-side state machine, plus the intent-row cleanup.
      const loanId = Number(a.loanId as bigint);
      // Codex round-1 PR #421 P2 — look up the originating
      // `committed_by` from the intent row BEFORE we delete it so
      // the participants resolver can attribute the successful fill
      // to the borrower's activity feed (Fusion's solver is the
      // tx-side caller but the borrower owns the close-out
      // semantically).
      const intentRow = await env.DB.prepare(
        `SELECT committed_by FROM swap_to_repay_intents
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, loanId)
        .first<{ committed_by: string } | null>();
      if (intentRow?.committed_by) {
        // Stash on the args object so the participants resolver
        // (Phase C) can read it without a second SQL round-trip.
        (a as Record<string, unknown>).committedBy = intentRow.committed_by;
      }
      const r = await flipLoanStatus(env, chainId, a, log, 'repaid');
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, loanId);
      await env.DB.prepare(
        `DELETE FROM swap_to_repay_intents
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, loanId)
        .run();
    } else if (log.eventName === 'SwapToRepayIntentCancelled') {
      // T-090 v1.1 Sub 2 — borrower cancel OR permissionless
      // `cancelExpired` poke. Loan stays Active (the cancel only
      // tears down the v1.1 commit + returns collateral to the
      // borrower vault). Delete the intent row.
      await env.DB.prepare(
        `DELETE FROM swap_to_repay_intents
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, Number(a.loanId as bigint))
        .run();
    } else if (log.eventName === 'SwapToRepayIntentForceCancelled') {
      // T-090 v1.1 Sub 2 — HF-liquidation OR time-default path
      // force-cancelled the intent. The lender-protection action
      // proceeds in the same tx via downstream events
      // (LoanLiquidated / LoanDefaulted etc.) — those handlers do
      // the loan-side flip. Here we just delete the intent row.
      await env.DB.prepare(
        `DELETE FROM swap_to_repay_intents
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, Number(a.loanId as bigint))
        .run();
    } else if (log.eventName === 'LoanPreclosedDirect') {
      // Preclose Option 1 — borrower closes early. Transition Active→Repaid.
      const r = await flipLoanStatus(env, chainId, a, log, 'repaid');
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, Number(a.loanId as bigint));
    } else if (log.eventName === 'OffsetCompleted') {
      // Preclose Option 3 — offsetWithNewOffer + completeOffset. The
      // *original* loan transitions Active→Repaid (the new loan emits
      // its own LoanInitiated). Keyed by `originalLoanId`, not `loanId`.
      const origLoanId = Number(a.originalLoanId as bigint);
      const r = await flipLoanStatus(
        env,
        chainId,
        a,
        log,
        'repaid',
        origLoanId,
      );
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, origLoanId);
    } else if (log.eventName === 'LoanRefinanced') {
      // Refinance — the *old* loan transitions Active→Repaid (the new
      // loan emits its own LoanInitiated). Keyed by `oldLoanId`.
      const oldLoanId = Number(a.oldLoanId as bigint);
      const r = await flipLoanStatus(
        env,
        chainId,
        a,
        log,
        'repaid',
        oldLoanId,
      );
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, oldLoanId);
    } else if (log.eventName === 'LoanExtended') {
      // T-092 Phase 3 (#503) — `extendLoanInPlace` mutates
      // `loan.startTime`, `interestRateBps`, and `durationDays` in
      // place. No NFT or status change. The event carries the
      // post-state values for all three so we can update the row
      // without a follow-up `getLoanDetails` read.
      const loanId = Number(a.loanId as bigint);
      await env.DB.prepare(
        `UPDATE loans
            SET interest_rate_bps = ?,
                start_time = ?,
                duration_days = ?,
                updated_at = ?
          WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          Number(a.newRateBps as bigint),
          Number(a.newStartTime as bigint),
          Number(a.newDurationDays as bigint),
          Math.floor(Date.now() / 1000),
          chainId,
          loanId,
        )
        .run();
      // Codex round-3 P2 — the contract calls
      // `LibPrepayCleanup.clearActiveListing` on extension, but that
      // helper does NOT emit `PrepayListingCanceled`, so this branch
      // is the only place the projection learns the listing is dead.
      // Without this, `/loans/:id/prepayListing` would keep serving
      // a stale listing row after the extend.
      await _deletePrepayListing(env, chainId, loanId);
    } else if (log.eventName === 'PartialRepaid') {
      // Partial repayment — loan stays Active, but `principal` shrinks.
      // The event carries the post-state `newPrincipal`, so mirror it.
      const loanId = Number(a.loanId as bigint);
      await env.DB.prepare(
        `UPDATE loans SET principal = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          String(a.newPrincipal as bigint),
          Math.floor(Date.now() / 1000),
          chainId,
          loanId,
        )
        .run();
      // T-086 step 12 — refresh `prepay_listings.grace_period_end`
      // if the loan has a live listing. Partial repayment can
      // reset `startTime` (ERC20 loans) or reduce `durationDays`
      // (NFT rentals), both of which move the grace boundary.
      // Skip the RPC read when there's no live listing to refresh
      // (most loans aren't listed). Codex P2 round-3 on PR #304.
      const hasListing = await env.DB.prepare(
        `SELECT 1 FROM prepay_listings WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, loanId)
        .first<{ '1': number } | null>();
      if (hasListing) {
        const refreshedGraceEnd = await _resolveGraceEnd(
          client,
          diamond,
          loanId,
          log.blockNumber, // #763 — pin to this event's block
        );
        await env.DB.prepare(
          `UPDATE prepay_listings
             SET grace_period_end = ?, updated_at = ?
           WHERE chain_id = ? AND loan_id = ?`,
        )
          .bind(refreshedGraceEnd, now, chainId, loanId)
          .run();
      }
    } else if (log.eventName === 'SwapToRepayPartialExecuted') {
      // T-090 Sub 2 — borrower swap-to-repay partial. The contract path
      // reduces `loan.principal` (by `partialPrincipal`), reduces
      // `loan.collateralAmount` (by `collateralIn` =
      // `actualCollateralConsumed`; partial-fill leftover refunded to
      // borrower vault), and resets `loan.startTime = block.timestamp`
      // (RepayFacet.repayPartial:663 pattern). The loan stays Active.
      //
      // Idempotency via canonical chain read (Codex round-2 P1 on
      // PR #391): a delta-based UPDATE (`principal -= partialPrincipal`)
      // would double-subtract if the cron pass retries this block range
      // after the UPDATE landed but before `indexer_cursor` advances
      // (recordActivityEvents / refreshStubLoans / cursor-write failure
      // cases). Instead read the canonical post-state via
      // `getLoanDetails(loanId)` and write absolute values — the same
      // RPC quota the existing stub-loan refresh path spends, and
      // identical reruns produce identical writes.
      const loanId = Number(a.loanId as bigint);
      // Codex round-3 P2 #1 — pin the read to the event's block so a
      // later partial swap past `scanTo` can't bleed through and write
      // unfinalized state for the older safe log we're handling now.
      // Pass through any RPC error so the cron pass aborts and retries
      // (Codex round-3 P1) — `refreshStubLoans` only heals `is_stub =
      // 1` rows, so swallowing here would leave principal /
      // collateral_amount / start_time stale on this normal Active row
      // until some unrelated terminal event touches the loan.
      const detail = (await client.readContract({
        address: diamond,
        abi: DIAMOND_LOAN_DETAILS_ABI,
        functionName: 'getLoanDetails',
        args: [BigInt(loanId)],
        blockNumber: log.blockNumber,
      })) as {
        principal: bigint;
        collateralAmount: bigint;
        durationDays: bigint;
        startTime: bigint;
      };
      await env.DB.prepare(
        `UPDATE loans
           SET principal = ?,
               collateral_amount = ?,
               start_time = ?,
               updated_at = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          detail.principal.toString(),
          detail.collateralAmount.toString(),
          Number(detail.startTime),
          now,
          chainId,
          loanId,
        )
        .run();
      // Mirror PartialRepaid's grace-end refresh — the contract resets
      // `loan.startTime` on partial swap-to-repay too (RepayFacet:663
      // pattern), which moves the grace boundary for any live listing.
      const hasListing2 = await env.DB.prepare(
        `SELECT 1 FROM prepay_listings WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, loanId)
        .first<{ '1': number } | null>();
      if (hasListing2) {
        // Codex round-4 P2 — anchor the grace refresh to the SAME event
        // block as the loan read above. `_resolveGraceEnd` calls
        // `getLoanDetails` at the node's `latest` head; if there's a
        // later partial repay or governance grace change past `scanTo`,
        // we'd write a grace_period_end that contradicts the principal
        // / collateral_amount we just wrote at log.blockNumber. Read
        // `getEffectiveGraceSeconds` at the event block too and
        // compute grace_period_end inline from the loan fields we
        // already have — also saves one RPC call.
        const graceSeconds = Number(
          (await client.readContract({
            address: diamond,
            abi: GRACE_SECONDS_ABI,
            functionName: 'getEffectiveGraceSeconds',
            args: [detail.durationDays],
            blockNumber: log.blockNumber,
          })) as bigint,
        );
        const endTime =
          Number(detail.startTime) + Number(detail.durationDays) * 86400;
        const refreshedGraceEnd = endTime + graceSeconds;
        await env.DB.prepare(
          `UPDATE prepay_listings
             SET grace_period_end = ?, updated_at = ?
           WHERE chain_id = ? AND loan_id = ?`,
        )
          .bind(refreshedGraceEnd, now, chainId, loanId)
          .run();
      }
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
      // Preclose Option 2 — the borrower obligation moves to a new borrower;
      // the loan stays Active. #749: this BURNS the old borrower position NFT
      // and MINTS a FRESH `newBorrowerTokenId` (LibLoan.migrateBorrowerPosition),
      // so the plain Transfer handler — which matches `WHERE borrower_token_id =
      // ?` against the row's OLD id — can't follow the migration. Update the
      // canonical `borrower`, the immutable position-token id, AND the
      // current-owner together so the read routes attribute the loan to the new
      // borrower (and not the exited one). The mint Transfer for the new id is a
      // no-op until this write lands; this write is the authoritative one.
      await env.DB.prepare(
        `UPDATE loans
            SET borrower = ?, borrower_token_id = ?, borrower_current_owner = ?,
                updated_at = ?
          WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          String(a.newBorrower as string).toLowerCase(),
          String(a.newBorrowerTokenId as bigint),
          String(a.newBorrower as string).toLowerCase(),
          Math.floor(Date.now() / 1000),
          chainId,
          Number(a.loanId as bigint),
        )
        .run();
    } else if (log.eventName === 'LoanSold') {
      // EarlyWithdrawal — the lender position is sold to a new lender; the loan
      // stays Active. #749: like the obligation transfer, this BURNS the old
      // lender position NFT and MINTS a FRESH `newLenderTokenId`
      // (LibLoan.migrateLenderPosition), so the Transfer handler can't follow it.
      // Update `lender`, the position-token id, AND the current-owner together so
      // the read routes attribute the loan to the new lender. (Previously
      // allowlisted as "covered by the Transfer handler" — it was NOT, since the
      // token id migrates.)
      await env.DB.prepare(
        `UPDATE loans
            SET lender = ?, lender_token_id = ?, lender_current_owner = ?,
                updated_at = ?
          WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          String(a.newLender as string).toLowerCase(),
          String(a.newLenderTokenId as bigint),
          String(a.newLender as string).toLowerCase(),
          Math.floor(Date.now() / 1000),
          chainId,
          Number(a.loanId as bigint),
        )
        .run();
    } else if (log.eventName === 'LoanSaleCompleted') {
      // EarlyWithdrawal TWO-STEP sale-offer flow (`completeLoanSale`): like the
      // direct `sellLoanViaBuyOffer`→`LoanSold` path, it migrates the ORIGINAL
      // loan's lender position (LibLoan.migrateLenderPosition burns the old token
      // + mints a fresh one) — but this event carries ONLY
      // (loanId, originalLender, newLender), NOT the new token id. So read the
      // migrated `lender` + `lenderTokenId` on-chain, block-pinned to THIS event
      // (idempotent re-scan, #760), and repoint
      // lender/lender_token_id/lender_current_owner. Without this the pure-D1
      // wallet routes (#749) would never attribute the loan to a buyer who went
      // through the sale-offer flow. FAIL-CLOSED: a read failure re-throws so the
      // scan aborts before the cursor advances and this event re-processes.
      const loanId = Number(a.loanId as bigint);
      let d: { lender: string; lenderTokenId: bigint };
      try {
        d = (await client.readContract({
          address: diamond,
          abi: DIAMOND_LOAN_DETAILS_ABI,
          functionName: 'getLoanDetails',
          args: [BigInt(loanId)],
          blockNumber: log.blockNumber,
        })) as { lender: string; lenderTokenId: bigint };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[chainIndexer] #749 getLoanDetails(${loanId}) for LoanSaleCompleted failed; aborting scan so the cursor doesn't advance`,
          err,
        );
        throw err;
      }
      const newLender = String(d.lender).toLowerCase();
      await env.DB.prepare(
        `UPDATE loans
            SET lender = ?, lender_token_id = ?, lender_current_owner = ?,
                updated_at = ?
          WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          newLender,
          String(d.lenderTokenId),
          newLender,
          Math.floor(Date.now() / 1000),
          chainId,
          loanId,
        )
        .run();
    } else if (log.eventName === 'LoanDefaulted') {
      const r = await flipLoanStatus(env, chainId, a, log, 'defaulted');
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, Number(a.loanId as bigint));
    } else if (log.eventName === 'LoanLiquidated') {
      const r = await flipLoanStatus(env, chainId, a, log, 'liquidated');
      if (r) statusUpdates++;
      await _deletePrepayListing(env, chainId, Number(a.loanId as bigint));
    } else if (log.eventName === 'BackstopAbsorbedLoan') {
      // #630 backstop Role B — the liquidator-of-last-resort bought out the
      // lender slice of a FallbackPending loan for cash. This is the lender-side
      // terminal: the loan goes Defaulted (the backstop took the collateral; the
      // borrower keeps any residual claim). A co-emitted `LoanSettled` in the same
      // tx (when the borrower has nothing left) then flips defaulted → settled via
      // the handler below. Without this branch an absorbed loan would never leave
      // FallbackPending in the index (it emits no `LenderFundsClaimed`).
      const r = await flipLoanStatus(env, chainId, a, log, 'defaulted');
      if (r) statusUpdates++;
      // Mirror LoanDefaulted/LoanLiquidated: clear any indexed prepay-listing
      // row on this terminal so the frontend can't serve a stale live listing
      // (the on-chain LibPrepayCleanup clear emits no cancel event).
      await _deletePrepayListing(env, chainId, Number(a.loanId as bigint));
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

      // #760 — write each touched loan's ABSOLUTE principal/collateral read
      // block-pinned to THIS event, instead of reading the current D1 row and
      // SUBTRACTING the event notionals. The old read-modify-write delta was
      // non-idempotent under a partial-failure RE-SCAN: the second pass read an
      // already-decremented D1 row and subtracted the same notionals again,
      // corrupting principal/collateral. A `getLoanDetails` pinned to the
      // event's block returns the same post-image on every replay, so the
      // per-leg notionals are no longer needed (the contract's post-image is
      // the source of truth). FAIL-CLOSED (Codex #761 P1): a read failure
      // PROPAGATES so the scan aborts before the cursor advances and this event
      // is re-processed next scan — not swallowed (which would strand the loan).
      async function applyMatch(loanId: number) {
        if (loanId === 0) return; // C is 0 for a 2-way match
        let absPrincipal: bigint;
        let absCollateral: bigint;
        let onchainStatus: number;
        try {
          const d = (await client.readContract({
            address: diamond,
            abi: DIAMOND_LOAN_DETAILS_ABI,
            functionName: 'getLoanDetails',
            args: [BigInt(loanId)],
            blockNumber: log.blockNumber,
          })) as {
            principal: bigint;
            collateralAmount: bigint;
            status: number;
          };
          absPrincipal = BigInt(d.principal);
          absCollateral = BigInt(d.collateralAmount);
          onchainStatus = Number(d.status);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[chainIndexer] #760 getLoanDetails(${loanId}) for InternalMatchExecuted failed; aborting scan so the cursor doesn't advance`,
            err,
          );
          throw err;
        }
        // #762 — decide the terminal status from the loan's ACTUAL on-chain
        // end-of-block status (this same block-pinned read returns the full
        // `Loan`, status included), NOT from the `principal == 0` heuristic. The
        // old heuristic mis-stamped `internal_matched` whenever a loan's
        // principal reached 0 for ANY same-block reason — e.g. a loan PARTIALLY
        // internal-matched then fully repaid/swap-repaid later in the block, or a
        // claim-time match that the lender claim SETTLES in the same block (#766
        // P1). We instead PROJECT the chain's exact terminal status:
        //   InternalMatched(5)→internal_matched, Repaid(1)→repaid, Settled(3)→
        //   settled, Defaulted(2)→defaulted.
        // We do NOT rely on a later same-block handler to flip the row, because
        // not all of them flip an `active` row (e.g. `LoanSettled` only promotes
        // an already-terminal row → settled), which would otherwise strand a
        // settled loan as `active`. Active(0)/FallbackPending(4)/unknown map to
        // `undefined` → a numbers-only refresh that never overwrites status (a
        // partial match stays `active`; a partial rescue stays `fallback_pending`).
        const terminalStatus = LOAN_STATUS_TO_INDEXER_TERMINAL[onchainStatus];
        if (terminalStatus !== undefined) {
          await env.DB.prepare(
            // Guarded to `active`/`fallback_pending` so it's a no-op on re-scan
            // (the row is already terminal) and so #630 holds: the backstop
            // keeper's claim-time auto-dispatch can FULLY rescue a
            // `fallback_pending` loan straight to `internal_matched` with no
            // later claim event, so that row must be promotable here too.
            `UPDATE loans SET principal = ?, collateral_amount = ?, status = ?, terminal_block = ?, terminal_at = ?, updated_at = ? WHERE chain_id = ? AND loan_id = ? AND status IN ('active', 'fallback_pending')`,
          )
            .bind(
              absPrincipal.toString(),
              absCollateral.toString(),
              terminalStatus,
              Number(log.blockNumber),
              now,
              now,
              chainId,
              loanId,
            )
            .run();
          statusUpdates++;
          // T-086 step 12 / Codex P2 round-5 — a terminal loan also clears its
          // prepay listing. The on-chain loan is no longer Active so any
          // subsequent Seaport fill would revert at the executor's
          // `getPrepayContext` check, but the indexed projection needs to mirror
          // the terminal state immediately. (A superseded loan's own terminal
          // handler — LoanRepaid/SwapToRepayExecuted — also deletes the listing;
          // both are idempotent.)
          await _deletePrepayListing(env, chainId, loanId);
        } else {
          // Non-terminal-from-a-match: a genuine PARTIAL match (chain status
          // still `Active`, principal > 0) or a partial rescue of a
          // `fallback_pending` loan. Refresh the absolute principal/collateral
          // and DON'T touch status.
          await env.DB.prepare(
            `UPDATE loans SET principal = ?, collateral_amount = ?, updated_at = ? WHERE chain_id = ? AND loan_id = ?`,
          )
            .bind(
              absPrincipal.toString(),
              absCollateral.toString(),
              now,
              chainId,
              loanId,
            )
            .run();
        }
      }

      await applyMatch(loanIdA);
      await applyMatch(loanIdB);
      await applyMatch(loanIdC);
    } else if (log.eventName === 'PrepayListingPosted') {
      // T-086 step 12 — Seaport prepay-listing INSERT.
      // T-086 step 14 — also persist `conduitKey` + `salt` (event
      // grew two args) and trigger the autonomous OpenSea
      // republish.
      const loanId = Number(a.loanId as bigint);
      const orderHash = String(a.orderHash as `0x${string}`).toLowerCase();
      const askPrice = String(a.askPrice as bigint);
      const conduit = String(a.conduit as Address).toLowerCase();
      const lister = String(a.lister as Address).toLowerCase();
      const conduitKey = String(a.conduitKey as `0x${string}`).toLowerCase();
      const salt = String(a.salt as bigint);
      const pinnedExecutor = String(a.executor as Address).toLowerCase();
      // T-086 Round-5 Block A (#313) — the event now carries the
      // full `FeeLeg[]` as data per §14.6. Decode + persist the
      // schedule + the derived borrower remainder for analytics.
      // For fee-free posts the array is length 0; we still write
      // '[]' (not NULL) so downstream tools can distinguish
      // "fee-free collection" from "haven't decoded yet."
      const feeLegsRaw = (a.feeLegs ?? []) as ReadonlyArray<{
        recipient: Address; startAmount: bigint; endAmount: bigint;
      }>;
      const feeLegsJson = JSON.stringify(
        feeLegsRaw.map(l => ({
          recipient: String(l.recipient).toLowerCase(),
          startAmount: String(l.startAmount),
          endAmount: String(l.endAmount),
        })),
      );
      // T-086 Round-5 Block B (#309) — Dutch-decay fields. The
      // event always carries them (mode=0 stub on fixed-price
      // posts); the `auction_mode` D1 column is the single
      // discriminator the dapp + the cancel-time reconstruction
      // dispatch on.
      const endAskPrice = String(a.endAskPrice as bigint);
      const auctionEndTime = Number(a.auctionEndTime as bigint);
      const auctionMode = Number(a.mode as number);
      // T-086 Round-5 Block A (#313) — the `borrower_remainder`
      // column was intentionally NOT added in migration 0017 (see
      // its NOTE block). Computing it correctly needs an extra
      // `getPrepayContext` RPC for lender/treasury legs the event
      // doesn't carry; rather than persist a wrong value (PR #324
      // Codex + Raja review both flagged this as blocking), we
      // skip the write until a follow-up does the proper math.
      // Resolve `grace_period_end` via a fresh RPC read of
      // `getLoanDetails(loanId)`. The on-chain start_time +
      // durationDays are mutated by RepayFacet.repayPartial
      // (ERC20 rate-reset) and the auto-deduct path; the
      // indexer's `loans` row currently only mirrors `principal`
      // on PartialRepaid so a SQL read could surface stale
      // boundaries. The RPC read is fine on this rare hot-path
      // event. Codex P2 round-2 on PR #304.
      const graceEnd = await _resolveGraceEnd(
        client,
        diamond,
        loanId,
        log.blockNumber, // #763 — pin to the PrepayListingPosted block
      );
      // Use the log's block timestamp (chain-time) for posted_at /
      // updated_at — backfills processed minutes later still
      // anchor to when the listing actually went on-chain. Codex
      // P3 round-1 on PR #304.
      const blockAt = blockTimestamps.get(log.blockNumber) ?? now;
      // T-086 step 14 — try the autonomous OpenSea publish BEFORE
      // the INSERT so the `opensea_published_at` flag can be set
      // in the same row write. The publish call is best-effort —
      // a transient failure populates the row with NULL
      // `opensea_published_at`, which a future cron tick (the
      // sweep) retries. The `unsupported-chain` branch is
      // terminal — we set `0` instead of NULL so the sweep skips
      // the row forever (no quota burn after the 2025-07-23
      // OpenSea testnet sunset). Codex P1 on PR #315.
      const publishResult = await _maybePublishToOpenSea(
        env,
        client,
        diamond,
        chainId,
        loanId,
        String(log.transactionHash as `0x${string}`).toLowerCase() as `0x${string}`,
        BigInt(askPrice),
        BigInt(salt),
        conduitKey as `0x${string}`,
        pinnedExecutor as `0x${string}`,
        orderHash as `0x${string}`,
        // T-086 Round-5 Block A (#313) — Codex P1 (PR #324 review):
        // thread feeLegs through to the JS reconstruction.
        feeLegsRaw.map(l => ({
          recipient: String(l.recipient),
          startAmount: BigInt(l.startAmount),
          endAmount: BigInt(l.endAmount),
        })),
        // T-086 Round-5 Block B (#309) — Dutch params on the
        // posted path. `mode == 0` skips this (publisher takes
        // fixed-price branch).
        auctionMode === 1
          ? {
              startAskPrice: BigInt(askPrice),
              endAskPrice: BigInt(endAskPrice),
              auctionEndTime: BigInt(auctionEndTime),
            }
          : undefined,
      );
      const publishedAt = publishResult.published
        ? blockAt
        : publishResult.unsupportedChain
          ? 0
          : null;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO prepay_listings
           (chain_id, loan_id, order_hash, ask_price, conduit,
            lister, posted_at, updated_at, grace_period_end,
            block_number, tx_hash, log_index,
            conduit_key, salt, opensea_published_at, executor,
            fee_legs_json, end_ask_price, auction_end_time, auction_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          chainId,
          loanId,
          orderHash,
          askPrice,
          conduit,
          lister,
          blockAt,
          blockAt,
          graceEnd,
          Number(log.blockNumber),
          String(log.transactionHash as `0x${string}`).toLowerCase(),
          Number(log.logIndex),
          conduitKey,
          salt,
          publishedAt,
          pinnedExecutor,
          feeLegsJson,
          endAskPrice,
          auctionEndTime,
          auctionMode,
        )
        .run();
    } else if (log.eventName === 'PrepayListingUpdated') {
      // Update is a re-sign. UPSERT (not UPDATE) so a re-sign
      // observed AFTER an indexer-rollout boundary — where the
      // original `PrepayListingPosted` was missed — still
      // materialises the row from the event payload. Codex P2
      // round-1 on PR #304.
      // T-086 step 14 — also persist the fresh `newConduitKey` +
      // `newSalt` (event grew two args) and re-run the
      // autonomous OpenSea publish; reset `opensea_published_at`
      // to NULL since the orderHash rotated.
      const loanId = Number(a.loanId as bigint);
      const newOrderHash = String(a.newOrderHash as `0x${string}`).toLowerCase();
      const newAskPrice = String(a.newAskPrice as bigint);
      const conduit = String(a.conduit as Address).toLowerCase();
      const lister = String(a.lister as Address).toLowerCase();
      const newConduitKey = String(a.newConduitKey as `0x${string}`).toLowerCase();
      const newSalt = String(a.newSalt as bigint);
      const newPinnedExecutor = String(a.executor as Address).toLowerCase();
      const blockAt = blockTimestamps.get(log.blockNumber) ?? now;
      // T-086 Round-5 Block A (#313) — decode the new fee legs +
      // re-derive borrower remainder (same shape as the Posted
      // handler above; the update path re-signs the order with a
      // potentially-changed fee schedule per §15.3 step 5 + Round-
      // 5.1 errata's English re-derivation rule).
      const feeLegsRaw = (a.feeLegs ?? []) as ReadonlyArray<{
        recipient: Address; startAmount: bigint; endAmount: bigint;
      }>;
      const feeLegsJson = JSON.stringify(
        feeLegsRaw.map(l => ({
          recipient: String(l.recipient).toLowerCase(),
          startAmount: String(l.startAmount),
          endAmount: String(l.endAmount),
        })),
      );
      // T-086 Round-5 Block B (#309) — Dutch-decay fields. The
      // update event uses `newEndAskPrice` / `newAuctionEndTime`
      // for the rotated stamps; the mode tag is still `mode` (no
      // prefix). For fixed-price updates `mode==0` and
      // `newAuctionEndTime==0`; for Dutch updates the values are
      // the freshly-signed Dutch params.
      const endAskPrice = String(a.newEndAskPrice as bigint);
      const auctionEndTime = Number(a.newAuctionEndTime as bigint);
      const auctionMode = Number(a.mode as number);
      // T-086 Round-5 Block A (#313) — see Posted-handler note;
      // the borrower_remainder column is intentionally NOT
      // written here either.
      // RPC-resolve fresh grace_period_end for the
      // backfill-INSERT case. Same reasoning as the Posted
      // handler — start_time + duration_days can drift after
      // partial repayment / auto-deduct.
      const graceEnd = await _resolveGraceEnd(
        client,
        diamond,
        loanId,
        log.blockNumber, // #763 — pin to the PrepayListingUpdated block
      );
      // T-086 step 14 — try the autonomous publish for the
      // rotated orderHash. Transient failure stays NULL (sweep
      // retries); unsupported-chain is terminal so we set 0 to
      // skip the sweep. Codex P1 on PR #315.
      const publishResult = await _maybePublishToOpenSea(
        env,
        client,
        diamond,
        chainId,
        loanId,
        String(log.transactionHash as `0x${string}`).toLowerCase() as `0x${string}`,
        BigInt(newAskPrice),
        BigInt(newSalt),
        newConduitKey as `0x${string}`,
        newPinnedExecutor as `0x${string}`,
        newOrderHash as `0x${string}`,
        // T-086 Round-5 Block A (#313) — same feeLegs threading
        // as the Posted handler. The update path's fee schedule
        // can differ from the original post's (per §15.3 errata's
        // re-fetch rule on fee-enforced collections).
        feeLegsRaw.map(l => ({
          recipient: String(l.recipient),
          startAmount: BigInt(l.startAmount),
          endAmount: BigInt(l.endAmount),
        })),
        // T-086 Round-5 Block B (#309) — Dutch params on the
        // update path. Mirror of the Posted handler.
        auctionMode === 1
          ? {
              startAskPrice: BigInt(newAskPrice),
              endAskPrice: BigInt(endAskPrice),
              auctionEndTime: BigInt(auctionEndTime),
            }
          : undefined,
      );
      const publishedAt = publishResult.published
        ? blockAt
        : publishResult.unsupportedChain
          ? 0
          : null;
      // Try a `posted_at`-preserving UPDATE first (the common
      // case — the row exists from a prior Posted event); fall
      // back to an INSERT when no row exists (the rollout-
      // backfill case).
      // Updated path now ALSO refreshes `grace_period_end` (Codex
      // P2 round-3): a re-sign typically follows a partial
      // repayment that mutated startTime / durationDays, so the
      // grace boundary moved. Include the freshly RPC-resolved
      // value in the UPDATE.
      const upd = await env.DB.prepare(
        `UPDATE prepay_listings
           SET order_hash = ?, ask_price = ?, conduit = ?, lister = ?,
               updated_at = ?, grace_period_end = ?,
               block_number = ?, tx_hash = ?, log_index = ?,
               conduit_key = ?, salt = ?, opensea_published_at = ?,
               executor = ?, fee_legs_json = ?,
               end_ask_price = ?, auction_end_time = ?, auction_mode = ?
         WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(
          newOrderHash,
          newAskPrice,
          conduit,
          lister,
          blockAt,
          graceEnd,
          Number(log.blockNumber),
          String(log.transactionHash as `0x${string}`).toLowerCase(),
          Number(log.logIndex),
          newConduitKey,
          newSalt,
          publishedAt,
          newPinnedExecutor,
          feeLegsJson,
          endAskPrice,
          auctionEndTime,
          auctionMode,
          chainId,
          loanId,
        )
        .run();
      if ((upd.meta?.changes ?? 0) === 0) {
        // No row to update — the Posted event must have been
        // missed (rollout window). Materialise from the Updated
        // payload, anchoring `posted_at` to the current event's
        // blockAt as a best-effort proxy (the true post time
        // isn't recoverable without an RPC scan).
        await env.DB.prepare(
          `INSERT OR REPLACE INTO prepay_listings
             (chain_id, loan_id, order_hash, ask_price, conduit,
              lister, posted_at, updated_at, grace_period_end,
              block_number, tx_hash, log_index,
              conduit_key, salt, opensea_published_at, executor,
              fee_legs_json, end_ask_price, auction_end_time, auction_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            chainId,
            loanId,
            newOrderHash,
            newAskPrice,
            conduit,
            lister,
            blockAt,
            blockAt,
            graceEnd,
            Number(log.blockNumber),
            String(log.transactionHash as `0x${string}`).toLowerCase(),
            Number(log.logIndex),
            newConduitKey,
            newSalt,
            publishedAt,
            newPinnedExecutor,
            feeLegsJson,
            endAskPrice,
            auctionEndTime,
            auctionMode,
          )
          .run();
      }
    } else if (log.eventName === 'PrepayListingCanceled') {
      // Cancel (borrower / grace-expired) terminates the listing
      // WITHOUT closing the loan — loan stays Active until a
      // separate terminal (repay / default / liquidation) fires.
      const loanId = Number(a.loanId as bigint);
      await env.DB.prepare(
        `DELETE FROM prepay_listings WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, loanId)
        .run();
    } else if (log.eventName === 'PrepayCollateralSaleSettled') {
      // Successful Seaport fill: loan went Active → Settled
      // ATOMICALLY in `PrepayListingFacet.executorFinalizePrepaySale`
      // — there is no separate claim step nor a follow-up
      // `LoanSettled` event the indexer can wait for. So we flip
      // directly to `settled` here (NOT `repaid`); otherwise the
      // claimables query (`status IN ('repaid','defaulted','liquidated')`)
      // would treat the loan as forever-claimable. Codex P1
      // round-1 on PR #304.
      const loanId = Number(a.loanId as bigint);
      await env.DB.prepare(
        `DELETE FROM prepay_listings WHERE chain_id = ? AND loan_id = ?`,
      )
        .bind(chainId, loanId)
        .run();
      const blockAt = blockTimestamps.get(log.blockNumber) ?? now;
      const r = await env.DB.prepare(
        `UPDATE loans
           SET status = 'settled', terminal_block = ?, terminal_at = ?, updated_at = ?
         WHERE chain_id = ? AND loan_id = ? AND status = 'active'`,
      )
        .bind(
          Number(log.blockNumber),
          blockAt,
          now,
          chainId,
          loanId,
        )
        .run();
      if ((r.meta?.changes ?? 0) > 0) statusUpdates++;
    } else if (log.eventName === 'PrepayListingMatched') {
      // T-086 Round-6 / Block D (#345) — atomic match-rotation
      // settlement breadcrumb. The on-chain
      // `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` emits this
      // alongside the standard `PrepayCollateralSaleSettled` in the
      // SAME tx (the atomic match settles via
      // `Seaport.matchAdvancedOrders` which fires the executor's
      // zone callback → `executorFinalizePrepaySale` → loan flip).
      // We write to `prepay_listing_match_breadcrumbs` with
      // `match_mode = 'atomic'`, NOT to `prepay_listings.matched_via`,
      // because the same-tx `PrepayCollateralSaleSettled` handler
      // above deletes the `prepay_listings` row before any
      // downstream reader sees it (Round-6 design doc §17.18 D.3 +
      // Codex round-9 P3 #344 durability fix).
      //
      // The atomic path explicitly does NOT fire the #335 dapp-side
      // POST (race-window prevention per §17.13), so this handler is
      // the SOLE signal source for atomic matches — there is no
      // overwrite race with the default 'v1-twostep' value.
      //
      // The bidder's per-fee-recipient breakdown comes from
      // Seaport's canonical `OrderFulfilled(bidderOrderHash, ...)`
      // event in the same tx; the bidder field on this event is the
      // gross bidder identity (Seaport `offerer`).
      const loanId = Number(a.loanId as bigint);
      const bidderOrderHash = (a.bidderOrderHash as string).toLowerCase();
      const bidder = (a.bidder as string).toLowerCase();
      const matchedAt = blockTimestamps.get(log.blockNumber) ?? now;
      await env.DB.prepare(
        `INSERT INTO prepay_listing_match_breadcrumbs
            (chain_id, tx_hash, loan_id, order_hash, bidder, matched_at, match_mode)
         VALUES (?, ?, ?, ?, ?, ?, 'atomic')
         ON CONFLICT(chain_id, tx_hash) DO UPDATE SET
            match_mode = excluded.match_mode,
            order_hash = excluded.order_hash,
            bidder     = excluded.bidder,
            loan_id    = excluded.loan_id,
            matched_at = excluded.matched_at`,
      )
        .bind(
          chainId,
          log.transactionHash,
          loanId,
          bidderOrderHash,
          bidder,
          matchedAt,
        )
        .run();
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
      // #749 — apply EVERY Transfer, INCLUDING burns (`to = 0x0`). A position
      // NFT is burned when its side claims (ClaimFacet) — writing `to` (the
      // zero address) into `*_current_owner` makes a burned position stop
      // matching the `WHERE *_current_owner = <wallet>` read predicate (a real
      // wallet is never `0x0`), so the claimed/closed position correctly drops
      // out of /loans/by-lender|by-borrower and /claimables. (Previously burns
      // were skipped, leaving the last live holder — they'd keep showing the
      // claimed position as still held.) The same tokenId sits on at most one
      // of the three rows; the others no-op.
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
  // T-086 Round-8 §19.7e + Codex round-16 P2 #2 — `OfferConsumedBySale`
  // events carry only (offerId, executor) in args. The executor is the
  // protocol's CollateralListingExecutor singleton — never the
  // borrower (the offer creator who SHOULD see the row in their
  // Activity feed). The dapp's `indexedToActivityEvent` derives
  // participants from `args` + the indexer's `actor`; without an
  // enriched args bag the borrower's wallet never lands in
  // participants and the Activity feed silently hides the sold-row
  // from the borrower. Pre-fetch the creator from the `offers` table
  // in one batched lookup before the row INSERTs so the per-row D1
  // round-trips stay bounded. Same-batch races (OfferCreated +
  // OfferConsumedBySale in the same indexer batch) leave creator
  // null and the borrower hidden — matches the pre-fix behaviour,
  // not a new degradation.
  const consumedOfferIds = new Set<number>();
  for (const log of logs) {
    if (log.eventName === 'OfferConsumedBySale') {
      const id = Number((log.args as Record<string, unknown>).offerId as bigint);
      if (Number.isFinite(id)) consumedOfferIds.add(id);
    }
  }
  const creatorByOfferId = new Map<number, string>();
  if (consumedOfferIds.size > 0) {
    const placeholders = Array.from(consumedOfferIds, () => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT offer_id, creator FROM offers
        WHERE chain_id = ? AND offer_id IN (${placeholders})`,
    )
      .bind(chainId, ...Array.from(consumedOfferIds))
      .all<{ offer_id: number; creator: string }>();
    for (const r of rows.results ?? []) {
      creatorByOfferId.set(r.offer_id, r.creator);
    }
  }

  let inserted = 0;
  for (const log of logs) {
    let args = log.args;
    if (log.eventName === 'OfferConsumedBySale') {
      const id = Number((args as Record<string, unknown>).offerId as bigint);
      const creator = creatorByOfferId.get(id);
      if (creator) {
        // Add `creator` so the dapp's `indexedToActivityEvent`
        // address-walk surfaces the borrower in participants.
        args = { ...args, creator };
      }
    }
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
/// @dev Minimal ABI for the on-chain
///      `ConfigFacet.getEffectiveGraceSeconds(durationDays)` view.
///      Inlined here (not pulled in via the full ConfigFacet ABI)
///      because the indexer only needs this one function. Honors
///      the governance-tunable grace schedule
///      (`ConfigFacet.setGraceBuckets`) — fixes the "default-only"
///      drift Codex round-3 P2 flagged.
const GRACE_SECONDS_ABI = [
  {
    type: 'function',
    name: 'getEffectiveGraceSeconds',
    stateMutability: 'view',
    // On-chain signature is `uint256 durationDays` (per
    // ConfigFacet.sol:1969). A mismatch here would compile a
    // different 4-byte selector and the RPC would 404 silently,
    // falling back to the `graceEnd = 0` sentinel. Codex P2
    // round-4 on PR #304.
    inputs: [{ name: 'durationDays', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/// @dev RPC-read the loan's CURRENT `startTime + durationDays`
///      AND the on-chain effective grace-seconds for that
///      durationDays. Reading from RPC (not the indexer's cached
///      `loans` row) is the correct source — `RepayFacet.repayPartial`
///      resets `startTime` for ERC20 loans and reduces
///      `durationDays` for NFT rentals; governance can also flip
///      the grace schedule via `ConfigFacet.setGraceBuckets`.
///      Falls back to `0` (sentinel) on RPC failure, with a
///      console.error.
async function _resolveGraceEnd(
  client: PublicClient,
  diamond: Address,
  loanId: number,
  /** #763 — pin BOTH reads to the triggering event's block so a
   *  partial-failure re-scan (or a cron catch-up that runs an old block range
   *  after later blocks were seen) computes the grace boundary from the loan's
   *  state AT that event, not a post-`scanTo` `latest` that a subsequent partial
   *  repay / governance `setGraceBuckets` could have moved. Omit (undefined) to
   *  read `latest` — viem treats an absent `blockNumber` as the latest head. */
  blockNumber?: bigint,
): Promise<number> {
  try {
    const detail = (await client.readContract({
      address: diamond,
      abi: DIAMOND_LOAN_DETAILS_ABI,
      functionName: 'getLoanDetails',
      args: [BigInt(loanId)],
      blockNumber,
    })) as { startTime: bigint; durationDays: number | bigint };
    const startTime = Number(detail.startTime);
    const durationDays = Number(detail.durationDays);
    const graceSeconds = Number(
      (await client.readContract({
        address: diamond,
        abi: GRACE_SECONDS_ABI,
        functionName: 'getEffectiveGraceSeconds',
        args: [BigInt(durationDays)],
        blockNumber,
      })) as bigint,
    );
    return startTime + durationDays * 86_400 + graceSeconds;
  } catch (err) {
    // #763 (Codex #767 P2) — a block-pinned read can fail when the RPC can't
    // serve HISTORICAL state for `blockNumber` on a catch-up (non-archive /
    // transient). Do NOT persist the `0` sentinel for that — it'd advance the
    // cursor with a permanently-wrong "unknown grace end". Fall back to a
    // `latest` read (the pre-#763 behaviour: a possibly-slightly-stale but
    // PRESENT boundary); only a total RPC failure reaches the `0` sentinel.
    if (blockNumber !== undefined) {
      console.warn(
        `[chainIndexer] _resolveGraceEnd(${loanId}) block-pinned read failed; retrying at latest`,
        err,
      );
      return _resolveGraceEnd(client, diamond, loanId);
    }
    console.error(`[chainIndexer] _resolveGraceEnd(${loanId}) failed`, err);
    return 0; // Sentinel — the frontend treats 0 as "unknown grace end".
  }
}

/// @dev T-086 step 14 — best-effort autonomous OpenSea republish
///      called from the `PrepayListingPosted` and
///      `PrepayListingUpdated` handlers. Never throws — failures
///      land in console.error and leave `opensea_published_at`
///      NULL on the prepay_listings row so a future cron tick can
///      retry (#311 covers the explicit retry loop). Returns
///      `{ published: true }` when OpenSea returned 2xx so the
///      handler can flip the persisted flag.
async function _maybePublishToOpenSea(
  env: Env,
  client: PublicClient,
  diamond: Address,
  chainId: number,
  loanId: number,
  txHash: `0x${string}`,
  askPrice: bigint,
  salt: bigint,
  conduitKey: `0x${string}`,
  executor: `0x${string}`,
  expectedOrderHash: `0x${string}`,
  // T-086 Round-5 Block A (#313) — pass the recorded fee legs
  // through so the autonomous-publish JS reconstruction matches
  // the on-chain hash on fee-enforced collections. Empty for
  // fee-free posts.
  feeLegs: ReadonlyArray<{ recipient: string; startAmount: bigint; endAmount: bigint }>,
  // T-086 Round-5 Block B (#309) — Dutch params. Undefined for
  // fixed-price posts (the publish helper falls back to the
  // Round-4 fixed-price shape verbatim). Defined when the event's
  // `mode == PREPAY_MODE_DUTCH (1)`; the publish helper reads
  // pctx at `auctionEndTime` to get the projected protocol legs
  // that match the on-chain signed hash. `projectedLenderLeg` and
  // `projectedTreasuryLeg` are derived inside the helper from
  // that pctx read — the caller only supplies the three event-
  // derived values.
  dutch?: { startAskPrice: bigint; endAskPrice: bigint; auctionEndTime: bigint },
): Promise<{ published: boolean; unsupportedChain: boolean }> {
  try {
    const result = await indexerPublishPrepayListing(
      {
        publicClient: client,
        diamondAddress: diamond as `0x${string}`,
        chainId,
        loanId: BigInt(loanId),
        txHash,
        askPrice,
        salt,
        conduitKey,
        executor,
        expectedOrderHash,
        feeLegs,
        dutch: dutch
          ? {
              startAskPrice: dutch.startAskPrice,
              endAskPrice: dutch.endAskPrice,
              // The helper re-derives these from its pctx read at
              // `auctionEndTime`; we pass 0n stubs here and the
              // helper overwrites them.
              projectedLenderLeg: 0n,
              projectedTreasuryLeg: 0n,
              auctionEndTime: dutch.auctionEndTime,
            }
          : undefined,
      },
      env,
    );
    if (!result.published) {
      console.warn(
        `[chainIndexer] OpenSea publish failed loan=${loanId} chain=${chainId}: ${result.error}`,
      );
    }
    // Surface the unsupported-chain case to the handler so it can
    // mark the row terminal (`opensea_published_at = 0`) and stop
    // the sweep from re-trying it forever (Codex P1 on PR #315).
    const unsupportedChain =
      !result.published &&
      (result.error?.startsWith('unsupported-chain') ?? false);
    return { published: result.published, unsupportedChain };
  } catch (err) {
    console.error(
      `[chainIndexer] _maybePublishToOpenSea(${loanId}) threw`,
      err,
    );
    return { published: false, unsupportedChain: false };
  }
}

/// @dev T-086 step 12 / Codex P2 round-2: delete any live
///      prepay-listing row for `loanId` on EVERY terminal-event
///      handler that closes the loan (LoanRepaid /
///      LoanPreclosedDirect / OffsetCompleted / LoanRefinanced /
///      LoanDefaulted / LoanLiquidated). The Seaport executor's
///      zone callback already gates on `loan.status == Active`,
///      so a later fill against the stale orderHash would revert
///      on-chain — but the indexer's `prepay_listings` row
///      would still show the listing as live to the frontend
///      until someone explicitly cancelled. This cleanup keeps
///      the indexed projection consistent with the on-chain
///      truth as soon as the closing event lands.
async function _deletePrepayListing(
  env: Env,
  chainId: number,
  loanId: number,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM prepay_listings WHERE chain_id = ? AND loan_id = ?`,
  )
    .bind(chainId, loanId)
    .run();
}

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
    case 'OfferMatched':
      // #600 — a matcher-driven fill calls `acceptOfferInternal(borrowerOfferId)`,
      // so the companion `OfferAccepted` (and the loan's own `offerId`) attribute
      // the loan to the BORROWER offer. The LENDER offer's only link to the child
      // loan is this event, which carries both `lenderOfferId` and `loanId`.
      // Denormalize the row to the LENDER offer so `/activity?offerId=<lenderId>&
      // kind=OfferMatched` enumerates its matched children (the borrower side is
      // already covered by `OfferAccepted`).
      return {
        actor: (args.matcher as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: Number(args.lenderOfferId as bigint),
      };
    case 'OfferCanceled':
      return {
        actor: (args.creator as string)?.toLowerCase() ?? null,
        loanId: null,
        offerId: Number(args.offerId as bigint),
      };
    case 'OfferConsumedBySale':
      // T-086 Round-8 (#358) §19.7 + Codex round-19 P2 #3 — Scenario A
      // terminal. The event carries (offerId, executor); `executor` is
      // the protocol's Seaport-conformant executor singleton (never a
      // real user), so it's useless as the `actor` filter target. The
      // BORROWER (= offer creator) is who needs to see this row when
      // querying `/activity?actor=<wallet>`. We rely on the
      // `recordActivityEvents` enrichment pass having put the
      // `creator` field into `args` (looked up from the `offers`
      // table) before this mapper runs — `actor = creator` then
      // makes server-side per-wallet filters surface the sold row to
      // the borrower as expected. The `executor` address stays in
      // `args.executor` for the unfiltered Activity feed's
      // address-walk participant derivation.
      return {
        actor:
          (args.creator as string | undefined)?.toLowerCase() ??
          (args.executor as string)?.toLowerCase() ??
          null,
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
    // T-092 Phase 3 (#503) Codex round-4 P2 — `caller` is the
    // address that initiated the extension (the keeper, or the
    // borrower-NFT owner extending directly). Indexed on-chain so
    // `pluckActivityRefs` can return it as the activity actor.
    // Without this, `?actor=...` filters would miss direct
    // borrower self-extensions because `DecodedLog` doesn't store
    // `msg.sender`.
    case 'LoanExtended':
      return {
        actor: (args.caller as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    // T-090 Sub 2 — `borrower` is `msg.sender` (current borrower-NFT
    // owner), the load-bearing authority root for the swap-to-repay
    // surface (see SwapToRepayFacet round-3 P2 #1).
    case 'SwapToRepayExecuted':
    case 'SwapToRepayPartialExecuted':
      return {
        actor: (args.borrower as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    // T-090 v1.1 (#389) Sub 2 (#417) — borrower-attributed events.
    case 'SwapToRepayIntentCommitted':
      return {
        actor: (args.committedBy as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'SwapToRepayIntentCancelled':
      return {
        actor: (args.cancelledBy as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    // `Filled` attributed to the borrower who originated the
    // commit, NOT the Fusion solver who actually submitted the
    // fill tx (Codex round-1 PR #421 P2 — the Activity feed's
    // close-out row must reach the connected borrower, otherwise
    // they lose visibility of their own successful repay). The
    // `committedBy` field on `args` is stashed by the indexer
    // dispatcher BEFORE the row delete that releases it — see the
    // `SwapToRepayIntentFilled` branch in `processLoanLogs`.
    case 'SwapToRepayIntentFilled':
      return {
        actor: (args.committedBy as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    // `ForceCancelled` stays system-attributed — the cancel was
    // triggered by the liquidation / time-default entry point
    // (`source` is the facet's diamond address, not a user). The
    // downstream `LoanLiquidated` / `LoanDefaulted` event carries
    // the activity-feed attribution for the lender-protection
    // action that drove it.
    case 'SwapToRepayIntentForceCancelled':
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
    case 'BackstopAbsorbedLoan':
      // #630 backstop Role B — surface the cash buyout on the loan timeline and
      // the lender's activity feed. Actor = the paid lender-NFT owner.
      return {
        actor: (args.lenderNftOwner as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'IntentLoanRolled':
      // #393 v1-d.2 auto-roll. When the borrower hasn't claimed yet the loan
      // stays Repaid, so this is the only signal the lender side closed (the
      // proceeds were re-liened into the owner's intent capital and the lender
      // NFT burned). Actor = the intent owner whose loan rolled, so it surfaces
      // on `/activity?actor=<wallet>`.
      return {
        actor: (args.owner as string)?.toLowerCase() ?? null,
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
    // T-086 step 12 — prepay-listing events. The on-chain payloads
    // use slightly different field names: Posted carries `lister`,
    // Updated carries `lister`, Canceled carries `caller`,
    // PrepayCollateralSaleSettled carries `executor`. The loan_id is
    // present on all four. Codex P2 round-2 on PR #304.
    case 'PrepayListingPosted':
    case 'PrepayListingUpdated':
      return {
        actor: (args.lister as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'PrepayListingCanceled':
      return {
        actor: (args.caller as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    case 'PrepayCollateralSaleSettled':
      return {
        actor: (args.executor as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
        offerId: null,
      };
    // T-086 Round-6 / Block D (#345) — atomic match-rotation event.
    // The borrower (msg.sender) clicked Match; `matcher` is the
    // canonical actor for activity-feed purposes.
    case 'PrepayListingMatched':
      return {
        actor: (args.matcher as string)?.toLowerCase() ?? null,
        loanId: Number(args.loanId as bigint),
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
    loanDetailRefreshes: 0,
    activityEvents: 0,
    skipped,
  };
}
