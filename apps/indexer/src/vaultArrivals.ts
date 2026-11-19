/**
 * #3435 — tokens that arrived in a vault, as candidates for the app's
 * "Unrecognised items" list.
 *
 * WHAT IT FINDS. Every ERC-20 / ERC-721 `Transfer` and ERC-1155
 * `TransferSingle` / `TransferBatch` log whose receiver is the vault, read
 * from the token contracts themselves (address-less, topic-filtered
 * `eth_getLogs`) from the vault's creation block on. Each distinct
 * (asset, kind, token id) is one candidate, with the first and last block it
 * was seen in. Whether the protocol's own records name a candidate is the
 * reader's question: this feed reports arrivals and nothing else.
 *
 * WHAT IT NEVER STORES. Anything a token contract supplies as text or could
 * use to steer a reader: no name, symbol, image, metadata URI, sender or
 * amount. A hostile token can emit any log it likes, so the only things kept
 * are the emitting address, the shape of the log and the token id.
 *
 * HOW IT SCANS. Lazily. A vault is first scanned when its page asks
 * (`GET /vaults/<chainId>/<owner>/unrecognised`), which reads a fixed number
 * of block ranges; the cron then keeps it current while it was asked about in
 * the last {@link ASKED_WINDOW_SEC}. Each range costs two log reads (the two
 * receiver positions cannot share one filter: `Transfer` carries the receiver
 * in topic 2, the ERC-1155 events in topic 3). The range starts at
 * {@link DEFAULT_RANGE_SIZE} and halves whenever the provider refuses a range
 * as too large, and the size it settles on is kept per vault. One scan per
 * vault runs at a time, under a short lease.
 *
 * BOUNDS. Only an owner whose vault the Diamond reports. Reads are pinned to
 * the settled head, so an arrival in a block that is later reorganised away
 * is not recorded. At most {@link STORED_CAP} candidates are kept per vault
 * (the oldest by last block are dropped first, and the scan row says so); the
 * route pages them newest first, {@link PAGE_SIZE} at a time.
 */
import { decodeAbiParameters, getAddress, numberToHex, type Address, type Hex } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { slotRefusalStatus, takeCallerSlot } from '@vaipakam/lib/rateLimit';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { type Env, getChainConfigs } from './env';
import { chainNotServed } from './servedChain';
import { resolveSettledHead } from './settledHead';
import { affords, createChainClient, type TickBudget } from './subrequestBudget';

/** `Transfer(address,address,uint256)` — ERC-20 (3 topics) and ERC-721 (4). */
export const TOPIC_TRANSFER: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** `TransferSingle(address,address,address,uint256,uint256)`. */
export const TOPIC_TRANSFER_SINGLE: Hex = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
/** `TransferBatch(address,address,address,uint256[],uint256[])`. */
export const TOPIC_TRANSFER_BATCH: Hex = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

/** The first range tried, in blocks. Halved on a provider's range refusal. */
export const DEFAULT_RANGE_SIZE = 10_000;
/** Ranges one page request reads (two log reads each). */
export const REQUEST_RANGES = 10;
/** Ranges one cron tick reads across every vault it serves. */
export const CRON_RANGES = 20;
/** Vaults one cron tick looks at, per chain. */
export const CRON_VAULTS_PER_CHAIN = 5;
/** How long after its last request a vault is kept current. */
export const ASKED_WINDOW_SEC = 30 * 86_400;
/** How long one scan holds a vault. */
export const LEASE_SEC = 120;
/** Candidates kept per vault. */
export const STORED_CAP = 1_000;
/** Candidates one page returns. */
export const PAGE_SIZE = 200;
/** Token ids read from one `TransferBatch` log. */
export const BATCH_IDS_CAP = 200;

export type ArrivalKind = 'erc20' | 'erc721' | 'erc1155';

/** One arrival seen in one block. */
export interface Arrival {
  asset: string;
  kind: ArrivalKind;
  /** Decimal string; '' for ERC-20. */
  tokenId: string;
  block: number;
}

