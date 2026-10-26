/**
 * #2757 — a block whose chain time cannot be read is not processed.
 *
 * Until #2757 a failed block read stamped the indexer's wall clock in its
 * place, and the loan insert stored that invented value as the loan's start
 * and last-settled time on a row nothing later healed. Now the scan stops
 * before such a block (nothing of it is written), records its cursor just
 * below it, and reports an RPC error so the ingest loop retries; the next pass
 * that can read the block processes it with its real time. And a handler
 * handed a block without its time refuses rather than dating it by the clock.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import {
  BlockTimeUnavailable,
  RECONCILE_BUDGET_SHARED_TICK,
  processLoanLogs,
  runChainIndexerForChain,
} from '../src/chainIndexer';
import { createBudget } from '../src/subrequestBudget';
import { isRetryableScanSkip } from '../src/chainIndexer';
import type { ChainConfig, Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
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
const HEAD = CURSOR + 100;
/** The blocks the fixture's events sit in, one event each by default. */
const EVENT_BLOCKS = [CURSOR + 10, CURSOR + 20, CURSOR + 30];
/** How many events a block carries, where it is not one. */
const eventsInBlock: Record<number, number> = {};
/** Blocks whose `eth_getBlockByNumber` the fixture's RPC refuses. */
let unreadableBlocks = new Set<number>();

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const KEEPER = '0x00000000000000000000000000000000000000c1';

/** A `LoanKeeperEnabled` log in `block`: an event the scan records in the
 *  activity feed and reads nothing on chain for. */
function keeperLog(block: number, loanId: number, logIndex = 0) {
  const topics = encodeEventTopics({
    abi: DIAMOND_ABI_VIEM as Abi,
    eventName: 'LoanKeeperEnabled',
    args: { loanId: BigInt(loanId), keeper: KEEPER },
  } as never);
  return {
    address: bundle!.diamond.toLowerCase(),
    topics,
    data: encodeAbiParameters([{ type: 'bool' }], [true]),
    blockNumber: hex(block),
    blockHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${(block * 7 + logIndex).toString(16).padStart(64, '0')}`,
    transactionIndex: hex(logIndex),
    logIndex: hex(logIndex),
    removed: false,
  };
}

function rpc() {
  const methods: string[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    methods.push(req.method);
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    const fail = () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'unsupported in this fixture' } }), {
        headers: { 'content-type': 'application/json' },
      });
    if (req.method === 'eth_chainId') return ok(hex(BASE));
    if (req.method === 'eth_blockNumber') return ok(hex(HEAD));
    if (req.method === 'eth_getLogs') {
      const { fromBlock, toBlock } = (req.params?.[0] ?? {}) as { fromBlock: string; toBlock: string };
      return ok(
        EVENT_BLOCKS.filter((b) => b >= Number(fromBlock) && b <= Number(toBlock)).flatMap((b) =>
          Array.from({ length: eventsInBlock[b] ?? 1 }, (_, k) => keeperLog(b, b * 100 + k, k)),
        ),
      );
    }
    if (req.method === 'eth_getBlockByNumber') {
      const tag = req.params?.[0] as string;
      const number = tag === 'safe' || tag === 'latest' ? hex(HEAD) : tag;
      if (unreadableBlocks.has(Number(number))) return fail();
      return ok({
        number,
        hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'22'.repeat(32)}`,
        timestamp: hex(1_700_000_000 + Number(number)),
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
  return { fetchFn, methods };
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

function cursorOf(h: ReturnType<typeof chainDb>): number {
  return (h.db.prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = 'diamond'`).get(BASE) as {
    last_block: number;
  }).last_block;
}

function recordedBlocks(h: ReturnType<typeof chainDb>): number[] {
  return (
    h.db.prepare('SELECT DISTINCT block_number FROM activity_events WHERE chain_id = ? ORDER BY block_number').all(BASE) as {
      block_number: number;
    }[]
  ).map((r) => r.block_number);
}

/** One pass over the fixture under the given allowance (the tier's own by default). */
async function pass(h: ReturnType<typeof chainDb>, limits: { external?: number; d1Queries?: number } = {}) {
  return (await passWithMethods(h, limits)).result;
}

/** {@link pass}, plus every RPC method the pass sent, in order. */
async function passWithMethods(h: ReturnType<typeof chainDb>, limits: { external?: number; d1Queries?: number } = {}) {
  const { fetchFn, methods } = rpc();
  vi.stubGlobal('fetch', fetchFn);
  const env = { DB: h.d1 } as unknown as Env;
  const budget = createBudget('test pass', limits);
  const result = await runChainIndexerForChain(env, chain, RECONCILE_BUDGET_SHARED_TICK, budget);
  return { result, methods };
}


describe('a block whose time cannot be read is not processed (#2757)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    unreadableBlocks = new Set();
  });

  it('stops before the block, records the cursor below it, and reports a retryable RPC error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    unreadableBlocks = new Set([EVENT_BLOCKS[1]!]);

    const r = await pass(h);
    expect(r.skipped).toBe('rpc-error');
    expect(isRetryableScanSkip(r.skipped)).toBe(true);
    expect(r.unfinishedBlock).toBeUndefined();
    expect(r.scannedTo).toBe(BigInt(EVENT_BLOCKS[1]! - 1));
    expect(cursorOf(h)).toBe(EVENT_BLOCKS[1]! - 1);
    expect(recordedBlocks(h)).toEqual([EVENT_BLOCKS[0]]);

    // The read recovers: the next pass processes the block with its real time.
    unreadableBlocks = new Set();
    const again = await pass(h);
    expect(again.skipped).toBeUndefined();
    expect(recordedBlocks(h)).toEqual(EVENT_BLOCKS);
    const at = h.db
      .prepare('SELECT block_at AS t FROM activity_events WHERE chain_id = ? AND block_number = ?')
      .get(BASE, EVENT_BLOCKS[1]!) as { t: number };
    expect(at.t).toBe(1_700_000_000 + EVENT_BLOCKS[1]!);
  });

  it('a handler handed a loan with no block time refuses, and writes no row', async () => {
    const h = createSqliteD1(migrations());
    const initiated = {
      eventName: 'LoanInitiated',
      args: { loanId: 7n, offerId: 1n, lender: `0x${'0a'.repeat(20)}`, borrower: `0x${'0b'.repeat(20)}`, principal: 1000n, collateralAmount: 1500n },
      blockNumber: 100n,
      transactionHash: `0x${'ab'.repeat(32)}`,
      logIndex: 0,
    };
    const client = { readContract: async () => { throw new Error('no read in this fixture'); } } as never;
    await expect(
      processLoanLogs([initiated] as never, { DB: h.d1 } as unknown as Env, BASE, new Map(), client, bundle!.diamond),
    ).rejects.toBeInstanceOf(BlockTimeUnavailable);
    const n = (h.db.prepare('SELECT COUNT(*) AS n FROM loans WHERE chain_id = ? AND loan_id = 7').get(BASE) as { n: number }).n;
    expect(n).toBe(0);
  });
});
