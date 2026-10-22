/**
 * #2201 — the scan does not advance on a guessed head. When no settled
 * (`safe`) block can be read, the pass scans nothing, leaves the cursor where
 * it is, reports why, and does not hand the ingest loop a head to re-arm
 * against.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import { runChainIndexerForChain } from '../src/chainIndexer';
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

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

/** A JSON-RPC endpoint whose `safe` tag never answers, recording every method. */
function rpcWithoutSafeTag(latest: bigint) {
  const methods: string[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    methods.push(req.method);
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    const fail = () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'invalid params' } }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (req.method === 'eth_chainId') return ok(hex(BASE));
    if (req.method === 'eth_blockNumber') return ok(hex(latest));
    if (req.method === 'eth_getBlockByNumber') {
      const tag = req.params?.[0];
      if (tag === 'safe') return fail();
      return ok({
        number: tag,
        hash: `0x${'11'.repeat(32)}`,
        parentHash: `0x${'22'.repeat(32)}`,
        timestamp: hex(1_700_000_000),
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

describe('a pass with no settled head holds the scan (#2201)', () => {
  it('scans nothing, keeps the cursor, says why, and reports no head', async () => {
    const h = createSqliteD1([...migrations(), MIGRATIONS_DDL]);
    for (const n of REQUIRED_D1_MIGRATIONS) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
    h.db
      .prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending, adopted_blind) VALUES (?, ?, ?, ?, 0, 0)')
      .run(BASE, bundle.diamond, bundle.deployBlock, 1_000);
    const cursor = bundle.deployBlock + 5;
    h.db.prepare('INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)').run(BASE, 'diamond', cursor, 1);

    const { fetchFn, methods } = rpcWithoutSafeTag(BigInt(bundle.deployBlock) + 10_000n);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const chain = { id: BASE, rpc: 'https://rpc.invalid', diamond: bundle.diamond } as unknown as ChainConfig;
    // The pass meters its own sender over the global `fetch` (meterEnv), so
    // the fake endpoint stands in there.
    vi.stubGlobal('fetch', fetchFn);
    const env = { DB: h.d1 } as unknown as Env;

    const r = await runChainIndexerForChain(env, chain);

    expect(r.skipped).toBe('settled-head-unavailable');
    expect(r.headBlock).toBeUndefined();
    expect(r.scannedTo).toBe(BigInt(cursor));
    expect(methods).not.toContain('eth_getLogs');
    expect(
      h.db.prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = 'diamond'`).get(BASE),
    ).toEqual({ last_block: cursor });
    // The ingest time watermark is not stamped past what was read.
    expect(
      h.db.prepare(`SELECT count(*) AS n FROM indexer_cursor WHERE chain_id = ? AND kind = 'ingested_before_time'`).get(BASE),
    ).toEqual({ n: 0 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('holding the scan'))).toBe(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