/** A stored candidate, as the route returns it. */
export interface Candidate {
  asset: string;
  kind: ArrivalKind;
  tokenId: string | null;
  firstBlock: number;
  lastBlock: number;
}

interface ScanRow {
  chain_id: number;
  vault: string;
  owner: string;
  from_block: number;
  scanned_to: number;
  range_size: number;
  lease_until: number;
  last_asked_at: number;
  pruned: number;
}

/** A log as `eth_getLogs` returns it (block number as hex), or as viem formats it. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  data: Hex;
  blockNumber: string | bigint | null;
  removed?: boolean;
}

/**
 * The slice of a viem client a scan needs: the raw JSON-RPC call.
 *
 * NOT `client.getLogs`. viem's `getLogs` builds `topics` only from an
 * `event`/`events` ABI argument and silently drops a raw `topics` filter,
 * so an address-less call through it asks the provider for EVERY log in the
 * range. Measured against a public Base endpoint before this was caught: the
 * provider answered "more than 20000 results" for a vault that had received
 * nothing.
 */
export interface LogReader {
  request(args: { method: 'eth_getLogs'; params: [{ fromBlock: Hex; toBlock: Hex; topics: (Hex | Hex[] | null)[] }] }): Promise<unknown>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function topicOf(address: string): Hex {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

/**
 * The arrivals in `logs` whose receiver is `vault`. A log whose shape does
 * not match the event its first topic names is skipped: a contract can emit
 * the signature with any payload, and a malformed one is not an arrival.
 */
export function arrivalsFromLogs(logs: readonly RawLog[], vault: string): Arrival[] {
  const receiver = topicOf(vault);
  const out: Arrival[] = [];
  for (const log of logs) {
    if (log.blockNumber === null || log.removed) continue;
    const topics = log.topics.map((t) => t.toLowerCase()) as Hex[];
    const asset = log.address.toLowerCase();
    const block = Number(BigInt(log.blockNumber));
    const t0 = topics[0];
    if (t0 === TOPIC_TRANSFER) {
      if (topics[2]?.toLowerCase() !== receiver) continue;
      if (topics.length === 3) out.push({ asset, kind: 'erc20', tokenId: '', block });
      else if (topics.length === 4) out.push({ asset, kind: 'erc721', tokenId: BigInt(topics[3]!).toString(), block });
    } else if (t0 === TOPIC_TRANSFER_SINGLE || t0 === TOPIC_TRANSFER_BATCH) {
      if (topics.length !== 4 || topics[3]?.toLowerCase() !== receiver) continue;
      try {
        if (t0 === TOPIC_TRANSFER_SINGLE) {
          const [id] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], log.data);
          out.push({ asset, kind: 'erc1155', tokenId: id.toString(), block });
        } else {
          const [ids] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], log.data);
          for (const id of ids.slice(0, BATCH_IDS_CAP)) out.push({ asset, kind: 'erc1155', tokenId: id.toString(), block });
        }
      } catch {
        // A payload that does not decode is not an ERC-1155 transfer.
      }
    }
  }
  return out;
}

/** `arrivals` folded to one entry per (asset, kind, token id). */
export function foldArrivals(arrivals: readonly Arrival[]): Map<string, Arrival & { firstBlock: number }> {
  const out = new Map<string, Arrival & { firstBlock: number }>();
  for (const a of arrivals) {
    const key = `${a.asset}|${a.kind}|${a.tokenId}`;
    const had = out.get(key);
    if (!had) out.set(key, { ...a, firstBlock: a.block });
    else {
      had.firstBlock = Math.min(had.firstBlock, a.block);
      had.block = Math.max(had.block, a.block);
    }
  }
  return out;
}

/**
 * Whether `err` is a provider refusing a range as too large (or as returning
 * too many logs), the one failure a smaller range can cure. Read from the
 * error's code and bounded text only; the message is never logged.
 */
