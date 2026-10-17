/**
 * Deployment epochs (#1566, Codex #2545 r1 P1): a bundle naming a different
 * Diamond than the one a chain's rows were indexed from resets that chain's
 * chain-scoped rows before the pass scans, so the cursor reseeds from the new
 * deploy block and no retired-Diamond row survives to collide with the ids a
 * fresh Diamond restarts at. Run against the REAL migration DDL so the
 * schema-aware table discovery is exercised on the schema it will meet.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  KEEP_ON_DIAMOND_CHANGE,
  adoptDeployment,
  describeAdoption,
  listChainScopedTables,
  listTablesResetOnDiamondChange,
  readAdoptedDeployment,
} from '../src/deploymentEpoch';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const OLD = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const NEW = '0x2535baC87F3df287268fC697F2f31cf418365303';
const BASE = 84532;
const ARB = 421614;

/** A row in every chain-scoped table for BOTH chains, keyed so the per-table
 *  counts below can tell "this chain's rows went" from "nothing happened". */
function seedEveryChainScopedTable(h: ReturnType<typeof createSqliteD1>, tables: string[]) {
  const seeded: string[] = [];
  // The two notify tables are FOREIGN KEY children of user_thresholds on
  // (wallet, chain_id): seed the parent first, and give every text column the
  // same per-chain value so the child's key matches the parent's.
  // Never seed the epoch record itself: a seeded row there IS an adopted
  // Diamond, and the adoption under test would read it as a change.
  const ordered = ['user_thresholds', ...tables.filter((t) => t !== 'user_thresholds' && t !== 'indexer_deployment').sort()];
  for (const t of ordered) {
    const cols = h.db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info(?)`).all(t) as Array<{
      name: string;
      type: string;
      nn: number;
      d: string | null;
      pk: number;
    }>;
    // Honour `CHECK (col IN ('a', …))` constraints: the first literal is a
    // valid value for that column (loan_participants.role, signed_offers.status).
    const ddl = (h.db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(t) as { sql: string }).sql;
    const enumFor = new Map<string, string>();
    for (const m of ddl.matchAll(/\b([a-z_]+)\s+IN\s*\(\s*'([^']*)'/gi)) enumFor.set(m[1], m[2]);
    // Fill every NOT NULL column without a default with a type-shaped value so
    // the insert is valid on any table shape; chain_id carries the chain.
    const names: string[] = [];
    const values: Array<number | string> = [];
    for (const chain of [BASE, ARB]) {
      names.length = 0;
      values.length = 0;
      for (const c of cols) {
        if (c.name === 'chain_id') {
          names.push(c.name);
          values.push(chain);
          continue;
        }
        if (c.nn === 1 && c.d === null && !(c.pk === 1 && /INT/i.test(c.type))) {
          names.push(c.name);
          values.push(enumFor.get(c.name) ?? (/INT|REAL|NUM/i.test(c.type) ? 1 : `seed-${chain}`));
        }
      }
      try {
        h.db
          .prepare(`INSERT INTO "${t}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
          .run(...values);
      } catch (err) {
        throw new Error(`could not seed ${t}: ${(err as Error).message}`);
      }
    }
    seeded.push(t);
  }
  return seeded;
}

