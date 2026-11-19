/**
 * #3525 — the chain pass keeps the snapshot's sequencer outage window
 * current on its own short cadence, from the Diamond's own read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { _resetOutageRefresh, maybeRefreshSequencerOutage } from '../src/configSnapshot';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
const CHAIN = 84532;
const DIAMOND = '0x0000000000000000000000000000000000000d1a' as const;
const NOW = 1_800_000_000;

function harness(read: () => Promise<unknown>) {
  const { db, d1 } = createSqliteD1(ALL);
  db.prepare(
    `INSERT INTO protocol_config (chain_id, bundle_json, source_block, updated_at) VALUES (?, '[]', 1, ?)`,
  ).run(CHAIN, NOW);
  let calls = 0;
  const client = {
    readContract: async (args: { functionName: string }) => {
      if (args.functionName !== 'getSequencerOutageWindow') throw new Error(`unexpected ${args.functionName}`);
      calls++;
      return read();
    },
  } as unknown as PublicClient;
  const env = { DB: d1 } as unknown as Env;
  const row = () =>
    db
      .prepare(`SELECT sequencer_outage_json AS j, sequencer_outage_read_at AS at FROM protocol_config WHERE chain_id = ?`)
      .get(CHAIN) as { j: string | null; at: number | null };
  const run = (nowSec: number) =>
    maybeRefreshSequencerOutage({ env, chainId: CHAIN, client, diamond: DIAMOND, headBlock: 100n, nowSec });
  return { row, run, calls: () => calls };
}

describe('maybeRefreshSequencerOutage', () => {
  beforeEach(() => _resetOutageRefresh());

  it('stores the window and its read time, then waits for the cadence', async () => {
    const h = harness(async () => [100n, 200n] as const);
    await h.run(NOW);
    expect(h.row()).toEqual({ j: JSON.stringify({ downAt: '100', windowEnd: '200' }), at: NOW });
    await h.run(NOW + 60);
    expect(h.calls()).toBe(1);
    await h.run(NOW + 121);
    expect(h.calls()).toBe(2);
    expect(h.row().at).toBe(NOW + 121);
  });

  it('records "no outage" for a Diamond that predates #3410', async () => {
    const h = harness(async () => {
      // viem's shape: a walkable error carrying the decoded revert.
      const err = new Error('reverted') as Error & { walk: (fn: (x: unknown) => boolean) => unknown };
      const node = { name: 'ContractFunctionRevertedError', data: { errorName: 'FunctionDoesNotExist' } };
      err.walk = (fn) => (fn(node) ? node : null);
      throw err;
    });
    await h.run(NOW);
    expect(h.row()).toEqual({ j: JSON.stringify({ downAt: '0', windowEnd: '0' }), at: NOW });
  });

  it('writes nothing when the read fails, so the stored read ages', async () => {
    const h = harness(async () => {
      throw new Error('rpc down');
    });
    await h.run(NOW);
    expect(h.row()).toEqual({ j: null, at: null });
  });
});
