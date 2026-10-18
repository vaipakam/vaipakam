/**
 * #2497 r10 — the keeper's own deployment epochs. A chain's Diamond changing
 * clears that chain's rows from every PRIVATE table keyed by chain and not by
 * Diamond, as the indexer does for its own tables; the first adoption records
 * the Diamond the indexer had adopted, so the copied rows are judged against
 * the Diamond they belong to. Real SQL on the real migrations.
 */
import { describe, expect, it, vi } from 'vitest';
import { adoptKeeperDeployments, listResetOnDiamondChange } from '../src/keeperEpoch';
import type { ChainConfig, Env, KeeperD1 } from '../src/env';
import { createKeeperD1, createSharedD1 } from './helpers/schemas';

const OLD = '0x' + '1'.repeat(40);
const NEW = '0x' + '2'.repeat(40);
const chain = (diamond: string) => ({ id: 84532, diamond }) as unknown as ChainConfig;

function setup() {
  const shared = createSharedD1();
  const keeper = createKeeperD1();
  const env = { DB: shared.d1, KEEPER_DB: keeper.d1 } as unknown as Env;
  const band = (chainId: number, loanId: number) =>
    keeper.db
      .prepare('INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at) VALUES (?, ?, ?, 1000, ?, 1)')
      .run(chainId, loanId, 'warn', '0xabc');
  const bands = (chainId: number) =>
    (keeper.db.prepare('SELECT COUNT(*) AS n FROM hf_band_state WHERE chain_id = ?').get(chainId) as { n: number }).n;
  return { shared, keeper, env, band, bands };
}

describe('listResetOnDiamondChange — schema-aware, pinned to the real schema', () => {
  it('names exactly the private tables with a chain_id column and no diamond column', async () => {
    const { keeper } = setup();
    const oracle = (keeper.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => !t.startsWith('sqlite_') && t !== 'd1_migrations' && t !== 'keeper_deployment')
      .filter((t) => {
        const cols = (keeper.db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
        return cols.includes('chain_id') && !cols.includes('diamond');
      });
    expect(await listResetOnDiamondChange(keeper.d1 as KeeperD1)).toEqual(oracle);
    expect(oracle).toEqual(['hf_band_state', 'keeper_commitment_day', 'keeper_commitment_scan']);
  });
});

describe('adoptKeeperDeployments', () => {
  it("first adoption takes the indexer's adopted Diamond, then resets once the configured one differs", async () => {
    const { shared, env, band, bands } = setup();
    shared.db.prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at) VALUES (84532, ?, 1, 1)').run(OLD);
    band(84532, 7);
    band(97, 7); // another chain: never touched
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // The cutover copied rows that belong to OLD; the bundle now names NEW.
      expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([84532]);
    } finally {
      log.mockRestore();
    }
    expect(bands(84532), 'the retired Diamond’s loan 7 is gone').toBe(0);
    expect(bands(97)).toBe(1);
    // Steady state: same Diamond, nothing reset.
    band(84532, 7);
    expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([]);
    expect(bands(84532)).toBe(1);
  });

  it('a fresh environment adopts the configured Diamond and resets nothing', async () => {
    const { env, band, bands } = setup();
    band(84532, 3);
    expect(await adoptKeeperDeployments(env, [chain(NEW.toUpperCase().replace('0X', '0x'))])).toEqual([]);
    expect(bands(84532)).toBe(1);
  });

  it('a redeploy later resets the chain once, then records it', async () => {
    const { env, band, bands } = setup();
    await adoptKeeperDeployments(env, [chain(OLD)]);
    band(84532, 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([84532]);
      expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([]);
    } finally {
      log.mockRestore();
    }
    expect(bands(84532)).toBe(0);
  });
});
