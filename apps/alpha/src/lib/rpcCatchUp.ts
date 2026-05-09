/**
 * RPC catch-up primitives for the live-tail data flow.
 *
 * The hf-watcher worker runs on a cron (1 minute minimum on Cloudflare)
 * which means the indexer's `lastBlock` can lag chain head by up to 60 s
 * in the worst case. The data hooks that subscribe to the live-tail
 * pattern bridge that gap by:
 *
 *   1. Snapshotting from the indexer (cheap, fast, complete up to
 *      `indexer.lastBlock`).
 *   2. Calling `chunkedGetLogs(fromBlock = indexer.lastBlock + 1,
 *      toBlock = watermark.safeBlock)` to fetch only the delta of
 *      events from the indexer's tail to the safe head.
 *   3. Decoding those delta logs into the consumer's own data shape and
 *      merging with the indexer page (e.g. removing terminal offer IDs,
 *      prepending new activity events).
 *
 * `blockTag: 'safe'` (already enforced by the watermark probe) keeps
 * the upper bound off the unconfirmed tip so a reorg can't cause a log
 * to be replayed-then-removed. A reorg below `safe` is still possible
 * on Ethereum (32-block finality), but vanishingly rare on the L2 chains
 * this app primarily runs on (Base, Arbitrum, OP).
 *
 * Logs are chunked to 1000-block windows. Most consumer-grade RPC
 * endpoints (Alchemy / Infura / public Base / Arbitrum One) cap the
 * `eth_getLogs` block range at 1024 or thereabouts; 1000 is a safe round
 * number that fits inside the cap on every endpoint we've tested. The
 * value is overrideable via `VITE_LIVE_TAIL_CHUNK` for environments
 * with stricter caps (e.g. some free-tier QuickNode plans top out at
 * 100). The chunk is the per-request maximum; the full delta window
 * may span many chunks when the user's tab has been backgrounded for
 * a long time.
 */

import { numberToHex, type Address, type Hex, type PublicClient } from 'viem';

/** Default block window per `eth_getLogs` request. */
const DEFAULT_CHUNK = 1000;

/** Resolve the effective chunk size from the env var with sane fallback. */
function effectiveChunk(): number {
  try {
    const raw = import.meta.env.VITE_LIVE_TAIL_CHUNK as string | undefined;
    if (!raw) return DEFAULT_CHUNK;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHUNK;
  } catch {
    return DEFAULT_CHUNK;
  }
}

export interface CatchUpLog {
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  address: Address;
  data: Hex;
  topics: Hex[];
  removed: boolean;
}

export interface ChunkedGetLogsParams {
  /** Inclusive lower bound of the catch-up window. Typically
   *  `indexer.lastBlock + 1n`. */
  fromBlock: bigint;
  /** Inclusive upper bound of the catch-up window. Typically the
   *  watermark probe's `safeBlock` so the read can never observe an
   *  unconfirmed log. */
  toBlock: bigint;
  /** Diamond address — every catch-up call is per-contract. */
  address: Address;
  /** Topic filter. First element is `topic0` (event signature hash);
   *  subsequent elements may be a single hex (exact match) or an array
   *  (OR'd match) per the `eth_getLogs` spec. Pass an array of topic0
   *  hashes as the first element to OR-merge events of multiple types
   *  in one request. */
  topics: (Hex | Hex[] | null)[];
}

/**
 * Chunked `eth_getLogs` over `[fromBlock, toBlock]` using the public
 * client's `getLogs` method. Returns a flat array of every matching
 * log across every chunk, in block order.
 *
 * Iterates sequentially (not parallel) because most paid RPC tiers
 * rate-limit on requests-per-second, and a backgrounded tab returning
 * to focus after an hour can otherwise burst a thousand parallel calls
 * into the throttle. A serialized loop is slower in absolute time but
 * avoids the throttle hit and keeps the catch-up reliable.
 *
 * Returns an empty array when `toBlock < fromBlock`. Returns the partial
 * accumulator on first error so an early failure doesn't lose the work
 * already done in earlier chunks.
 */