export function isRangeRefusal(err: unknown): boolean {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    const o = e as { code?: unknown; message?: unknown; details?: unknown; data?: unknown; cause?: unknown };
    // Providers put the reason in different fields: the message, viem's
    // `details`, or the JSON-RPC error's `data` (Tenderly: "invalid params",
    // with the range limit in `data`).
    const text = [o.details, o.message, o.data]
      .filter((v): v is string => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    if (/block range|range (is )?too (large|wide|big)|ranges over|limited to|exceeds? (the )?(max|limit)|too many (results|logs)|query returned more than|response size/.test(text)) {
      return true;
    }
    e = o.cause;
  }
  return false;
}

/** What one scan did. */
export interface ScanOutcome {
  ranges: number;
  scannedTo: number;
  rangeSize: number;
  /** Stopped on a failure other than a range refusal (progress kept). */
  failed: boolean;
}

/**
 * Read up to `maxRanges` ranges of `row`'s vault, from just past
 * `scanned_to` up to `head`. Two log reads per range; a range refusal halves
 * the range and counts as a range read. `canRead` is asked before every
 * range, so a cron tick stops when its allowance runs low.
 */
export async function scanRanges(
  client: LogReader,
  row: Pick<ScanRow, 'vault' | 'scanned_to' | 'range_size'>,
  head: number,
  maxRanges: number,
  canRead: () => boolean = () => true,
): Promise<ScanOutcome & { arrivals: Arrival[] }> {
  const receiver = topicOf(row.vault);
  let scannedTo = row.scanned_to;
  let rangeSize = Math.max(1, row.range_size);
  let ranges = 0;
  let failed = false;
  const arrivals: Arrival[] = [];
  while (scannedTo < head && ranges < maxRanges && canRead()) {
    ranges += 1;
    const from = scannedTo + 1;
    const to = Math.min(head, from + rangeSize - 1);
    try {
      const read = async (topics: (Hex | Hex[] | null)[]): Promise<RawLog[]> => {
        const out = await client.request({
          method: 'eth_getLogs',
          params: [{ fromBlock: numberToHex(from), toBlock: numberToHex(to), topics }],
        });
        if (!Array.isArray(out)) throw new Error('eth_getLogs answered without a list');
        return out as RawLog[];
      };
      const [fungibleOr721, multi] = await Promise.all([
        read([TOPIC_TRANSFER, null, receiver]),
        read([[TOPIC_TRANSFER_SINGLE, TOPIC_TRANSFER_BATCH], null, null, receiver]),
      ]);
      arrivals.push(...arrivalsFromLogs([...fungibleOr721, ...multi], row.vault));
      scannedTo = to;
    } catch (err) {
      if (isRangeRefusal(err) && rangeSize > 1) {
        const refused = rangeSize;
        rangeSize = Math.max(1, Math.floor(rangeSize / 2));
        // The provider's limit, as measured: an operator reads it here.
        console.warn(`[vaultArrivals] provider refused a ${refused}-block range; trying ${rangeSize}`);
        continue;
      }
      console.error(`[vaultArrivals] getLogs ${from}-${to} failed:`, describeFailure(err));
      failed = true;
      break;
    }
  }
  return { ranges, scannedTo, rangeSize, failed, arrivals };
}

/** The block the scan of `vault` starts at: its creation, else the Diamond's deploy. */
async function creationBlock(db: D1Database, chainId: number, vault: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT block_number FROM activity_events
        WHERE chain_id = ? AND kind = 'UserVaultCreated'
          AND lower(json_extract(args_json, '$.proxy')) = ?
        ORDER BY block_number ASC LIMIT 1`,
    )
    .bind(chainId, vault)
    .first<{ block_number: number }>();
  if (row) return row.block_number;
  return getDeployment(chainId)?.deployBlock ?? 0;
}

/** Take the vault's scan lease; false when another scan holds it. */
async function takeLease(db: D1Database, chainId: number, vault: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE vault_arrival_scan SET lease_until = ? WHERE chain_id = ? AND vault = ? AND lease_until <= ?`)
    .bind(now + LEASE_SEC, chainId, vault, now)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

