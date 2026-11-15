/**
 * #3411 part 2 — the pending lane: a caught-up pass reads the blocks above the
 * chain's safe block and replaces the chain's pending rows with what it found;
 * `/activity?pending=1` serves them apart from the final events, marked not
 * final, and says when it does not know.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import { RECONCILE_BUDGET_SHARED_TICK, runChainIndexerForChain } from '../src/chainIndexer';
import { invalidationKeysFromResult } from '../src/chainIngestDO';
import { createBudget } from '../src/subrequestBudget';
import { handleActivity } from '../src/loanRoutes';
import {
  PENDING_MAX_BLOCKS,
  PENDING_STALE_SEC,
  pendingFingerprint,
  writePendingLane,
  type PendingEventRow,
} from '../src/pendingLane';
import type { ChainConfig, Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migrations = (upTo = Infinity) =>
  migrationFiles()
    .filter((f) => Number.parseInt(f.slice(0, 4), 10) <= upTo)
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const MIGRATIONS_DDL = `CREATE TABLE d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const BASE = 84532;
const bundle = getDeployment(BASE);
if (!bundle) throw new Error('deployments.json carries no Base Sepolia (84532) entry');
const CURSOR = bundle.deployBlock + 5;
const KEEPER = '0x00000000000000000000000000000000000000c1';
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

/** The chain as the fixture serves it. */
const chainState = {
  safe: CURSOR + 100,
  latest: CURSOR + 120,
  /** Blocks carrying one `LoanKeeperEnabled` log each, for loan id = block. */
  eventBlocks: [CURSOR + 10, CURSOR + 105, CURSOR + 115] as number[],
  /** Bumped to replace every block from `forkFrom` up. */
  fork: 0,
  forkFrom: Infinity,
  failLatest: false,
  /** An `OfferConsumedBySale` of this offer, at this block. */
  sale: null as { block: number; offerId: number } | null,
};

function hashOf(n: number): string {
  const fork = n >= chainState.forkFrom ? chainState.fork : 0;
  return `0x${fork.toString(16).padStart(8, '0')}${n.toString(16).padStart(56, '0')}`;
}

function keeperLog(block: number) {
  const topics = encodeEventTopics({
    abi: DIAMOND_ABI_VIEM as Abi,
    eventName: 'LoanKeeperEnabled',
    args: { loanId: BigInt(block), keeper: KEEPER },
  } as never);
  return {
    address: bundle!.diamond.toLowerCase(),
    topics,
    data: encodeAbiParameters([{ type: 'bool' }], [true]),
    blockNumber: hex(block),
    blockHash: hashOf(block),
    transactionHash: `0x${(block * 7).toString(16).padStart(64, '0')}`,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

const EXECUTOR = '0x00000000000000000000000000000000000000e1';
const CREATOR = '0x00000000000000000000000000000000000000a1';
function saleLog(block: number, offerId: number) {
  const topics = encodeEventTopics({
    // Events only: the ABI also has an error of this name.
    abi: (DIAMOND_ABI_VIEM as Abi).filter((e) => e.type === 'event'),
    eventName: 'OfferConsumedBySale',
    args: { offerId: BigInt(offerId), executor: EXECUTOR },
  } as never);
  return { ...keeperLog(block), topics, data: '0x', logIndex: '0x1' };
}

function fixtureFetch() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    const fail = () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'unavailable' } }), {
        headers: { 'content-type': 'application/json' },
      });
    if (req.method === 'eth_chainId') return ok(hex(BASE));
    if (req.method === 'eth_blockNumber') return chainState.failLatest ? fail() : ok(hex(chainState.latest));
    if (req.method === 'eth_getLogs') {
      const { fromBlock, toBlock } = (req.params?.[0] ?? {}) as { fromBlock: string; toBlock: string };
      const inRange = (b: number) => b >= Number(fromBlock) && b <= Number(toBlock);
      const logs: unknown[] = chainState.eventBlocks.filter(inRange).map((b) => keeperLog(b));
      if (chainState.sale && inRange(chainState.sale.block)) logs.push(saleLog(chainState.sale.block, chainState.sale.offerId));
      return ok(logs);
    }
    if (req.method === 'eth_getBlockByNumber') {
      const tag = req.params?.[0] as string;
      const n = tag === 'safe' ? chainState.safe : tag === 'latest' ? chainState.latest : Number(tag);
      return ok({
        number: hex(n),
        hash: hashOf(n),
        parentHash: hashOf(n - 1),
        timestamp: hex(1_700_000_000 + n),
        transactions: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        gasLimit: '0x1',
        gasUsed: '0x0',
        baseFeePerGas: '0x1',
        difficulty: '0x0',
        extraData: '0x',
        miner: `0x${'00'.repeat(20)}`,
        nonce: '0x0000000000000000',
        sha3Uncles: `0x${'00'.repeat(32)}`,
        size: '0x1',
        stateRoot: `0x${'00'.repeat(32)}`,
        receiptsRoot: `0x${'00'.repeat(32)}`,
        transactionsRoot: `0x${'00'.repeat(32)}`,
        uncles: [],
      });
    }
    return fail();
  });
}

