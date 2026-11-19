/**
 * #3435 — token arrivals in a vault: read from the token contracts' own
 * Transfer logs, folded to one candidate per (asset, kind, token id), and
 * served newest first on `/vaults/<chainId>/<owner>/unrecognised`. Run
 * against the REAL migrations in SQLite and a fixture RPC that refuses wide
 * ranges, as a provider does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAbiParameters } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { createSqliteD1 } from './helpers/sqliteD1';
import { createBudget } from '../src/subrequestBudget';
import {
  DEFAULT_RANGE_SIZE,
  PAGE_SIZE,
  REQUEST_RANGES,
  TOPIC_TRANSFER,
  TOPIC_TRANSFER_BATCH,
  TOPIC_TRANSFER_SINGLE,
  arrivalsFromLogs,
  handleVaultArrivals,
  isRangeRefusal,
  parseCursor,
  runVaultArrivalCron,
} from '../src/vaultArrivals';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const BASE = 84532;
const bundle = getDeployment(BASE)!;
const OWNER = '0x00000000000000000000000000000000000000a1';
const VAULT = '0x0000000000000000000000000000000000000a0a';
const OTHER = '0x0000000000000000000000000000000000000b0b';
const ERC20 = '0x0000000000000000000000000000000000000e20';
const NFT = '0x0000000000000000000000000000000000000721';
const MULTI = '0x0000000000000000000000000000000000001155';
const CREATED = bundle.deployBlock + 100;
/** The fixture provider refuses ranges wider than this. */
const PROVIDER_LIMIT = 4_000;
const HEAD = CREATED + 30_000;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;