/**
 * Record a scan's arrivals and progress, release the lease, and keep the
 * candidate store within {@link STORED_CAP}. One batch.
 */
async function recordScan(
  db: D1Database,
  chainId: number,
  vault: string,
  outcome: ScanOutcome & { arrivals: Arrival[] },
  now: number,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  for (const a of foldArrivals(outcome.arrivals).values()) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO vault_arrival_candidates (chain_id, vault, asset, kind, token_id, first_block, last_block)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (chain_id, vault, asset, kind, token_id) DO UPDATE SET
             first_block = min(first_block, excluded.first_block),
             last_block  = max(last_block, excluded.last_block)`,
        )
        .bind(chainId, vault, a.asset, a.kind, a.tokenId, a.firstBlock, a.block),
    );
  }
  stmts.push(
    db
      .prepare(
        `DELETE FROM vault_arrival_candidates
          WHERE chain_id = ? AND vault = ?
            AND rowid NOT IN (
              SELECT rowid FROM vault_arrival_candidates
               WHERE chain_id = ? AND vault = ?
               ORDER BY last_block DESC, asset, kind, token_id
               LIMIT ?)`,
      )
      .bind(chainId, vault, chainId, vault, STORED_CAP),
  );
  stmts.push(
    db
      .prepare(
        `UPDATE vault_arrival_scan
            SET scanned_to = ?, range_size = ?, lease_until = 0, updated_at = ?,
                pruned = CASE WHEN pruned = 1 OR (SELECT changes()) > 0 THEN 1 ELSE 0 END
          WHERE chain_id = ? AND vault = ?`,
      )
      .bind(outcome.scannedTo, outcome.rangeSize, now, chainId, vault),
  );
  await db.batch(stmts);
}

/** Scan `row` under its lease, if the lease is free. */
async function scanUnderLease(
  db: D1Database,
  client: LogReader,
  row: ScanRow,
  head: number,
  maxRanges: number,
  now: number,
  canRead?: () => boolean,
): Promise<ScanOutcome | null> {
  if (row.scanned_to >= head) return null;
  if (!(await takeLease(db, row.chain_id, row.vault, now))) return null;
  try {
    const outcome = await scanRanges(client, row, head, maxRanges, canRead);
    await recordScan(db, row.chain_id, row.vault, outcome, now);
    return outcome;
  } catch (err) {
    // Release the lease so the next request or tick can try.
    await db
      .prepare(`UPDATE vault_arrival_scan SET lease_until = 0 WHERE chain_id = ? AND vault = ?`)
      .bind(row.chain_id, row.vault)
      .run()
      .catch(() => undefined);
    throw err;
  }
}

/** Parse a page cursor: `<lastBlock>:<asset>:<kind>:<tokenId>`. */
export function parseCursor(raw: string | null): { lastBlock: number; asset: string; kind: ArrivalKind; tokenId: string } | null | 'bad' {
  if (raw === null || raw === '') return null;
  const m = raw.match(/^(\d{1,15}):(0x[0-9a-f]{40}):(erc20|erc721|erc1155):(\d{0,80})$/);
  if (!m) return 'bad';
  return { lastBlock: Number(m[1]), asset: m[2]!, kind: m[3] as ArrivalKind, tokenId: m[4]! };
}

/** One page of a vault's candidates, newest first. */
export async function readCandidates(
  db: D1Database,
  chainId: number,
  vault: string,
  after: Exclude<ReturnType<typeof parseCursor>, 'bad'>,
): Promise<{ candidates: Candidate[]; more: boolean; nextCursor: string | null }> {
  const where = after
    ? `AND (last_block < ? OR (last_block = ? AND (asset, kind, token_id) > (?, ?, ?)))`
    : '';
  const binds: unknown[] = [chainId, vault];
  if (after) binds.push(after.lastBlock, after.lastBlock, after.asset, after.kind, after.tokenId);
  binds.push(PAGE_SIZE + 1);
  const { results } = await db
    .prepare(
      `SELECT asset, kind, token_id, first_block, last_block FROM vault_arrival_candidates
        WHERE chain_id = ? AND vault = ? ${where}
        ORDER BY last_block DESC, asset, kind, token_id
        LIMIT ?`,
    )
    .bind(...binds)
    .all<{ asset: string; kind: ArrivalKind; token_id: string; first_block: number; last_block: number }>();
  const rows = results ?? [];
  const more = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    candidates: page.map((r) => ({
      asset: r.asset,
      kind: r.kind,
      tokenId: r.kind === 'erc20' ? null : r.token_id,
      firstBlock: r.first_block,
      lastBlock: r.last_block,
    })),
    more,
    nextCursor: more && last ? `${last.last_block}:${last.asset}:${last.kind}:${last.token_id}` : null,
  };
}

/** The route's answer. */
export interface ArrivalsAnswer {
  chainId: number;
  owner: string;
  vault: string;
  scannedFromBlock: number;
  scannedToBlock: number;
  headBlock: number;
  complete: boolean;
  candidates: Candidate[];
  /** More candidates exist beyond this page, or older ones were dropped from the store. */
  truncated: boolean;
  /** Older candidates were dropped from the store (beyond {@link STORED_CAP}). */
  pruned: boolean;
  nextCursor: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // The scan advances between requests, so nothing is cached.
      'Cache-Control': 'no-store',
    },
  });
}

/** The Diamond's vault for `owner`, or null when it reports none. */
async function vaultOf(client: ReturnType<typeof createChainClient>, diamond: string, owner: string): Promise<string | null> {
  const vault = (await client.readContract({
    address: diamond as Address,
    abi: [
      {
        type: 'function',
        name: 'getUserVaultAddress',
        stateMutability: 'view',
        inputs: [{ name: 'user', type: 'address' }],
        outputs: [{ name: '', type: 'address' }],
      },
    ] as const,
    functionName: 'getUserVaultAddress',
    args: [getAddress(owner)],
  })) as string;
  return /^0x0{40}$/i.test(vault) ? null : vault.toLowerCase();
}

/** `GET /vaults/<chainId>/<owner>/unrecognised?cursor=`. */
export async function handleVaultArrivals(
  req: Request,
  env: Env,
  chainIdRaw: string,
  ownerRaw: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const chainId = Number(chainIdRaw);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return json({ error: 'bad-chain-id' }, 400);
  if (!ADDRESS.test(ownerRaw)) return json({ error: 'bad-owner' }, 400);
  const owner = ownerRaw.toLowerCase();
  const cursor = parseCursor(new URL(req.url).searchParams.get('cursor'));
  if (cursor === 'bad') return json({ error: 'bad-cursor' }, 400);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  const refusal = slotRefusalStatus(await takeCallerSlot(req, env.VAULT_ARRIVALS_RATELIMIT));
  if (refusal) return json({ error: refusal.error }, refusal.status);
  const chain = getChainConfigs(env).find((c) => c.id === chainId);
  if (!chain) return json({ error: 'unavailable' }, 503);

  const client = createChainClient(chain.rpc, fetch, { retryCount: 0 });
  let vault: string | null;
  let head: number;
  try {
    [vault, head] = await Promise.all([
      vaultOf(client, chain.diamond, owner),
      resolveSettledHead(client).then((h) => Number(h.block)),
    ]);
  } catch (err) {
    console.error('[vaultArrivals] chain read failed:', describeFailure(err));
    return json({ error: 'unavailable' }, 503);
  }
  if (!vault) return json({ error: 'no-vault' }, 404);

  try {
    const db = env.DB;
    let row = await db
      .prepare(`SELECT * FROM vault_arrival_scan WHERE chain_id = ? AND vault = ?`)
      .bind(chainId, vault)
      .first<ScanRow>();
    if (!row) {
      const from = await creationBlock(db, chainId, vault);
      await db
        .prepare(
          `INSERT OR IGNORE INTO vault_arrival_scan
             (chain_id, vault, owner, from_block, scanned_to, range_size, lease_until, last_asked_at, updated_at, pruned)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
        )
        .bind(chainId, vault, owner, from, from - 1, DEFAULT_RANGE_SIZE, now, now)
        .run();
      row = { chain_id: chainId, vault, owner, from_block: from, scanned_to: from - 1, range_size: DEFAULT_RANGE_SIZE, lease_until: 0, last_asked_at: now, pruned: 0 };
    } else {
      await db
        .prepare(`UPDATE vault_arrival_scan SET last_asked_at = ? WHERE chain_id = ? AND vault = ?`)
        .bind(now, chainId, vault)
        .run();
    }
    // Only the first page scans: a reader paging through candidates is
    // reading what is stored, not asking for more chain.
    if (cursor === null) {
      const outcome = await scanUnderLease(db, client, row, head, REQUEST_RANGES, now);
      if (outcome) row = { ...row, scanned_to: outcome.scannedTo, range_size: outcome.rangeSize };
      const fresh = await db
        .prepare(`SELECT pruned, scanned_to FROM vault_arrival_scan WHERE chain_id = ? AND vault = ?`)
        .bind(chainId, vault)
        .first<{ pruned: number; scanned_to: number }>();
      if (fresh) row = { ...row, pruned: fresh.pruned, scanned_to: fresh.scanned_to };
    }
    const page = await readCandidates(db, chainId, vault, cursor);
    const answer: ArrivalsAnswer = {
      chainId,
      owner,
      vault,
      scannedFromBlock: row.from_block,
      scannedToBlock: row.scanned_to,
      headBlock: head,
      complete: row.scanned_to >= head,
      candidates: page.candidates,
      truncated: page.more || row.pruned === 1,
      pruned: row.pruned === 1,
      nextCursor: page.nextCursor,
    };
    return json(answer);
  } catch (err) {
    console.error('[vaultArrivals] store failed:', describeFailure(err));
    return json({ error: 'unavailable' }, 503);
  }
}