function chainDb() {
  const h = createSqliteD1([...migrations(), MIGRATIONS_DDL]);
  for (const n of REQUIRED_D1_MIGRATIONS) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
  h.db
    .prepare(
      'INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending, adopted_blind) VALUES (?, ?, ?, ?, 0, 0)',
    )
    .run(BASE, bundle!.diamond, bundle!.deployBlock, 1_000);
  h.db
    .prepare('INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)')
    .run(BASE, 'diamond', CURSOR, 1);
  return h;
}

const chain = { id: BASE, rpc: 'https://rpc.invalid', diamond: bundle.diamond } as unknown as ChainConfig;

async function pass(h: ReturnType<typeof chainDb>) {
  vi.stubGlobal('fetch', fixtureFetch());
  const env = { DB: h.d1 } as unknown as Env;
  return runChainIndexerForChain(env, chain, RECONCILE_BUDGET_SHARED_TICK, createBudget('test pass', {}));
}

const finalBlocks = (h: ReturnType<typeof chainDb>) =>
  (h.db.prepare('SELECT block_number AS b FROM activity_events WHERE chain_id = ? ORDER BY b').all(BASE) as { b: number }[]).map(
    (r) => r.b,
  );
const pendingRows = (h: ReturnType<typeof chainDb>) =>
  h.db
    .prepare('SELECT block_number AS b, block_hash AS hash, loan_id AS loanId FROM pending_activity_events WHERE chain_id = ? ORDER BY b')
    .all(BASE) as { b: number; hash: string; loanId: number }[];
const windowOf = (h: ReturnType<typeof chainDb>) =>
  h.db.prepare('SELECT final_through, through_block, latest_block, truncated FROM pending_activity_window WHERE chain_id = ?').get(BASE) as
    | { final_through: number; through_block: number; latest_block: number; truncated: number }
    | undefined;

type Page = {
  events: Array<{ blockNumber: number }>;
  pending?: {
    events: Array<{ blockNumber: number; final: boolean; blockAt: unknown; blockHash: string; loanId: number }>;
    finalThrough: number;
    throughBlock: number;
    latestBlock: number;
    complete: boolean;
  } | null;
  nextBefore: string | null;
};
async function activity(h: { d1: unknown }, query: string): Promise<Page> {
  const res = await handleActivity(new Request(`https://x/activity?chainId=${BASE}&${query}`), {
    DB: h.d1,
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
  } as unknown as Env);
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  chainState.safe = CURSOR + 100;
  chainState.latest = CURSOR + 120;
  chainState.eventBlocks = [CURSOR + 10, CURSOR + 105, CURSOR + 115];
  chainState.fork = 0;
  chainState.forkFrom = Infinity;
  chainState.failLatest = false;
  chainState.sale = null;
});

