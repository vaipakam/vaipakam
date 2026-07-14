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
import { decodeEventLog, numberToHex, toEventSelector } from 'viem';
import type { AbiEvent, Hex, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { IndexedOffer, IndexerFreshness } from './indexer';

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

/** Upper bound = latest minus a small settling buffer, NOT the
 *  safe/finalized tag. The buffer keeps a terminal event seen in a
 *  reorgable tip block from stripping a row that is live again after
 *  the reorg (reorged logs also carry `removed`, which the decoder
 *  skips). The safe tag is unusable as this bound: anvil forks
 *  freeze it at the forked block (the 577a3a9 CI run proved it —
 *  toBlock < fromBlock, scan silently skipped), some RPCs don't
 *  serve it, and on healthy ingest the cache cursor routinely runs
 *  AHEAD of safe, emptying the window exactly when the scan matters.
 *  On the single-sequencer OP-stack chains this app targets, depth-2
 *  reorgs of the sequencer tip effectively don't happen outside
 *  catastrophic L1 events — and the failure mode is a ~4s flicker
 *  followed by the next refetch, not a wrong transaction. */
const CONFIRMATION_BUFFER = 2n;

function findEvent(name: string): AbiEvent {
  // Type-aware lookup — NOT getAbiItem, whose name-only search can
  // return a same-named custom ERROR (OfferConsumedBySale exists as
  // both an event and a revert error in the Diamond ABI; spec 10's
  // first CI run caught exactly that).
  const item = DIAMOND_ABI_VIEM.find(
    (i): i is AbiEvent => i.type === 'event' && i.name === name,
  );
  if (!item) {
    // The fork-tier spec exercises a real terminal event through this
    // table AND drift-checks each name, so a renamed event fails CI
    // loudly instead of silently matching nothing.
    throw new Error(`event ${name} not found in DIAMOND_ABI_VIEM`);
  }
  return item;
}

function eventTopic0(name: string): Hex {
  return toEventSelector(findEvent(name));
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
  data: Hex;
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
 *  in the terminal set. Reorged (`removed`) logs are skipped.
 *
 *  OfferAccepted needs its data DECODED, not just topic-matched: the
 *  partial-fill range-order path emits it with `newAccepted=false`
 *  while the offer stays live (the contract passes `offer.accepted`
 *  as that arg), and stripping such an offer would over-filter —
 *  exactly what the no-over-filter contract forbids. An accepted log
 *  whose data can't be decoded is SKIPPED for the same reason: when
 *  in doubt, leave the row alone. */
export function decodeTerminalOfferIds(logs: RawLog[]): Set<number> {
  const acceptedTopic = eventTopic0('OfferAccepted');
  const acceptedEvent = findEvent('OfferAccepted');
  const ids = new Set<number>();
  for (const log of logs) {
    if (log.removed) continue;
    if (!log.topics || log.topics.length < 2) continue;
    if (log.topics[0] === acceptedTopic) {
      try {
        const dec = decodeEventLog({
          abi: [acceptedEvent],
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if ((dec.args as { newAccepted?: boolean }).newAccepted !== true) {
          continue; // partial fill — the offer is still live
        }
      } catch {
        continue; // undecodable accepted log → don't strip
      }
    }
    ids.add(Number(BigInt(log.topics[1])));
  }
  return ids;
}

export interface CatchUpTarget {
  diamondAddress: `0x${string}`;
  deployBlock: number;
  publicClient: PublicClient | undefined;
  /** The freshness cursor snapshotted BEFORE the /offers/active pages
   *  were walked — reading it after would let a worker ingest landing
   *  mid-walk advance the cursor past a terminal block whose stale
   *  row is already in the collected pages, silently skipping the
   *  very window that row needs. null = unknown → no filtering. */
  freshness: IndexerFreshness | null;
}

/** The scan half of the strip, extracted so the RPC read-diet split
 *  (design §4.1.2a) can run it as its own block-driven query
 *  (`bookGhostStrip` root) while the indexed page walk refreshes on
 *  push. Returns the offer ids the chain says are already terminal in
 *  the un-ingested tail; EVERY failure/skip path returns an empty set
 *  (fail-open — an empty set strips nothing, exactly the old
 *  behaviour's "return rows unchanged"). The caller passes the
 *  freshness cursor SNAPSHOTTED before its page walk (see
 *  CatchUpTarget.freshness) — this function never reads the cursor
 *  itself, which is what closes the mid-walk ingest race. */
export async function scanTerminalOfferIds(
  target: CatchUpTarget,
): Promise<Set<number>> {
  const none = new Set<number>();
  try {
    if (!target.publicClient || !target.freshness) return none;
    const fromBlock = BigInt(
      Math.max(target.freshness.lastBlock + 1, target.deployBlock),
    );
    // See CONFIRMATION_BUFFER for why this is latest-minus-buffer and
    // not the safe tag.
    const latest = await target.publicClient.getBlockNumber();
    const toBlock = latest - CONFIRMATION_BUFFER;
    if (toBlock < fromBlock) return none;
    if (toBlock - fromBlock + 1n > MAX_CATCHUP_BLOCKS) return none;
    const logs = await chunkedGetLogs(target.publicClient, {
      address: target.diamondAddress,
      fromBlock,
      toBlock,
      topics: offerTerminalTopics(),
    });
    if (logs.length === 0) return none;
    return decodeTerminalOfferIds(logs);
  } catch {
    return none;
  }
}

/** The merge: strip offers the chain says are already terminal from
 *  the indexed rows. Every failure path returns `rows` unchanged. */
export async function filterTerminalOffers(
  rows: IndexedOffer[],
  target: CatchUpTarget,
): Promise<IndexedOffer[]> {
  if (rows.length === 0) return rows;
  const terminal = await scanTerminalOfferIds(target);
  if (terminal.size === 0) return rows;
  return rows.filter((o) => !terminal.has(o.offerId));
}
