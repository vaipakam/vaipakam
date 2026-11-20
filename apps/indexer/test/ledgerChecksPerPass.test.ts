/**
 * #2835 — the reward-loop ledger's and the recycle day series' one-time
 * checks run ONCE PER PASS: after the pass's deployment-epoch check, before
 * the first block, and with nothing remembered between passes.
 *
 * The structural half (the checks sit in `runChainPass`'s prologue, above
 * every return, and the per-block writers are called only after them) is
 * pinned by oneTimeBackfillReachability.test.ts. This is the behavioural
 * half, driven through the real pass wrapper on a migrated database:
 *
 *   1. an adopted pass runs the checks (their state rows are written);
 *   2. a Diamond change resets the chain — the state rows go with the other
 *      chain-scoped rows — and that reset pass returns at the epoch check, so
 *      it runs NO check (the checks come after the epoch check, never before
 *      it, or they would rebuild projections from rows about to be deleted);
 *   3. the next pass runs every check again. A module-level "already done"
 *      memo would skip them here and leave the new epoch's projections
 *      unseeded until an unrelated event arrived.
 *
 * The RPC answers a different chain id, so each adopted pass stops at the
 * identity check right after the prologue: no block is scanned, which is
 * exactly the caught-up / RPC-down case the checks must still cover.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
/** The retired Diamond a fresh deploy replaces (an earlier, lower deploy). */
const RETIRED_DIAMOND = '0x00000000000000000000000000000000000000ee';

function migratedDb() {
  const h = createSqliteD1([...migrations(), MIGRATIONS_DDL]);
  for (const n of REQUIRED_D1_MIGRATIONS) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
  return h;
}

/** An RPC that answers the identity probe with another chain's id, and nothing else. */
function wrongChainRpc() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (req.method !== 'eth_chainId') throw new Error(`pass went past the identity check: ${req.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: '0x1' }), {
      headers: { 'content-type': 'application/json' },
    });
  });
}

type H = ReturnType<typeof migratedDb>;
/** What each one-time check leaves behind for this chain. */
function checkState(h: H) {
  const one = (sql: string) => h.db.prepare(sql).get(BASE) as Record<string, number> | undefined;
  return {
    rewardLoop: one(`SELECT backfill_done FROM reward_loop_totals WHERE chain_id = ?`)?.backfill_done ?? null,
    recycleSeries: one(`SELECT backfill_done FROM recycle_series_state WHERE chain_id = ?`)?.backfill_done ?? null,
    projection: one(`SELECT projection_version FROM recycle_series_state WHERE chain_id = ?`)?.projection_version ?? null,
    participants: one(`SELECT done FROM activity_participants_state WHERE chain_id = ?`)?.done ?? null,
  };
}

describe('#2835 — the ledger checks run once per pass, and again after an epoch reset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const chain = { id: BASE, rpc: 'https://rpc.invalid', diamond: bundle.diamond } as unknown as ChainConfig;

  it('two passes separated by an epoch reset both run the checks', async () => {
    const h = migratedDb();
    // The pass meters the GLOBAL fetch (meterEnv), so that is where the RPC goes.
    const fetchFn = wrongChainRpc();
    vi.stubGlobal('fetch', fetchFn);
    const env = { DB: h.d1 } as unknown as Env;

    // Pass 1: this bundle's Diamond is the adopted epoch.
    h.db
      .prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending, adopted_blind) VALUES (?, ?, ?, ?, 0, 0)')
      .run(BASE, bundle.diamond, bundle.deployBlock, 1_000);
    expect(checkState(h)).toEqual({ rewardLoop: null, recycleSeries: null, projection: null, participants: null });

    const first = await runChainIndexerForChain(env, chain);
    expect(first.skipped).toBe('rpc-chain-mismatch');
    const afterFirst = checkState(h);
    expect(afterFirst.rewardLoop).toBe(1);
    expect(afterFirst.recycleSeries).toBe(1);
    expect(afterFirst.projection).toBeGreaterThan(0);
    expect(afterFirst.participants).toBe(1);

    // A fresh Diamond on the chain: the adopted record now names the RETIRED
    // one at a lower block, so the next pass is a new epoch and resets.
    h.db
      .prepare('UPDATE indexer_deployment SET diamond = ?, deploy_block = ? WHERE chain_id = ?')
      .run(RETIRED_DIAMOND, bundle.deployBlock - 1_000, BASE);
    const calls = fetchFn.mock.calls.length;

    const reset = await runChainIndexerForChain(env, chain);
    expect(reset.skipped).toBe('epoch-reset');
    // The reset took the checks' state rows with it, and the reset pass ran
    // no check: they come after the epoch check, not before it.
    expect(checkState(h)).toEqual({ rewardLoop: null, recycleSeries: null, projection: null, participants: null });
    expect(fetchFn.mock.calls.length).toBe(calls);

    // Pass 2 of the new epoch: every check runs again — nothing was
    // remembered from the pass before the reset.
    const second = await runChainIndexerForChain(env, chain);
    expect(second.skipped).toBe('rpc-chain-mismatch');
    expect(checkState(h)).toEqual(afterFirst);
  });
});