describe('a caught-up pass fills the pending lane above the safe block', () => {
  it('keeps final and pending apart, with each pending event\'s block hash', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    const r = await pass(h);
    expect(r.scannedTo).toBe(BigInt(CURSOR + 100));
    expect(finalBlocks(h)).toEqual([CURSOR + 10]);
    expect(pendingRows(h)).toEqual([
      { b: CURSOR + 105, hash: hashOf(CURSOR + 105), loanId: CURSOR + 105 },
      { b: CURSOR + 115, hash: hashOf(CURSOR + 115), loanId: CURSOR + 115 },
    ]);
    expect(windowOf(h)).toEqual({ final_through: CURSOR + 100, through_block: CURSOR + 120, latest_block: CURSOR + 120, truncated: 0 });
    // The change is announced on the activity push key.
    expect(r.pendingChanged).toBe(true);
    expect(invalidationKeysFromResult(r)).toContain('activity.appended');

    // The same lane again is not a change.
    const again = await pass(h);
    expect(again.pendingChanged).toBe(false);
    expect(pendingRows(h)).toHaveLength(2);
  });

  it('moves an event from pending to final when the safe block passes it', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    chainState.safe = CURSOR + 110;
    const r = await pass(h);
    expect(finalBlocks(h)).toEqual([CURSOR + 10, CURSOR + 105]);
    expect(pendingRows(h).map((p) => p.b)).toEqual([CURSOR + 115]);
    expect(r.pendingChanged).toBe(true);
  });

  it('drops a pending event a reorganisation removed, and keeps the replacement\'s hash', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    // Blocks above the safe one are replaced: the event at +115 is gone and
    // the new chain carries one at +117 instead.
    chainState.forkFrom = CURSOR + 101;
    chainState.fork = 1;
    chainState.eventBlocks = [CURSOR + 10, CURSOR + 117];
    const r = await pass(h);
    expect(r.pendingChanged).toBe(true);
    expect(pendingRows(h)).toEqual([{ b: CURSOR + 117, hash: hashOf(CURSOR + 117), loanId: CURSOR + 117 }]);
    // The final feed is untouched: nothing at or below the safe block moved.
    expect(finalBlocks(h)).toEqual([CURSOR + 10]);
  });

  it('bounds the read and says the lane is incomplete when the gap is wider than one read', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    chainState.latest = CURSOR + 100 + Number(PENDING_MAX_BLOCKS) + 50;
    await pass(h);
    expect(windowOf(h)).toEqual({
      final_through: CURSOR + 100,
      through_block: CURSOR + 100 + Number(PENDING_MAX_BLOCKS),
      latest_block: chainState.latest,
      truncated: 1,
    });
    const p = await activity(h, 'pending=1');
    expect(p.pending?.complete).toBe(false);
  });

  it('leaves the lane alone when the latest block cannot be read', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    const before = windowOf(h);
    chainState.failLatest = true;
    chainState.safe = CURSOR + 110;
    const r = await pass(h);
    expect(r.pendingChanged).toBe(false);
    // The scan itself went ahead; only the lane was skipped, with its old read time.
    expect(finalBlocks(h)).toEqual([CURSOR + 10, CURSOR + 105]);
    expect(windowOf(h)).toEqual(before);
  });

  it('leaves the lane alone when the latest block reads below the recorded one', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    const before = windowOf(h);
    const rows = pendingRows(h);
    // A provider behind the one the scan read (Codex #3557 r2).
    chainState.latest = CURSOR + 90;
    const r = await pass(h);
    expect(r.pendingChanged).toBe(false);
    expect(windowOf(h)).toEqual(before);
    expect(pendingRows(h)).toEqual(rows);
  });

  it('files a pending collateral-sale row under the offer\'s creator, like the final feed', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    h.db
      .prepare(
        `INSERT INTO offers (chain_id, offer_id, creator, offer_type, lending_asset, collateral_asset, asset_type,
           collateral_asset_type, amount, interest_rate_bps, collateral_amount, duration_days, first_seen_block,
           first_seen_at, updated_at)
         VALUES (?, 77, ?, 1, '0xa', '0xb', 0, 0, '1', 500, '1', 30, 1, 1, 1)`,
      )
      .run(BASE, CREATOR);
    chainState.sale = { block: CURSOR + 112, offerId: 77 };
    await pass(h);
    const row = h.db
      .prepare(`SELECT actor, offer_id AS offerId, args_json AS args FROM pending_activity_events WHERE chain_id = ? AND kind = 'OfferConsumedBySale'`)
      .get(BASE) as { actor: string; offerId: number; args: string };
    expect(row.actor).toBe(CREATOR);
    expect(row.offerId).toBe(77);
    expect(JSON.parse(row.args).creator).toBe(CREATOR);
  });

  it('does not fill the lane on a pass that is still behind the safe block', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    // A backlog wider than one pass's window.
    chainState.safe = CURSOR + 10_000_000;
    chainState.latest = chainState.safe + 20;
    const r = await pass(h);
    expect(r.scannedTo).toBeLessThan(BigInt(chainState.safe));
    expect(windowOf(h)).toBeUndefined();
    expect(r.pendingChanged).toBe(false);
  });
});

