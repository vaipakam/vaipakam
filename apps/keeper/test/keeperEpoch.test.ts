/**
 * #2497 r10 — the keeper's own deployment epochs. A chain's Diamond changing
 * clears that chain's rows from every PRIVATE table keyed by chain and not by
 * Diamond, as the indexer does for its own tables. The one-time copy seeds the
 * record with the Diamond the copied rows belong to, so a later change resets
 * them. Real SQL on the real migrations.
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
  /** The indexer adopts `diamond` for chain 84532 (its own epoch record);
   *  `resetPending` is the flag it keeps set until the old rows are gone. */
  const indexerAdopts = (diamond: string, resetPending = 0) =>
    shared.db
      .prepare(
        `INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (84532, ?, 1, 1, ?)
         ON CONFLICT (chain_id) DO UPDATE SET diamond = excluded.diamond, reset_pending = excluded.reset_pending`,
      )
      .run(diamond, resetPending);
  return { shared, keeper, env, band, bands, indexerAdopts };
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
  it('a copy seeded with OLD resets once the configured NEW is the indexer\'s too, never before (#2497 r12, re-cut)', async () => {
    const { keeper, env, band, bands, indexerAdopts } = setup();
    indexerAdopts(OLD);
    // What the cutover records: the copied rows belong to OLD.
    keeper.db.prepare('INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (84532, ?, 1)').run(OLD);
    band(84532, 7);
    band(97, 7); // another chain: never touched
    // The bundle now names NEW, but the indexer has not adopted it yet: the
    // tick declines and nothing moves.
    await expect(adoptKeeperDeployments(env, [chain(NEW)])).rejects.toThrow(/not yet the indexer's/);
    expect(bands(84532), 'nothing reset ahead of the indexer').toBe(1);
    indexerAdopts(NEW);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
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

  it('a fresh environment — no record, no private rows — adopts the configured Diamond and resets nothing', async () => {
    const { keeper, env, band, bands } = setup();
    band(97, 3); // another chain's rows do not count
    expect(await adoptKeeperDeployments(env, [chain(NEW.toUpperCase().replace('0X', '0x'))])).toEqual([]);
    expect(keeper.db.prepare('SELECT diamond FROM keeper_deployment WHERE chain_id = 84532').get()).toEqual({ diamond: NEW });
    expect(bands(97)).toBe(1);
  });

  it('declines, naming the tables, when private rows exist for a chain with no record — never adopts over them (#2569 r1)', async () => {
    const { keeper, env, band, bands } = setup();
    band(84532, 3);
    keeper.db.prepare("INSERT INTO keeper_commitment_day (chain_id, day_id, resolved_at) VALUES (84532, 1, 1)").run();
    await expect(adoptKeeperDeployments(env, [chain(NEW)])).rejects.toThrow(/hf_band_state \(1 row\(s\)\), keeper_commitment_day \(1 row\(s\)\) hold private rows but keeper_deployment records no Diamond/);
    expect(keeper.db.prepare('SELECT COUNT(*) AS n FROM keeper_deployment').get(), 'nothing recorded').toEqual({ n: 0 });
    expect(bands(84532), 'nothing reset').toBe(1);
    // The copy seeds the record; the next tick then runs.
    keeper.db.prepare('INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (84532, ?, 1)').run(NEW);
    expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([]);
    expect(bands(84532)).toBe(1);
  });

  it("an indexer record whose reset is still pending is not an adoption: the tick declines until it clears (#2569 r1)", async () => {
    const { keeper, env, band, bands, indexerAdopts } = setup();
    keeper.db.prepare('INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (84532, ?, 1)').run(OLD);
    band(84532, 7);
    indexerAdopts(NEW, 1); // recorded, old rows not yet cleared
    await expect(adoptKeeperDeployments(env, [chain(NEW)])).rejects.toThrow(/not yet the indexer's \(none settled/);
    expect(bands(84532), 'nothing reset while the indexer is mid-reset').toBe(1);
    indexerAdopts(NEW, 0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([84532]);
    } finally {
      log.mockRestore();
    }
    expect(bands(84532)).toBe(0);
  });

  it('a redeploy later resets the chain once, then records it', async () => {
    const { env, band, bands, indexerAdopts } = setup();
    await adoptKeeperDeployments(env, [chain(OLD)]);
    band(84532, 1);
    indexerAdopts(NEW);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([84532]);
      expect(await adoptKeeperDeployments(env, [chain(NEW)])).toEqual([]);
    } finally {
      log.mockRestore();
    }
    expect(bands(84532)).toBe(0);
  });



  it("fails closed on an UNREAD indexer record when a change is due: the tick declines, nothing moves (#2497 r11)", async () => {
    const { keeper, band } = setup();
    keeper.db.prepare('INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (84532, ?, 1)').run(OLD);
    band(84532, 7);
    const brokenShared = { prepare: () => { throw new Error('D1 down'); } };
    const env = { DB: brokenShared, KEEPER_DB: keeper.d1 } as unknown as Env;
    await expect(adoptKeeperDeployments(env, [chain(NEW)])).rejects.toThrow(/D1 down/);
    expect(keeper.db.prepare('SELECT diamond FROM keeper_deployment').get(), 'record unchanged').toEqual({ diamond: OLD });
    expect(keeper.db.prepare('SELECT COUNT(*) AS n FROM hf_band_state').get()).toEqual({ n: 1 });
  });


  it('records the new Diamond only after every table reads empty — a failed delete leaves the old record, so the reset is redone (#2497 r11)', async () => {
    const { keeper, env, band, indexerAdopts } = setup();
    await adoptKeeperDeployments(env, [chain(OLD)]);
    band(84532, 1);
    indexerAdopts(NEW);
    // A KEEPER_DB whose DELETE on hf_band_state silently does nothing.
    const real = keeper.d1 as unknown as { prepare: (q: string) => unknown };
    const flaky = {
      ...real,
      prepare: (q: string) => (q.startsWith('DELETE FROM "hf_band_state"') ? real.prepare('SELECT 1 WHERE ? = ?') : real.prepare(q)),
      batch: (keeper.d1 as unknown as { batch: unknown }).batch,
    };
    const bad = { DB: (env as unknown as { DB: unknown }).DB, KEEPER_DB: flaky } as unknown as Env;
    await expect(adoptKeeperDeployments(bad, [chain(NEW)])).rejects.toThrow(/left rows: hf_band_state \(1 row/);
    expect(keeper.db.prepare('SELECT diamond FROM keeper_deployment').get()).toEqual({ diamond: OLD });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await adoptKeeperDeployments(env, [chain(NEW)]), 'the next tick redoes it whole').toEqual([84532]);
    } finally {
      log.mockRestore();
    }
  });
});
