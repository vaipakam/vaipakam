/**
 * On-chain catch-up for the shared Offer Book (#1029 — the port of
 * apps/defi's rpcCatchUp delta merge).
 *
 * The indexer is a CACHE: during any ingest lag the shared book can
 * keep rendering an offer that was just accepted, cancelled, matched,
 * or consumed by a loan sale — and a naive user who picks it hits a
 * revert. This module scans the chain tail the cache hasn't ingested
 * yet (`stats.lastBlock + 1 … latest`) for offer TERMINAL events and
 * strips those ids from the indexed rows before anything renders.
 *
 * Deliberate properties, shared with defi's mechanism:
 *   - TERMINAL-REMOVAL ONLY. OfferCreated is not scanned: a brand-new
 *     offer surfaces on the next indexer refetch / push signal, and
 *     hydrating full rows per-id from the chain here would duplicate
 *     the indexer's job. Removal is the honesty-critical half — a
 *     ghost row invites a doomed transaction; a missing-for-30s new
 *     row does not.
 *   - FAIL-OPEN EVERYWHERE. A failed stats read, block read, or log
 *     scan returns the rows unfiltered — the book renders pure cache
 *     state (exactly today's behaviour), never flips to unavailable
 *     because of the catch-up layer. A partial chunked scan keeps the
 *     chunks that succeeded.
 *   - Topic0 hashes are DERIVED from the compiled ABI, never
 *     hand-written signature strings: defi's original hardcoded
 *     `OfferAccepted(uint256,address,uint256)` had silently stopped
 *     matching when the event grew fields — keccak of a stale string
 *     matches nothing and fail-open hides the miss. Deriving from
 *     `DIAMOND_ABI_VIEM` makes an ABI drift a compile/test failure,
 *     not a silent no-op.
 */
import { getAbiItem, numberToHex, toEventSelector } from 'viem';
import type { AbiEvent, Hex, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import {
  fetchIndexerFreshness,
  indexerConfigured,
  type IndexedOffer,
} from './indexer';

/** Serialized 1000-block windows — public RPCs cap eth_getLogs
 *  ranges, and serial requests keep a refocused background tab from
 *  tripping per-second rate limits. */
const CHUNK_BLOCKS = 1000n;

/** If the cache is further behind than this, skip the catch-up scan
 *  entirely (rendering pure cache state) rather than hammering the
 *  RPC with dozens of scans from the browser — MarketFreshnessNote
 *  already tells the user the lists are running behind in that
 *  state. */
const MAX_CATCHUP_BLOCKS = 20_000n;

function eventTopic0(name: string): Hex {
  const item = getAbiItem({ abi: DIAMOND_ABI_VIEM, name }) as
    | AbiEvent
    | undefined;
  if (!item || item.type !== 'event') {
    // Compile-adjacent guard: the fork-tier spec exercises a real
    // terminal event through this table, so a renamed event fails CI
    // loudly instead of silently matching nothing.
    throw new Error(`event ${name} not found in DIAMOND_ABI_VIEM`);
  }
  return toEventSelector(item);
}

/** Every event that ends an offer's active life. All carry the offer
 *  id as their first INDEXED argument (topics[1]):
 *  OfferAccepted / OfferCanceled / OfferClosed (emitted on both
 *  cancel and range-match) / OfferConsumedBySale (loan-sale
 *  settlement; uint96 id, same 32-byte topic encoding). */
export function offerTerminalTopics(): Hex[] {
  return [
    eventTopic0('OfferAccepted'),
    eventTopic0('OfferCanceled'),
    eventTopic0('OfferClosed'),
    eventTopic0('OfferConsumedBySale'),
  ];
}

interface RawLog {
  topics: Hex[];
  blockNumber: Hex | null;
  removed?: boolean;
}

/** Raw eth_getLogs (not viem's typed getLogs) so several event types
 *  OR-merge into ONE request via a topic0 array. Serialized chunks;
 *  a chunk failure returns what already succeeded (fail-open — the
 *  missing window lands on the next cache refresh). */
export async function chunkedGetLogs(
  publicClient: PublicClient,
  params: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
    topics: Hex[];
  },
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  if (params.toBlock < params.fromBlock) return out;
  for (let from = params.fromBlock; from <= params.toBlock; ) {
    const to =
      from + CHUNK_BLOCKS - 1n < params.toBlock
        ? from + CHUNK_BLOCKS - 1n
        : params.toBlock;
    try {
      const logs = (await publicClient.request({
        method: 'eth_getLogs',
        params: [
          {
            address: params.address,
            fromBlock: numberToHex(from),
            toBlock: numberToHex(to),
            topics: [params.topics],
          },
        ],
      })) as RawLog[];
      out.push(...logs);
    } catch {
      return out;
    }
    from = to + 1n;
  }
  return out;
}

/** Offer ids from terminal logs — first indexed arg for every event
 *  in the terminal set. Reorged (`removed`) logs are skipped. */
export function decodeTerminalOfferIds(logs: RawLog[]): Set<number> {
  const ids = new Set<number>();
  for (const log of logs) {
    if (log.removed) continue;
    if (!log.topics || log.topics.length < 2) continue;
    ids.add(Number(BigInt(log.topics[1])));
  }
  return ids;
}

export interface CatchUpTarget {
  chainId: number;
  diamondAddress: `0x${string}`;
  deployBlock: number;
  publicClient: PublicClient | undefined;
}

/** The merge: strip offers the chain says are already terminal from
 *  the indexed rows. Every failure path returns `rows` unchanged. */
export async function filterTerminalOffers(
  rows: IndexedOffer[],
  target: CatchUpTarget,
): Promise<IndexedOffer[]> {
  try {
    if (!target.publicClient || rows.length === 0 || !indexerConfigured()) {
      return rows;
    }
    const fresh = await fetchIndexerFreshness(target.chainId);
    if (!fresh) return rows;
    const fromBlock = BigInt(Math.max(fresh.lastBlock + 1, target.deployBlock));
    const toBlock = await target.publicClient.getBlockNumber();
    if (toBlock < fromBlock) return rows;
    if (toBlock - fromBlock + 1n > MAX_CATCHUP_BLOCKS) return rows;
    const logs = await chunkedGetLogs(target.publicClient, {
      address: target.diamondAddress,
      fromBlock,
      toBlock,
      topics: offerTerminalTopics(),
    });
    if (logs.length === 0) return rows;
    const terminal = decodeTerminalOfferIds(logs);
    return rows.filter((o) => !terminal.has(o.offerId));
  } catch {
    return rows;
  }
}