describe('/activity?pending=1 serves the lane apart from the final events', () => {
  it('marks pending events not final, with no block time, newest first', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    const p = await activity(h, 'pending=1');
    expect(p.events.map((e) => e.blockNumber)).toEqual([CURSOR + 10]);
    expect(p.pending?.events.map((e) => e.blockNumber)).toEqual([CURSOR + 115, CURSOR + 105]);
    expect(p.pending?.events.every((e) => e.final === false && e.blockAt === null)).toBe(true);
    expect(p.pending?.events[0].blockHash).toBe(hashOf(CURSOR + 115));
    expect(p.pending).toMatchObject({ finalThrough: CURSOR + 100, throughBlock: CURSOR + 120, latestBlock: CURSOR + 120, complete: true });
  });

  it('is absent unless asked for, and on any page after the first', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    expect((await activity(h, '')).pending).toBeUndefined();
    expect((await activity(h, `pending=1&before=${CURSOR + 50}:0`)).pending).toBeUndefined();
  });

  it('applies the same filters as the final feed', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    const p = await activity(h, `pending=1&loanId=${CURSOR + 105}`);
    expect(p.pending?.events.map((e) => e.loanId)).toEqual([CURSOR + 105]);
  });

  it('says the lane is incomplete when the request\'s limit cuts matching events', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    const cut = await activity(h, 'pending=1&limit=1');
    expect(cut.pending?.events.map((e) => e.blockNumber)).toEqual([CURSOR + 115]);
    expect(cut.pending?.complete).toBe(false);
    expect((await activity(h, 'pending=1&limit=2')).pending?.complete).toBe(true);
  });

  it('never lists an event the final feed already holds', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    // The scan moved past +105 but the lane has not been replaced yet.
    h.db.prepare(`UPDATE indexer_cursor SET last_block = ? WHERE chain_id = ?`).run(CURSOR + 110, BASE);
    const p = await activity(h, 'pending=1');
    expect(p.pending?.events.map((e) => e.blockNumber)).toEqual([CURSOR + 115]);
  });

  it('never lists an event the scan wrote before moving the cursor', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    // The scan has written +105's event; the cursor has not moved yet (Codex #3557 r2).
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, ?, 0, '0x1', 'LoanKeeperEnabled', '{}', 1)`,
      )
      .run(BASE, CURSOR + 105);
    const p = await activity(h, 'pending=1');
    expect(p.events.map((e) => e.blockNumber)).toContain(CURSOR + 105);
    expect(p.pending?.events.map((e) => e.blockNumber)).toEqual([CURSOR + 115]);
  });

  it('serves a stale lane as unknown, not as empty', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    h.db.prepare(`UPDATE pending_activity_window SET read_at = read_at - ? WHERE chain_id = ?`).run(PENDING_STALE_SEC + 1, BASE);
    expect((await activity(h, 'pending=1')).pending).toBeNull();
  });

  it('serves a chain with no read yet as unknown', async () => {
    const h = chainDb();
    expect((await activity(h, 'pending=1')).pending).toBeNull();
  });

  it('serves a database before migration 0090 as unknown, and the final feed as before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = createSqliteD1(migrations(89));
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, 5, 0, '0x1', 'LoanKeeperEnabled', '{}', 1)`,
      )
      .run(BASE);
    const p = await activity(h, 'pending=1');
    expect(p.pending).toBeNull();
    expect(p.events.map((e) => e.blockNumber)).toEqual([5]);
  });
});

describe('writePendingLane', () => {
  const row = (blockNumber: number, blockHash: string): PendingEventRow => ({
    blockNumber,
    logIndex: 0,
    blockHash,
    txHash: '0xt',
    kind: 'LoanKeeperEnabled',
    loanId: 1,
    offerId: null,
    actor: null,
    argsJson: '{}',
    asset: null,
    assetType: null,
    amount: null,
    amountMax: null,
    tokenId: null,
    quantity: null,
  });
  const window = { finalThrough: 10, throughBlock: 20, latestBlock: 20, truncated: false };

  it('reports a change when a block hash changes at the same position', async () => {
    const h = createSqliteD1(migrations());
    expect((await writePendingLane(h.d1 as unknown as D1Database, BASE, [], window, 1)).changed).toBe(false);
    expect((await writePendingLane(h.d1 as unknown as D1Database, BASE, [row(12, '0xa')], window, 2)).changed).toBe(true);
    expect((await writePendingLane(h.d1 as unknown as D1Database, BASE, [row(12, '0xa')], window, 3)).changed).toBe(false);
    expect((await writePendingLane(h.d1 as unknown as D1Database, BASE, [row(12, '0xb')], window, 4)).changed).toBe(true);
    expect((await writePendingLane(h.d1 as unknown as D1Database, BASE, [], window, 5)).changed).toBe(true);
    expect(pendingFingerprint([row(12, '0xB')])).toBe('12:0:0xb');
  });
});
