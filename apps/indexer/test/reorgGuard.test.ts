/**
 * #3411 — the reorg guard: the scan records, with every cursor advance, the
 * hash of the block it advanced to, and every later pass re-reads that block.
 * A replaced block requests a rebuild of the chain's rows, which the next
 * pass carries out through the epoch reset; an inconsistent provider holds
 * the pass instead of wiping anything.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import { RECONCILE_BUDGET_SHARED_TICK, isRetryableScanSkip, runChainIndexerForChain } from '../src/chainIndexer';
import { alarmNextStep } from '../src/chainIngestDO';
import { createBudget } from '../src/subrequestBudget';
import {
  anchorUpsert,
  bootstrapChainAnchor,
  checkChainAnchor,
  resolveAnchoredCursor,
  type AnchorBlockReader,
} from '../src/reorgGuard';
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
const EVENT_BLOCKS = [CURSOR + 10, CURSOR + 60];

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const KEEPER = '0x00000000000000000000000000000000000000c1';
const describe0 = (err: unknown) => String((err as Error)?.message ?? err);

/** The chain as the fixture serves it: a block's hash depends on its number
 *  and, from `forkFrom` up, on which fork the chain is on. */
const chainState: { forkFrom: number; fork: number; flicker: boolean } = { forkFrom: Infinity, fork: 0, flicker: false };
/** Counts block reads, so `flicker` alternates per read and not per field. */
let blockReads = 0;
function hashOf(n: number): string {
  let fork = n >= chainState.forkFrom ? chainState.fork : 0;
  // `flicker`: the provider answers for two different forks on alternate reads.
  if (chainState.flicker && n >= chainState.forkFrom) fork = blockReads % 2 === 0 ? 1 : 2;
  return `0x${fork.toString(16).padStart(8, '0')}${n.toString(16).padStart(56, '0')}`;
}

function keeperLog(block: number, loanId: number) {
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
    blockHash: hashOf(block),
    transactionHash: `0x${(block * 7).toString(16).padStart(64, '0')}`,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
}

function fixtureFetch() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    if (req.method === 'eth_chainId') return ok(hex(BASE));
    if (req.method === 'eth_blockNumber') return ok(hex(HEAD));
    if (req.method === 'eth_getLogs') {
      const { fromBlock, toBlock } = (req.params?.[0] ?? {}) as { fromBlock: string; toBlock: string };
      return ok(EVENT_BLOCKS.filter((b) => b >= Number(fromBlock) && b <= Number(toBlock)).map((b) => keeperLog(b, b)));
    }
    if (req.method === 'eth_getBlockByNumber') {
      const tag = req.params?.[0] as string;
      const n = tag === 'safe' || tag === 'latest' ? HEAD : Number(tag);
      blockReads++;
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
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'unsupported in this fixture' } }),
      { headers: { 'content-type': 'application/json' } },
    );
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