const countFor = (h: ReturnType<typeof createSqliteD1>, table: string, chain: number) =>
  (h.db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE chain_id = ?`).get(chain) as { n: number }).n;

describe('listChainScopedTables', () => {
  it('finds every table with a chain_id column and no tooling table', async () => {
    const h = createSqliteD1(migrations());
    const tables = await listChainScopedTables(h.d1 as never);
    expect(tables).toContain('offers');
    expect(tables).toContain('loans');
    expect(tables).toContain('indexer_cursor');
    expect(tables).not.toContain('d1_migrations');
    expect(tables).not.toContain('sqlite_sequence');
    // User-owned tables DO carry chain_id — which is exactly why the keep
    // list exists; the default would otherwise reset them.
    expect(tables).toContain('user_thresholds');
    expect(tables).toContain('telegram_links');
    // Sorted, no duplicates — the reset batch is one statement per table.
    expect(tables).toEqual([...new Set(tables)].sort());
  });

  it('every keep entry names a real table that carries chain_id', async () => {
    const h = createSqliteD1(migrations());
    const tables = await listChainScopedTables(h.d1 as never);
    for (const t of Object.keys(KEEP_ON_DIAMOND_CHANGE)) expect(tables, `keep entry ${t}`).toContain(t);
    const reset = await listTablesResetOnDiamondChange(h.d1 as never);
    for (const t of Object.keys(KEEP_ON_DIAMOND_CHANGE)) expect(reset).not.toContain(t);
    // The epoch record carries chain_id too; it is what the reset is about,
    // never what it clears. Every other chain-scoped table is reset or kept.
    expect(reset).not.toContain('indexer_deployment');
    expect([...reset, ...Object.keys(KEEP_ON_DIAMOND_CHANGE), 'indexer_deployment'].sort()).toEqual(tables);
  });
});

describe('adoptDeployment', () => {
  it('first adoption records the Diamond and resets nothing', async () => {
    const h = createSqliteD1(migrations());
    const tables = await listTablesResetOnDiamondChange(h.d1 as never);
    seedEveryChainScopedTable(h, tables);
    const r = await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: OLD, deployBlock: 100n, nowSec: 1_000 });
    expect(r).toEqual({ outcome: 'first' });
    expect(await readAdoptedDeployment(h.d1 as never, BASE)).toEqual({
      chainId: BASE,
      diamond: OLD,
      deployBlock: 100,
      adoptedAt: 1_000,
      resetPending: false,
    });
    for (const t of tables) expect(countFor(h, t, BASE), t).toBe(1);
    expect(describeAdoption(BASE, OLD, 100n, r)).toMatch(/first record, no reset/);
  });

  it('the same Diamond, in any case, is a no-op with no log line', async () => {
    const h = createSqliteD1(migrations());
    await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: OLD, deployBlock: 100n, nowSec: 1_000 });
    const r = await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: OLD.toLowerCase(), deployBlock: 100n, nowSec: 2_000 });
    expect(r).toEqual({ outcome: 'same' });
    expect(describeAdoption(BASE, OLD, 100n, r)).toBeNull();
    expect((await readAdoptedDeployment(h.d1 as never, BASE))?.adoptedAt).toBe(1_000);
  });

  it('a different Diamond resets THIS chain in every reset table, keeps the other chain and the keep tables, and reseeds the cursor', async () => {
    const h = createSqliteD1(migrations());
    const all = await listChainScopedTables(h.d1 as never);
    // The expected reset set is derived HERE from the schema, not taken from
    // the module: a module that quietly skipped a table would otherwise also
    // shrink the set this test checks (the mutation that proved it).
    const reset = all.filter((t) => t !== 'indexer_deployment' && !Object.hasOwn(KEEP_ON_DIAMOND_CHANGE, t));
    seedEveryChainScopedTable(h, all);
    await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: OLD, deployBlock: 100n, nowSec: 1_000 });
    await adoptDeployment(h.d1 as never, { chainId: ARB, diamond: OLD, deployBlock: 7n, nowSec: 1_000 });
    // The cursor the old Diamond's scan left — past the new deploy block.
    h.db.prepare(`DELETE FROM indexer_cursor WHERE chain_id = ?`).run(BASE);
    h.db.prepare(`INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'diamond', 999, 1)`).run(BASE);

    const r = await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: NEW, deployBlock: 500n, nowSec: 3_000 });
    expect(r.outcome).toBe('reset');
    if (r.outcome !== 'reset') throw new Error('unreachable');
    expect(r.previous).toBe(OLD);
    expect(r.tables).toEqual(reset);

    for (const t of reset) {
      expect(countFor(h, t, BASE), `${t} for the redeployed chain`).toBe(0);
      expect(countFor(h, t, ARB), `${t} for the other chain`).toBeGreaterThanOrEqual(1);
    }
    for (const t of Object.keys(KEEP_ON_DIAMOND_CHANGE)) expect(countFor(h, t, BASE), `${t} is the user's`).toBe(1);
    // The cursor is gone, so the next scan starts from `deployBlock - 1`.
    expect(h.db.prepare(`SELECT count(*) AS n FROM indexer_cursor WHERE chain_id = ?`).get(BASE)).toEqual({ n: 0 });
    expect(await readAdoptedDeployment(h.d1 as never, BASE)).toEqual({
      chainId: BASE,
      diamond: NEW,
      deployBlock: 500,
      adoptedAt: 3_000,
      resetPending: false,
    });
    expect(await readAdoptedDeployment(h.d1 as never, ARB)).toMatchObject({ diamond: OLD, deployBlock: 7 });
    expect(describeAdoption(BASE, NEW, 500n, r)).toMatch(/Diamond changed .* → .*; reset \d+ chain-scoped table/);
  });

  it('a reset claimed by a pass that died is finished by the next pass', async () => {
    const h = createSqliteD1(migrations());
    const reset = (await listChainScopedTables(h.d1 as never)).filter(
      (t) => t !== 'indexer_deployment' && !Object.hasOwn(KEEP_ON_DIAMOND_CHANGE, t),
    );
    seedEveryChainScopedTable(h, reset);
    // The record already names the NEW Diamond with the flag still set —
    // exactly what a crash between the claim and the batch leaves behind.
    h.db
      .prepare(`INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (?, ?, 500, 3000, 1)`)
      .run(BASE, NEW);
    const r = await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: NEW, deployBlock: 500n, nowSec: 3_100 });
    expect(r).toEqual({ outcome: 'reset-resumed', tables: reset });
    for (const t of reset) expect(countFor(h, t, BASE), t).toBe(0);
    expect((await readAdoptedDeployment(h.d1 as never, BASE))?.resetPending).toBe(false);
  });

  it('a bundle naming an OLDER deployment than the adopted one is refused — a stale build never wipes a chain', async () => {
    const h = createSqliteD1(migrations());
    const reset = (await listChainScopedTables(h.d1 as never)).filter(
      (t) => t !== 'indexer_deployment' && !Object.hasOwn(KEEP_ON_DIAMOND_CHANGE, t),
    );
    seedEveryChainScopedTable(h, reset);
    await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: NEW, deployBlock: 500n, nowSec: 3_000 });
    // A Worker built from a stale branch: its bundle still names the retired
    // Diamond at the lower deploy block.
    const r = await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: OLD, deployBlock: 100n, nowSec: 4_000 });
    expect(r).toEqual({ outcome: 'refused-older', adopted: NEW, adoptedDeployBlock: 500 });
    for (const t of reset) expect(countFor(h, t, BASE), t).toBe(1);
    expect(await readAdoptedDeployment(h.d1 as never, BASE)).toMatchObject({ diamond: NEW, deployBlock: 500, resetPending: false });
    expect(describeAdoption(BASE, OLD, 100n, r)).toMatch(/REFUSED .* stale bundle/);
  });

  it('two passes seeing the same change: only the one whose claim landed resets', async () => {
    const h = createSqliteD1(migrations());
    await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: OLD, deployBlock: 100n, nowSec: 1_000 });
    // Simulate the loser: its read saw OLD, but by the time it writes the
    // record already names NEW (the winner claimed and finished).
    await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: NEW, deployBlock: 500n, nowSec: 2_000 });
    h.db.prepare(`UPDATE indexer_deployment SET diamond = ? WHERE chain_id = ?`).run(NEW, BASE);
    // A claim conditioned on the OLD value now changes no row.
    const claimed = h.db
      .prepare(`UPDATE indexer_deployment SET reset_pending = 1 WHERE chain_id = ? AND lower(diamond) = lower(?)`)
      .run(BASE, OLD);
    expect(Number(claimed.changes)).toBe(0);
    // And the module reports the race rather than resetting twice.
    const r = await adoptDeployment(h.d1 as never, { chainId: BASE, diamond: NEW, deployBlock: 500n, nowSec: 2_100 });
    expect(r).toEqual({ outcome: 'same' });
  });
});