/** Cost of one range on the tick's allowance: two log reads and the record batch's share. */
const RANGE_COST = { external: 2, d1Queries: 1 };

/**
 * The cron half: keep every vault asked about in the last
 * {@link ASKED_WINDOW_SEC} current, {@link CRON_RANGES} ranges per tick at
 * most, least recently updated first, and only while the tick's allowance
 * affords another range.
 */
export async function runVaultArrivalCron(
  env: Env & { fetchFn: typeof fetch },
  budget: TickBudget,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ vaults: number; ranges: number }> {
  let rangesLeft = CRON_RANGES;
  let vaults = 0;
  for (const chain of getChainConfigs(env)) {
    if (rangesLeft <= 0 || !affords(budget, { external: 3, d1Queries: 3 })) break;
    const { results } = await env.DB.prepare(
      `SELECT * FROM vault_arrival_scan
        WHERE chain_id = ? AND last_asked_at >= ? AND lease_until <= ?
        ORDER BY updated_at ASC LIMIT ?`,
    )
      .bind(chain.id, now - ASKED_WINDOW_SEC, now, CRON_VAULTS_PER_CHAIN)
      .all<ScanRow>();
    const rows = results ?? [];
    if (rows.length === 0) continue;
    const client = createChainClient(chain.rpc, env.fetchFn, { retryCount: 0 });
    let head: number;
    try {
      head = Number((await resolveSettledHead(client)).block);
    } catch (err) {
      console.error(`[vaultArrivals] head read failed on chain ${chain.id}:`, describeFailure(err));
      continue;
    }
    for (const row of rows) {
      if (rangesLeft <= 0) break;
      const outcome = await scanUnderLease(env.DB, client, row, head, rangesLeft, now, () => affords(budget, RANGE_COST));
      if (outcome) {
        vaults += 1;
        rangesLeft -= outcome.ranges;
      }
    }
  }
  return { vaults, ranges: CRON_RANGES - rangesLeft };
}