const cursorOf = (h: ReturnType<typeof chainDb>) =>
  (h.db.prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = 'diamond'`).get(BASE) as
    | { last_block: number }
    | undefined)?.last_block;
const anchorOf = (h: ReturnType<typeof chainDb>) =>
  h.db.prepare(`SELECT block_number, block_hash FROM indexer_chain_anchor WHERE chain_id = ?`).get(BASE) as
    | { block_number: number; block_hash: string }
    | undefined;
const activityCount = (h: ReturnType<typeof chainDb>) =>
  (h.db.prepare('SELECT COUNT(*) AS n FROM activity_events WHERE chain_id = ?').get(BASE) as { n: number }).n;
const resetPending = (h: ReturnType<typeof chainDb>) =>
  (h.db.prepare('SELECT reset_pending FROM indexer_deployment WHERE chain_id = ?').get(BASE) as { reset_pending: number })
    .reset_pending;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  chainState.forkFrom = Infinity;
  chainState.fork = 0;
  chainState.flicker = false;
  blockReads = 0;
});

describe('the scan anchors the block its cursor advances to', () => {
  it('writes the anchor with the cursor, at the same block and with that block\'s hash', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    expect(cursorOf(h)).toBe(HEAD);
    expect(anchorOf(h)).toEqual({ block_number: HEAD, block_hash: hashOf(HEAD) });
    expect(activityCount(h)).toBe(EVENT_BLOCKS.length);
  });

  it('anchors a caught-up cursor that has none, where it stands', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    h.db.prepare(`UPDATE indexer_cursor SET last_block = ? WHERE chain_id = ?`).run(HEAD, BASE);
    expect(anchorOf(h)).toBeUndefined();
    await pass(h);
    expect(anchorOf(h)).toEqual({ block_number: HEAD, block_hash: hashOf(HEAD) });
  });
});

describe('a replaced indexed block is rolled back by a rebuild', () => {
  it('requests the rebuild, the next pass resets the chain, and the replay reads the new chain', { timeout: 120_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    expect(activityCount(h)).toBe(2);

    // The chain replaces blocks from CURSOR+50 up: the anchor (HEAD) changes.
    chainState.forkFrom = CURSOR + 50;
    chainState.fork = 1;
    const detecting = await pass(h);
    expect(detecting.skipped).toBe('reorg-rebuild-requested');
    expect(detecting.reorgRebuildRequested).toBe(true);
    expect(resetPending(h)).toBe(1);
    // Nothing is deleted by the detecting pass; it only asks.
    expect(activityCount(h)).toBe(2);
    expect(err.mock.calls.some((c) => String(c[0]).includes('REORG BELOW THE SCAN CURSOR'))).toBe(true);
    // The ingest loop rearms a fresh pass for the reset.
    expect(
      alarmNextStep({
        schemaDeclined: false,
        retryableFailure: isRetryableScanSkip(detecting.skipped),
        scannedTo: detecting.scannedTo,
        target: 0n,
        headBlock: detecting.headBlock,
        epochReset: detecting.reorgRebuildRequested,
      }),
    ).toBe('rearm');

    const resetting = await pass(h);
    expect(resetting.epochReset).toBe(true);
    expect(resetPending(h)).toBe(0);
    expect(cursorOf(h)).toBeUndefined();
    expect(anchorOf(h)).toBeUndefined();
    expect(activityCount(h)).toBe(0);

    await pass(h);
    expect(cursorOf(h)).toBe(HEAD);
    expect(anchorOf(h)).toEqual({ block_number: HEAD, block_hash: hashOf(HEAD) });
    expect(activityCount(h)).toBe(2);
  });

  it('a reorganisation entirely above the anchor changes nothing', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    chainState.forkFrom = HEAD + 1;
    chainState.fork = 1;
    const r = await pass(h);
    expect(r.reorgRebuildRequested).toBeUndefined();
    expect(resetPending(h)).toBe(0);
  });

  it('a provider that answers two ways holds the pass and wipes nothing', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = chainDb();
    await pass(h);
    chainState.forkFrom = CURSOR + 50;
    chainState.flicker = true;
    const r = await pass(h);
    expect(r.skipped).toBe('reorg-check-unavailable');
    expect(isRetryableScanSkip(r.skipped)).toBe(true);
    expect(resetPending(h)).toBe(0);
    expect(activityCount(h)).toBe(2);
    expect(cursorOf(h)).toBe(HEAD);
  });
});

describe('checkChainAnchor', () => {
  const reader = (answers: Array<{ number: bigint; hash?: string | null } | Error>): AnchorBlockReader => {
    let i = 0;
    return {
      getBlock: async () => {
        const a = answers[Math.min(i++, answers.length - 1)]!;
        if (a instanceof Error) throw a;
        return a;
      },
    };
  };
  const anchorAt = (block: number, hash: string) => ({ block: BigInt(block), hash });

  it('none, intact, above-head', async () => {
    expect((await checkChainAnchor(reader([]), null, 10n, describe0)).state).toBe('none');
    const a = anchorAt(10, '0xAA');
    expect((await checkChainAnchor(reader([{ number: 10n, hash: '0xaa' }]), a, 10n, describe0)).state).toBe('intact');
    expect((await checkChainAnchor(reader([]), a, 9n, describe0)).state).toBe('above-head');
  });

  it('a failed read, a missing hash or a wrong block is unreadable, never a reorg', async () => {
    const a = anchorAt(10, '0xaa');
    for (const answers of [[new Error('timeout')], [{ number: 10n, hash: null }], [{ number: 11n, hash: '0xbb' }]]) {
      expect((await checkChainAnchor(reader(answers), a, 10n, describe0)).state).toBe('unreadable');
    }
    // A different hash, then a failure, then the recorded hash: unreadable each time.
    expect(
      (await checkChainAnchor(reader([{ number: 10n, hash: '0xbb' }, new Error('x')]), a, 10n, describe0)).state,
    ).toBe('unreadable');
    expect(
      (
        await checkChainAnchor(
          reader([
            { number: 10n, hash: '0xbb' },
            { number: 10n, hash: '0xaa' },
          ]),
          a,
          10n,
          describe0,
        )
      ).state,
    ).toBe('unreadable');
  });

  it('replaced only when two reads agree on a different hash', async () => {
    const a = anchorAt(10, '0xaa');
    const v = await checkChainAnchor(
      reader([
        { number: 10n, hash: '0xbb' },
        { number: 10n, hash: '0xBB' },
      ]),
      a,
      10n,
      describe0,
    );
    expect(v).toMatchObject({ state: 'replaced', seen: '0xbb' });
  });
});

describe('resolveAnchoredCursor', () => {
  const failing: AnchorBlockReader = {
    getBlock: async () => {
      throw new Error('down');
    },
  };
  it('uses a known hash without asking, else one read', async () => {
    expect(
      await resolveAnchoredCursor({ client: failing, scanFrom: 1n, target: 5n, known: new Map([[5n, '0x5']]), describe: describe0 }),
    ).toEqual({ block: 5n, hash: '0x5' });
    const answering: AnchorBlockReader = { getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: '0xr' }) };
    expect(
      await resolveAnchoredCursor({ client: answering, scanFrom: 1n, target: 5n, known: new Map(), describe: describe0 }),
    ).toEqual({ block: 5n, hash: '0xr' });
  });
  it('falls back to the highest known block in the window, or does not advance', async () => {
    const known = new Map([
      [0n, '0x0'],
      [3n, '0x3'],
      [2n, '0x2'],
    ]);
    expect(await resolveAnchoredCursor({ client: failing, scanFrom: 1n, target: 5n, known, describe: describe0 })).toMatchObject({
      block: 3n,
      hash: '0x3',
      reason: 'down',
    });
    expect(
      await resolveAnchoredCursor({ client: failing, scanFrom: 1n, target: 5n, known: new Map([[0n, '0x0']]), describe: describe0 }),
    ).toBeNull();
    expect(await resolveAnchoredCursor({ client: failing, scanFrom: 6n, target: 5n, known, describe: describe0 })).toBeNull();
  });
});

describe('anchor writes', () => {
  it('never move the anchor back, and the bootstrap only inserts', async () => {
    const h = createSqliteD1([...migrations(), MIGRATIONS_DDL]);
    const readChainAnchor = async (_db: unknown, chainId: number) => {
      const r = h.db.prepare('SELECT block_number, block_hash FROM indexer_chain_anchor WHERE chain_id = ?').get(chainId) as
        | { block_number: number; block_hash: string }
        | undefined;
      return r ? { block: BigInt(r.block_number), hash: r.block_hash } : null;
    };
    await anchorUpsert(h.d1, { chainId: BASE, block: 10n, hash: '0xa', nowSec: 1 }).run();
    await anchorUpsert(h.d1, { chainId: BASE, block: 9n, hash: '0xb', nowSec: 2 }).run();
    expect(await readChainAnchor(h.d1, BASE)).toEqual({ block: 10n, hash: '0xa' });
    await anchorUpsert(h.d1, { chainId: BASE, block: 11n, hash: '0xc', nowSec: 3 }).run();
    expect(await readChainAnchor(h.d1, BASE)).toEqual({ block: 11n, hash: '0xc' });
    const answering: AnchorBlockReader = { getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: '0xd' }) };
    await bootstrapChainAnchor(h.d1, answering, BASE, 50n, describe0);
    expect(await readChainAnchor(h.d1, BASE)).toEqual({ block: 11n, hash: '0xc' });
  });
});