function rawLog(address: string, block: number, logIndex: number, topics: string[], data = '0x') {
  return {
    address,
    topics,
    data,
    blockNumber: hex(block),
    blockHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${(block * 7 + logIndex).toString(16).padStart(64, '0')}`,
    transactionIndex: '0x0',
    logIndex: hex(logIndex),
    removed: false,
  };
}

const LOGS = [
  // An ERC-20 arrival, twice.
  rawLog(ERC20, CREATED + 10, 0, [TOPIC_TRANSFER, pad(OTHER), pad(VAULT)], encodeAbiParameters([{ type: 'uint256' }], [5n])),
  rawLog(ERC20, CREATED + 20_000, 0, [TOPIC_TRANSFER, pad(OTHER), pad(VAULT)], encodeAbiParameters([{ type: 'uint256' }], [7n])),
  // An ERC-721 arrival.
  rawLog(NFT, CREATED + 9_000, 1, [TOPIC_TRANSFER, pad(OTHER), pad(VAULT), `0x${(42).toString(16).padStart(64, '0')}`]),
  // An ERC-20 transfer OUT of the vault: not an arrival.
  rawLog(ERC20, CREATED + 11, 0, [TOPIC_TRANSFER, pad(VAULT), pad(OTHER)], encodeAbiParameters([{ type: 'uint256' }], [1n])),
  // ERC-1155 single and batch arrivals.
  rawLog(MULTI, CREATED + 15_000, 2, [TOPIC_TRANSFER_SINGLE, pad(OTHER), pad(OTHER), pad(VAULT)], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [7n, 1n])),
  rawLog(MULTI, CREATED + 25_000, 3, [TOPIC_TRANSFER_BATCH, pad(OTHER), pad(OTHER), pad(VAULT)], encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[8n, 9n], [1n, 1n]])),
  // A TransferSingle whose payload does not decode: not an arrival.
  rawLog(MULTI, CREATED + 26_000, 4, [TOPIC_TRANSFER_SINGLE, pad(OTHER), pad(OTHER), pad(VAULT)], '0x01'),
];

function topicMatches(filter: unknown, value: string | undefined): boolean {
  if (filter === null || filter === undefined) return true;
  if (Array.isArray(filter)) return filter.some((f) => topicMatches(f, value));
  return String(filter).toLowerCase() === value?.toLowerCase();
}

function rpc(opts: { vault?: string } = {}) {
  const ranges: number[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'content-type': 'application/json' } });
    const fail = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } }), { headers: { 'content-type': 'application/json' } });
    if (req.method === 'eth_chainId') return ok(hex(BASE));
    if (req.method === 'eth_call') return ok(pad(opts.vault ?? VAULT));
    if (req.method === 'eth_getLogs') {
      const p = (req.params?.[0] ?? {}) as { fromBlock: string; toBlock: string; topics: unknown[]; address?: unknown };
      const from = Number(p.fromBlock);
      const to = Number(p.toBlock);
      if (p.address !== undefined) return fail(-32602, 'unexpected address filter');
      // The scan must filter by receiver; an unfiltered read would ask for every log.
      if (!Array.isArray(p.topics) || p.topics.length < 3) return fail(-32602, 'unfiltered getLogs');
      if (to - from + 1 > PROVIDER_LIMIT) return fail(-32602, `eth_getLogs block range too large, max ${PROVIDER_LIMIT}`);
      ranges.push(to - from + 1);
      return ok(
        LOGS.filter(
          (l) =>
            Number(l.blockNumber) >= from &&
            Number(l.blockNumber) <= to &&
            p.topics.every((t, i) => topicMatches(t, l.topics[i])) &&
            (p.topics.length <= l.topics.length),
        ),
      );
    }
    if (req.method === 'eth_getBlockByNumber') {
      const tag = req.params?.[0] as string;
      const number = tag === 'safe' || tag === 'latest' ? hex(HEAD) : tag;
      return ok({
        number, hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: hex(1_700_000_000),
        transactions: [], logsBloom: `0x${'00'.repeat(256)}`, gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0',
        extraData: '0x', miner: `0x${'00'.repeat(20)}`, nonce: '0x0000000000000000', sha3Uncles: `0x${'00'.repeat(32)}`, size: '0x1',
        stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, transactionsRoot: `0x${'00'.repeat(32)}`, uncles: [],
      });
    }
    return fail(-32000, 'unsupported');
  });
  return { fetchFn, ranges };
}

function db() {
  const h = createSqliteD1(migrations());
  h.db
    .prepare(
      `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, actor, args_json, block_at)
       VALUES (?, ?, 0, '0x01', 'UserVaultCreated', ?, ?, 1)`,
    )
    .run(BASE, CREATED, OWNER, JSON.stringify({ user: OWNER, proxy: VAULT }));
  return h;
}

const limiter = (success = true) => ({ limit: vi.fn(async () => ({ success })) });
const envOf = (d1: unknown, rl = limiter()) =>
  ({ DB: d1, RPC_BASE_SEPOLIA: 'https://rpc.invalid', VAULT_ARRIVALS_RATELIMIT: rl }) as unknown as Env;
const ask = (cursor?: string, owner = OWNER) =>
  new Request(`https://x/vaults/${BASE}/${owner}/unrecognised${cursor ? `?cursor=${cursor}` : ''}`);

interface Answer {
  vault: string;
  scannedFromBlock: number;
  scannedToBlock: number;
  headBlock: number;
  complete: boolean;
  candidates: { asset: string; kind: string; tokenId: string | null; firstBlock: number; lastBlock: number }[];
  truncated: boolean;
  nextCursor: string | null;
}

describe('the vault arrivals route (#3435)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('scans from the vault creation block, adapts to the provider range, and lists every arrival once', async () => {
    const h = db();
    const { fetchFn, ranges } = rpc();
    vi.stubGlobal('fetch', fetchFn);
    let body: Answer | null = null;
    for (let i = 0; i < 20 && !body?.complete; i++) {
      const res = await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), OWNER, 1_000 + i * 1_000);
      expect(res.status).toBe(200);
      body = (await res.json()) as Answer;
    }
    expect(body!.complete).toBe(true);
    expect(body!.vault).toBe(VAULT);
    expect(body!.scannedFromBlock).toBe(CREATED);
    expect(body!.scannedToBlock).toBe(HEAD);
    expect(body!.headBlock).toBe(HEAD);
    // The provider refused the default range; the scan settled under its limit.
    expect(Math.max(...ranges)).toBeLessThanOrEqual(PROVIDER_LIMIT);
    expect((h.db.prepare('SELECT range_size FROM vault_arrival_scan').get() as { range_size: number }).range_size).toBeLessThan(DEFAULT_RANGE_SIZE);
    expect(body!.candidates).toEqual([
      { asset: MULTI, kind: 'erc1155', tokenId: '8', firstBlock: CREATED + 25_000, lastBlock: CREATED + 25_000 },
      { asset: MULTI, kind: 'erc1155', tokenId: '9', firstBlock: CREATED + 25_000, lastBlock: CREATED + 25_000 },
      { asset: ERC20, kind: 'erc20', tokenId: null, firstBlock: CREATED + 10, lastBlock: CREATED + 20_000 },
      { asset: MULTI, kind: 'erc1155', tokenId: '7', firstBlock: CREATED + 15_000, lastBlock: CREATED + 15_000 },
      { asset: NFT, kind: 'erc721', tokenId: '42', firstBlock: CREATED + 9_000, lastBlock: CREATED + 9_000 },
    ]);
    expect(body!.truncated).toBe(false);
    expect(body!.nextCursor).toBeNull();
    // Nothing a token supplies as text is stored.
    const cols = (h.db.prepare(`PRAGMA table_info(vault_arrival_candidates)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['chain_id', 'vault', 'asset', 'kind', 'token_id', 'first_block', 'last_block']);
  });

  it('reads a fixed number of ranges per request', async () => {
    const h = db();
    const { fetchFn, ranges } = rpc();
    vi.stubGlobal('fetch', fetchFn);
    const res = await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), OWNER, 1_000);
    const body = (await res.json()) as Answer;
    expect(body.complete).toBe(false);
    // Two log reads per accepted range; refused ranges count toward the cap.
    expect(ranges.length).toBeLessThanOrEqual(REQUEST_RANGES * 2);
  });

  it('pages candidates newest first beyond one page, and the next page reads no chain logs', async () => {
    const h = db();
    h.db.prepare(`INSERT INTO vault_arrival_scan VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, 0)`).run(BASE, VAULT, OWNER, CREATED, HEAD, 4_000);
    const ins = h.db.prepare(`INSERT INTO vault_arrival_candidates VALUES (?, ?, ?, 'erc721', ?, ?, ?)`);
    for (let i = 0; i < PAGE_SIZE + 5; i++) ins.run(BASE, VAULT, NFT, String(i), CREATED + i, CREATED + i);
    const { fetchFn, ranges } = rpc();
    vi.stubGlobal('fetch', fetchFn);
    const first = (await (await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), OWNER, 2)).json()) as Answer;
    expect(first.candidates).toHaveLength(PAGE_SIZE);
    expect(first.candidates[0]!.tokenId).toBe(String(PAGE_SIZE + 4));
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (await handleVaultArrivals(ask(first.nextCursor!), envOf(h.d1), String(BASE), OWNER, 3)).json()) as Answer;
    expect(second.candidates.map((c) => c.tokenId)).toEqual(['4', '3', '2', '1', '0']);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(ranges).toEqual([]);
  });

  it('holds one scan per vault at a time', async () => {
    const h = db();
    h.db.prepare(`INSERT INTO vault_arrival_scan VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0)`).run(BASE, VAULT, OWNER, CREATED, CREATED - 1, 4_000, 5_000);
    const { fetchFn, ranges } = rpc();
    vi.stubGlobal('fetch', fetchFn);
    const body = (await (await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), OWNER, 4_000)).json()) as Answer;
    expect(ranges).toEqual([]);
    expect(body.complete).toBe(false);
    expect(body.scannedToBlock).toBe(CREATED - 1);
  });

  it('drops the oldest candidates beyond the store cap and says so', async () => {
    const h = db();
    h.db.prepare(`INSERT INTO vault_arrival_scan VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, 0)`).run(BASE, VAULT, OWNER, CREATED, HEAD - 1, 4_000);
    const ins = h.db.prepare(`INSERT INTO vault_arrival_candidates VALUES (?, ?, ?, 'erc721', ?, ?, ?)`);
    for (let i = 0; i < 1_000; i++) ins.run(BASE, VAULT, NFT, String(i), CREATED + i, CREATED + i);
    // One more arrival in the last block pushes the store past its cap.
    LOGS.push(rawLog(ERC20, HEAD, 9, [TOPIC_TRANSFER, pad(OTHER), pad(VAULT)], encodeAbiParameters([{ type: 'uint256' }], [1n])));
    try {
      const { fetchFn } = rpc();
      vi.stubGlobal('fetch', fetchFn);
      const body = (await (await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), OWNER, 5)).json()) as Answer;
      expect(body.complete).toBe(true);
      expect(body.truncated).toBe(true);
      expect((h.db.prepare('SELECT count(*) AS n FROM vault_arrival_candidates').get() as { n: number }).n).toBe(1_000);
      expect((h.db.prepare('SELECT pruned FROM vault_arrival_scan').get() as { pruned: number }).pruned).toBe(1);
      expect(h.db.prepare(`SELECT token_id FROM vault_arrival_candidates WHERE token_id = '0'`).get()).toBeUndefined();
    } finally {
      LOGS.pop();
    }
  });

  it('refuses an owner with no vault, a bad request, and a spent limit', async () => {
    const h = db();
    vi.stubGlobal('fetch', rpc({ vault: '0x0000000000000000000000000000000000000000' }).fetchFn);
    expect((await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), OWNER)).status).toBe(404);
    expect((await handleVaultArrivals(ask(), envOf(h.d1), String(BASE), '0x12')).status).toBe(400);
    expect((await handleVaultArrivals(ask('nope'), envOf(h.d1), String(BASE), OWNER)).status).toBe(400);
    expect((await handleVaultArrivals(ask(), envOf(h.d1, limiter(false)), String(BASE), OWNER)).status).toBe(429);
    expect((await handleVaultArrivals(ask(), { ...envOf(h.d1), VAULT_ARRIVALS_RATELIMIT: undefined } as Env, String(BASE), OWNER)).status).toBe(503);
  });

  it('the cron keeps asked-about vaults current and leaves stale ones alone', async () => {
    const h = db();
    const now = 100 * 86_400;
    h.db.prepare(`INSERT INTO vault_arrival_scan VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 0)`).run(BASE, VAULT, OWNER, CREATED, CREATED - 1, 4_000, now - 86_400);
    h.db.prepare(`INSERT INTO vault_arrival_scan VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, 0)`).run(BASE, OTHER, OTHER, CREATED, CREATED - 1, 4_000, now - 31 * 86_400);
    const { fetchFn } = rpc();
    const env = { ...envOf(h.d1), fetchFn } as unknown as Env & { fetchFn: typeof fetch };
    const out = await runVaultArrivalCron(env, createBudget('test'), now);
    expect(out.vaults).toBe(1);
    expect(out.ranges).toBeGreaterThan(0);
    const rows = h.db.prepare('SELECT vault, scanned_to FROM vault_arrival_scan ORDER BY vault').all() as { vault: string; scanned_to: number }[];
    expect(rows.find((r) => r.vault === VAULT)!.scanned_to).toBeGreaterThan(CREATED);
    expect(rows.find((r) => r.vault === OTHER)!.scanned_to).toBe(CREATED - 1);
  });
});

describe('arrival parsing', () => {
  const log = (topics: string[], data = '0x', address = ERC20) =>
    ({ address, topics, data, blockNumber: '0x5', removed: false });

  it('keeps only logs whose receiver is the vault and whose shape matches the event', () => {
    expect(arrivalsFromLogs([log([TOPIC_TRANSFER, pad(OTHER), pad(OTHER)])], VAULT)).toEqual([]);
    expect(arrivalsFromLogs([log([TOPIC_TRANSFER, pad(OTHER), pad(VAULT), pad(OTHER), pad(OTHER)])], VAULT)).toEqual([]);
    expect(arrivalsFromLogs([log([TOPIC_TRANSFER_SINGLE, pad(OTHER), pad(VAULT), pad(OTHER)], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, 1n]))], VAULT)).toEqual([]);
  });

  it('tells a range refusal from any other failure', () => {
    expect(isRangeRefusal({ message: 'ranges over 100 blocks are not supported on free plan' })).toBe(true);
    expect(isRangeRefusal({ cause: { details: 'Block range too large: maximum 1000 blocks' } })).toBe(true);
    expect(isRangeRefusal({ message: 'eth_getLogs is limited to 0 - 50 blocks range' })).toBe(true);
    expect(isRangeRefusal({ message: 'invalid params', data: 'Block range too large: maximum 1000 blocks without an access key' })).toBe(true);
    expect(isRangeRefusal({ message: 'request limit reached' })).toBe(false);
    expect(isRangeRefusal({ message: 'fetch failed' })).toBe(false);
  });

  it('parses a page cursor and refuses anything else', () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor(`12:${ERC20}:erc20:`)).toEqual({ lastBlock: 12, asset: ERC20, kind: 'erc20', tokenId: '' });
    expect(parseCursor('12:0xZZ:erc20:')).toBe('bad');
  });
});