export async function chunkedGetLogs(
  publicClient: PublicClient,
  params: ChunkedGetLogsParams,
): Promise<CatchUpLog[]> {
  const { fromBlock, toBlock, address, topics } = params;
  if (toBlock < fromBlock) return [];
  const chunk = BigInt(effectiveChunk());
  const out: CatchUpLog[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n;
    try {
      // Raw `eth_getLogs` via the JSON-RPC transport — viem's typed
      // `getLogs` requires an ABI-decoded `event` / `events` shape, but
      // we want to OR-merge events of different types in one request
      // without per-topic ABI fragments. The raw form is the same
      // shape the spec accepts (block tags as hex, topics as
      // `(string | string[] | null)[]`).
      const logs = (await publicClient.request({
        method: 'eth_getLogs',
        params: [
          {
            address,
            fromBlock: numberToHex(cursor),
            toBlock: numberToHex(end),
            topics,
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as Array<{
        blockNumber: Hex;
        blockHash: Hex;
        transactionHash: Hex;
        transactionIndex: Hex;
        logIndex: Hex;
        address: Hex;
        data: Hex;
        topics: Hex[];
        removed?: boolean;
      }>;
      for (const l of logs) {
        out.push({
          blockNumber: BigInt(l.blockNumber),
          blockHash: l.blockHash,
          transactionHash: l.transactionHash,
          transactionIndex: Number(BigInt(l.transactionIndex)),
          logIndex: Number(BigInt(l.logIndex)),
          address: l.address as Address,
          data: l.data,
          topics: l.topics,
          removed: l.removed ?? false,
        });
      }
    } catch {
      // Single-chunk failure shouldn't poison the whole catch-up. The
      // missing window will naturally land in the next indexer cron
      // run; downstream merge-on-version-bump compensates.
      return out;
    }
    cursor = end + 1n;
  }
  return out;
}

// ─── Topic0 hashes for the events the live-tail consumers decode ────
//
// Computed at module load via viem's `keccak256` to keep this module
// self-contained — no separate constants file needed. The signatures
// below MUST match the on-chain event signatures in the contracts
// exactly; mismatches silently match nothing.

import { keccak256, toBytes } from 'viem';

const id = (sig: string): Hex => keccak256(toBytes(sig));

export const TOPIC0 = {
  // Offer lifecycle — ID universe and terminal transitions for the
  // active-offers consumer.
  OFFER_CREATED: id('OfferCreated(uint256,address,uint8)'),
  OFFER_ACCEPTED: id('OfferAccepted(uint256,address,uint256)'),
  OFFER_CANCELED: id('OfferCanceled(uint256,address)'),
  // Loan lifecycle — initiate is the create event; the rest mark
  // terminal transitions used by the active-loans consumer.
  LOAN_INITIATED: id(
    'LoanInitiated(uint256,uint256,address,address,uint256,uint256)',
  ),
  LOAN_REPAID: id('LoanRepaid(uint256,address,uint256,uint256)'),
  LOAN_DEFAULTED: id('LoanDefaulted(uint256,bool)'),
} as const;

/**
 * Decode a flat catch-up log batch into the offer-side delta the
 * `useIndexedActiveOffers` consumer needs:
 *   - `created`: offer IDs created in the catch-up window. Caller does
 *     a per-id `getOffer(id)` to hydrate (or reads them off the next
 *     indexer page once the cron catches up).
 *   - `terminal`: offer IDs that left active state (accepted or
 *     cancelled). Caller filters them out of the indexer page.
 */
export function decodeOfferDelta(logs: CatchUpLog[]): {
  created: bigint[];
  terminal: bigint[];
} {
  const created: bigint[] = [];
  const terminal: bigint[] = [];
  for (const l of logs) {
    if (l.removed) continue;
    const t0 = l.topics[0];
    if (!t0 || l.topics.length < 2) continue;
    // topic[1] carries the offerId for all three offer events; decode
    // as a uint256 from the raw 32-byte topic.
    const offerId = BigInt(l.topics[1]!);
    if (t0 === TOPIC0.OFFER_CREATED) created.push(offerId);
    else if (t0 === TOPIC0.OFFER_ACCEPTED) terminal.push(offerId);
    else if (t0 === TOPIC0.OFFER_CANCELED) terminal.push(offerId);
  }
  return { created, terminal };
}

/** Same shape for the loan-side delta. `terminal` covers
 *  repaid + defaulted. The active-loans consumer filters these out
 *  of the indexer page; new initiations are surfaced via the next
 *  indexer cron + watermark refetch. */
export function decodeLoanDelta(logs: CatchUpLog[]): {
  created: bigint[];
  terminal: bigint[];
} {
  const created: bigint[] = [];
  const terminal: bigint[] = [];
  for (const l of logs) {
    if (l.removed) continue;
    const t0 = l.topics[0];
    if (!t0 || l.topics.length < 2) continue;
    const loanId = BigInt(l.topics[1]!);
    if (t0 === TOPIC0.LOAN_INITIATED) created.push(loanId);
    else if (t0 === TOPIC0.LOAN_REPAID) terminal.push(loanId);
    else if (t0 === TOPIC0.LOAN_DEFAULTED) terminal.push(loanId);
  }
  return { created, terminal };
}
