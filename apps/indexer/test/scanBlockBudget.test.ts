/**
 * #2221 — the scan core finishes whole blocks within the invocation's
 * allowance, and leaves the rest for the next pass instead of freezing.
 *
 * Every block after the first runs under the held-back floor
 * (`SCAN_TAIL_RESERVE`). The pass stops at the block in which a request would
 * have eaten into it and records its cursor just below that block; the next
 * pass, with a fresh allowance, processes that block again in full. What the
 * unfinished block had already written stays written (Codex #2836 r1), so the
 * property pinned here is the cursor's and the replay's, not that the block
 * wrote nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import {
  RECONCILE_BUDGET_SHARED_TICK,
  SCAN_TAIL_RESERVE,
  logsByBlock,
  runChainIndexerForChain,
} from '../src/chainIndexer';
import { createBudget } from '../src/subrequestBudget';
import { invalidationKeysFromResult } from '../src/chainIngestDO';
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
let eventsInBlock: Record<number, number> = {};

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

function recordedIn(h: ReturnType<typeof chainDb>, block: number): number {
  return (
    h.db.prepare('SELECT COUNT(*) AS n FROM activity_events WHERE chain_id = ? AND block_number = ?').get(BASE, block) as {
      n: number;
    }
  ).n;
}

/** One pass over the fixture under the given allowance (the tier's own by default). */
async function pass(h: ReturnType<typeof chainDb>, limits: { external?: number; d1Queries?: number } = {}) {
  const { fetchFn } = rpc();
  vi.stubGlobal('fetch', fetchFn);
  const env = { DB: h.d1 } as unknown as Env;
  const budget = createBudget('test pass', limits);
  return runChainIndexerForChain(env, chain, RECONCILE_BUDGET_SHARED_TICK, budget);
}

describe('the scan core finishes whole blocks within the allowance (#2221)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    eventsInBlock = {};
  });

  it('with room to spare, scans the whole window and records every event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = chainDb();
    const r = await pass(h);
    expect(r.scannedTo).toBe(BigInt(HEAD));
    expect(cursorOf(h)).toBe(HEAD);
    expect(recordedBlocks(h)).toEqual(EVENT_BLOCKS);
  });

  // Both meters a block can run short on: chain reads, and D1 queries.
  const allowances = [
    ...Array.from({ length: 12 }, (_, i) => ({ external: i + 1 })),
    ...Array.from({ length: 14 }, (_, i) => ({ d1Queries: 20 + 3 * i })),
  ];

  it('at every allowance: the cursor sits just below an unfinished event block', { timeout: 180_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stops = { external: new Set<number>(), d1Queries: new Set<number>() };
    for (const limits of allowances) {
      const h = chainDb();
      try {
        await pass(h, limits);
      } catch {
        // Too little to reach the scan at all is a failed pass, not a scan.
      }
      const cursor = cursorOf(h);
      // Every event block at or below the cursor is recorded: nothing skipped
      // below the record. With one event per block, an unfinished block has
      // nothing it could have written before its refusal, so nothing past the
      // record is written either (a heavier block is the next case).
      expect(recordedBlocks(h)).toEqual(EVENT_BLOCKS.filter((b) => b <= cursor));
      if (cursor !== CURSOR && cursor !== HEAD) {
        // A partial pass stops just below an event block.
        expect(EVENT_BLOCKS).toContain(cursor + 1);
        stops['external' in limits ? 'external' : 'd1Queries'].add(cursor);
      }
    }
    // The sweep reached the case it is about, on each meter: passes that
    // stopped part-way, and at more than one block.
    expect(stops.external.size).toBeGreaterThan(1);
    expect(stops.d1Queries.size).toBeGreaterThan(0);
  });

  it('never stops before the first event block: a pass always makes progress', { timeout: 120_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const limits of allowances) {
      const h = chainDb();
      let r;
      try {
        r = await pass(h, limits);
      } catch {
        continue;
      }
      if (r.skipped !== undefined) continue;
      expect(cursorOf(h)).toBeGreaterThanOrEqual(EVENT_BLOCKS[0]);
    }
  });

  it('the next pass, with a fresh allowance, resumes where the short one stopped', { timeout: 120_000 }, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The smallest allowance that finishes the first event block and not the
    // rest — found, not assumed, so the test does not encode the pre-scan cost.
    let h = chainDb();
    let found = false;
    for (let external = 1; external <= 16 && !found; external++) {
      h = chainDb();
      try {
        await pass(h, { external });
      } catch {
        continue;
      }
      found = cursorOf(h) === EVENT_BLOCKS[1] - 1;
    }
    expect(found).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('scan stopped at block'))).toBe(true);

    const r = await pass(h);
    expect(r.scannedFrom).toBe(BigInt(EVENT_BLOCKS[1]));
    expect(r.unfinishedBlock).toBeUndefined();
    expect(cursorOf(h)).toBe(HEAD);
    expect(recordedBlocks(h)).toEqual(EVENT_BLOCKS);
  });
});

describe('a heavy block left unfinished (Codex #2836 r1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    eventsInBlock = {};
  });

  it('keeps what it wrote, and the next pass finishes it whole without repeating it', { timeout: 120_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const HEAVY = EVENT_BLOCKS[1]!;
    eventsInBlock = { [HEAVY]: 20 };
    const h = chainDb();
    const stopped = await pass(h);
    // The tier's own allowance runs out inside the heavy block: the cursor
    // stops just below it, and part of it is already written. This is the
    // state Codex reproduced, and it is stated rather than prevented.
    expect(cursorOf(h)).toBe(HEAVY - 1);
    const partial = recordedIn(h, HEAVY);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(20);
    // That pass is the only one that can announce what the block already
    // wrote (Codex #2836 r3): it says which block it left, its hints claim no
    // completeness, and every key goes out on it.
    expect(stopped.unfinishedBlock).toBe(BigInt(HEAVY));
    expect(stopped.hints?.truncated).toBe(true);
    expect(invalidationKeysFromResult(stopped)).toHaveLength(7);
    // The next pass processes the block again in full: every event once,
    // none twice, and the cursor moves past it.
    let passes = 0;
    while (cursorOf(h) < HEAVY && passes++ < 5) await pass(h);
    expect(cursorOf(h)).toBeGreaterThanOrEqual(HEAVY);
    expect(recordedIn(h, HEAVY)).toBe(20);
  });
});

describe('logsByBlock', () => {
  it('groups by block in chain order, each block in log order', () => {
    const l = (blockNumber: bigint, logIndex: number) => ({ blockNumber, logIndex });
    expect(logsByBlock([l(9n, 1), l(3n, 2), l(9n, 0), l(3n, 0)])).toEqual([
      { blockNumber: 3n, logs: [l(3n, 0), l(3n, 2)] },
      { blockNumber: 9n, logs: [l(9n, 0), l(9n, 1)] },
    ]);
  });
});

describe('SCAN_TAIL_RESERVE', () => {
  it('always holds back the cursor write', () => {
    expect(SCAN_TAIL_RESERVE.d1Queries).toBeGreaterThanOrEqual(1);
  });
});
