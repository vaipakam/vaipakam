/**
 * #3882 — the rental rights table (ProjectKitDesign.md §12, §15 test 6):
 * an opening, a daily update, a clearing, two concurrent ERC-1155 rentals
 * of one token, an older update arriving late, a rebuild that drops an
 * update, and an expiry with no clearing event.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  MAX_STORED_EXPIRY,
  isActiveRental,
  RENTAL_SEED_CURSOR_KIND,
  RENTAL_SEED_PASS_COST,
  RENTAL_SEED_PROGRESS_KIND,
  rentalActiveAt,
  seedRentalRights,
  recordRentalRights,
  rentalRightRows,
  type RentalLog,
} from '../src/rentalRights';
import { handleRentalsByCollection, handleRentalsMayUse } from '../src/rentalRoutes';
import { CURSOR_KIND } from '../src/chainIndexer';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const NOW = Math.floor(Date.now() / 1000);
const NFT = '0x' + 'Ab'.repeat(20);
const OWNER = '0x' + '0a'.repeat(20);
const RENTER = '0x' + '0b'.repeat(20);
const RENTER2 = '0x' + '0c'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);

function ev(o: {
  loanId: number;
  user?: string;
  expires?: bigint;
  quantity?: bigint;
  tokenId?: bigint;
  block: number;
  log?: number;
}): RentalLog {
  return {
    eventName: 'VaultRentalUpdated',
    args: {
      lender: OWNER,
      nftContract: NFT,
      tokenId: o.tokenId ?? 7n,
      loanId: BigInt(o.loanId),
      user: o.user ?? RENTER,
      expires: o.expires ?? BigInt(NOW + 86_400),
      quantity: o.quantity ?? 1n,
      activeTotalQuantity: 0n,
      minActiveExpires: 0n,
    },
    blockNumber: BigInt(o.block),
    logIndex: o.log ?? 0,
  };
}

function db() {
  const h = createSqliteD1(MIGRATIONS);
  const rows = () =>
    h.db.prepare('SELECT * FROM rental_rights ORDER BY loan_id').all() as Array<Record<string, unknown>>;
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  /** The scan cursor at `block`, and (unless `seeded` is false) the seed mark. */
  const cursor = (block: number, seeded = true) => {
    const ins = h.db.prepare('INSERT OR REPLACE INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)');
    ins.run(CHAIN, CURSOR_KIND, block, NOW);
    if (seeded) ins.run(CHAIN, RENTAL_SEED_CURSOR_KIND, block, NOW);
  };
  cursor(1_000);
  return { h, rows, env, cursor, d1: h.d1 as Parameters<typeof recordRentalRights>[0] };
}

describe('rental rights table (#3882)', () => {
  it('records an opening with the event fields, lower-cased', async () => {
    const t = db();
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10 })], NOW);
    expect(t.rows()).toMatchObject([
      { chain_id: CHAIN, loan_id: 1, collection: NFT.toLowerCase(), token_id: '7', owner: OWNER, user: RENTER, quantity: '1', block_number: 10 },
    ]);
  });

  it('takes a daily update and keeps a cleared row with quantity 0', async () => {
    const t = db();
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10 })], NOW);
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 20, expires: BigInt(NOW + 2 * 86_400) })], NOW);
    expect(t.rows()[0]).toMatchObject({ expires: NOW + 2 * 86_400, block_number: 20 });
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 30, user: ZERO, quantity: 0n, expires: 0n })], NOW);
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ user: ZERO, quantity: '0', block_number: 30 });
  });

  it('keeps two concurrent ERC-1155 rentals of one token apart, and clears one alone', async () => {
    const t = db();
    await recordRentalRights(
      t.d1,
      CHAIN,
      [ev({ loanId: 1, block: 10, quantity: 3n }), ev({ loanId: 2, block: 10, log: 1, user: RENTER2, quantity: 2n })],
      NOW,
    );
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 11, user: ZERO, quantity: 0n })], NOW);
    expect(t.rows().map((r) => [r.loan_id, r.user, r.quantity])).toEqual([
      [1, ZERO, '0'],
      [2, RENTER2, '2'],
    ]);
  });

  it('never puts an older update back (an overlapping re-scan or a late batch)', async () => {
    const t = db();
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 30, user: ZERO, quantity: 0n })], NOW);
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10 }), ev({ loanId: 1, block: 30, log: 0, user: RENTER2 })], NOW);
    expect(t.rows()[0]).toMatchObject({ user: ZERO, quantity: '0', block_number: 30 });
    // In one batch out of order, the later log still wins.
    const out = rentalRightRows([ev({ loanId: 5, block: 9, log: 2, user: RENTER2 }), ev({ loanId: 5, block: 9, log: 1 })]);
    expect(out.map((r) => r.user)).toEqual([RENTER, RENTER2]);
  });

  it('a rebuild that drops an update replays to the state without it', async () => {
    // A reorganisation past the guard rebuilds the chain: the table is
    // chain-scoped and not kept (diamondEpochKeep.json), so it is cleared
    // and the replay of the surviving events writes it again.
    const keep = JSON.parse(readFileSync(new URL('../src/diamondEpochKeep.json', import.meta.url), 'utf8')) as {
      keep: Record<string, string>;
    };
    expect(Object.keys(keep.keep)).not.toContain('rental_rights');
    const t = db();
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10 }), ev({ loanId: 1, block: 20, user: ZERO, quantity: 0n })], NOW);
    t.h.db.exec(`DELETE FROM rental_rights WHERE chain_id = ${CHAIN}`);
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10 })], NOW);
    expect(t.rows()[0]).toMatchObject({ user: RENTER, quantity: '1', block_number: 10 });
  });

  it('a rental past its expiry stops being active with no clearing event', async () => {
    const t = db();
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10, expires: BigInt(NOW - 1) })], NOW);
    expect(isActiveRental(t.rows()[0] as { quantity: string; expires: number }, NOW)).toBe(false);
    const res = await handleRentalsByCollection(new Request(`https://x/rentals/by-collection?chainId=${CHAIN}&collection=${NFT}`), t.env);
    expect(((await res.json()) as { rentals: unknown[] }).rentals).toEqual([]);
  });

  it('uses the vault comparison: still active at the expiry second itself', () => {
    expect(isActiveRental({ quantity: '1', expires: NOW }, NOW)).toBe(true);
    expect(isActiveRental({ quantity: '1', expires: NOW - 1 }, NOW)).toBe(false);
    expect(isActiveRental({ quantity: '0', expires: NOW + 10 }, NOW)).toBe(false);
  });

  it('judges active at the later of the server clock and the chain time held, and states both', async () => {
    expect(rentalActiveAt(1_000.9, null)).toBe(1_000);
    expect(rentalActiveAt(1_000, 1_200)).toBe(1_200);
    expect(rentalActiveAt(1_300, 1_200)).toBe(1_300);
    // A server clock behind the chain cannot revive a rental the chain
    // already treats as ended: chain time at the cursor is past its expiry.
    const t = db();
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 1, block: 10, expires: BigInt(NOW + 100) })], NOW);
    t.cursor(50);
    t.h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, 40, 0, '0x01', 'LoanRepaid', '{}', ?), (?, 60, 0, '0x02', 'LoanRepaid', '{}', ?)`,
      )
      .run(CHAIN, NOW + 500, CHAIN, NOW + 900);
    const res = await handleRentalsMayUse(
      new Request(`https://x/rentals/may-use?chainId=${CHAIN}&collection=${NFT}&user=${RENTER}`),
      t.env,
    );
    const body = (await res.json()) as { asOf: unknown; activeAt: number; rentals: unknown[] };
    // Block 60 is past the cursor, so the chain time held is block 40's.
    expect(body.asOf).toEqual({ block: 50, chainTime: NOW + 500 });
    expect(body.activeAt).toBe(NOW + 500);
    expect(body.rentals).toEqual([]);
  });

  it('seeds once from the rental events already recorded below the cursor, then answers', async () => {
    const t = db();
    t.h.db.exec(`DELETE FROM indexer_cursor WHERE kind = '${RENTAL_SEED_CURSOR_KIND}'`);
    const url = `https://x/rentals/by-collection?chainId=${CHAIN}&collection=${NFT}`;
    // Unseeded: no apparently complete list.
    const before = await handleRentalsByCollection(new Request(url), t.env);
    expect(before.status).toBe(503);
    expect(((await before.json()) as { error: string }).error).toBe('rentals-index-building');
    // History the scan recorded before the table existed: an opening, then a
    // second rental on another loan, then one above the cursor (the scan's).
    const act = t.h.db.prepare(
      `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
       VALUES (?, ?, ?, ?, 'VaultRentalUpdated', ?, ?)`,
    );
    const args = (loanId: number, user: string) =>
      JSON.stringify({ lender: OWNER, nftContract: NFT, tokenId: '7', loanId: String(loanId), user, expires: String(NOW + 86_400), quantity: '1' });
    act.run(CHAIN, 10, 0, '0x10', args(1, RENTER), NOW);
    act.run(CHAIN, 20, 0, '0x20', args(2, RENTER2), NOW);
    act.run(CHAIN, 2_000, 0, '0x99', args(3, RENTER), NOW);
    // The live hook already wrote a LATER state of loan 2: the seed never puts it back.
    await recordRentalRights(t.d1, CHAIN, [ev({ loanId: 2, block: 1_500, user: ZERO, quantity: 0n })], NOW);
    const d1 = t.h.d1 as unknown as Parameters<typeof seedRentalRights>[0];
    expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'done', replayed: 2 });
    expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'seeded' });
    expect(t.rows().map((r) => [r.loan_id, r.user, r.quantity])).toEqual([
      [1, RENTER, '1'],
      [2, ZERO, '0'],
    ]);
    const after = await handleRentalsByCollection(new Request(url), t.env);
    expect(after.status).toBe(200);
    expect(((await after.json()) as { rentals: { rentalId: string }[] }).rentals.map((r) => r.rentalId)).toEqual(['1']);
  });

  describe('Codex #3908 r2 — the seed runs in bounded, resumable steps', () => {
    const history = (t: ReturnType<typeof db>, rows: Array<[block: number, log: number, loanId: number]>) => {
      t.h.db.exec(`DELETE FROM indexer_cursor WHERE kind = '${RENTAL_SEED_CURSOR_KIND}'`);
      const act = t.h.db.prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (?, ?, ?, ?, 'VaultRentalUpdated', ?, ?)`,
      );
      for (const [block, log, loanId] of rows) {
        act.run(
          CHAIN,
          block,
          log,
          `0x${block.toString(16)}${log}`,
          JSON.stringify({ lender: OWNER, nftContract: NFT, tokenId: '7', loanId: String(loanId), user: RENTER, expires: String(NOW + 86_400), quantity: '1' }),
          NOW,
        );
      }
    };
    /** The D1 handle, counting every statement prepared through it. */
    const counted = (t: ReturnType<typeof db>) => {
      let prepared = 0;
      const d1 = new Proxy(t.h.d1, {
        get(target, prop, recv) {
          if (prop === 'prepare') {
            return (sql: string) => {
              prepared++;
              return (target as unknown as { prepare: (q: string) => unknown }).prepare(sql);
            };
          }
          const v = Reflect.get(target, prop, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as unknown as Parameters<typeof seedRentalRights>[0];
      return { d1, take: () => { const n = prepared; prepared = 0; return n; } };
    };
    const progress = (t: ReturnType<typeof db>) =>
      (t.h.db.prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`).get(CHAIN, RENTAL_SEED_PROGRESS_KIND) as
        | { last_block: number }
        | undefined)?.last_block;

    it('replays one page a step within its stated cost, gives back a block a page ends inside, and marks only at the end', async () => {
      const t = db();
      // 499 blocks of one event each, then a block of two: the first page
      // (500 rows) ends inside that last block.
      const rows: Array<[number, number, number]> = [];
      for (let b = 1; b <= 499; b++) rows.push([b, 0, b]);
      rows.push([500, 0, 500], [500, 1, 501]);
      history(t, rows);
      const { d1, take } = counted(t);
      expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'progress', replayed: 499, through: 499 });
      expect(take()).toBeLessThanOrEqual(RENTAL_SEED_PASS_COST.d1Queries);
      expect(progress(t)).toBe(499);
      expect(t.rows()).toHaveLength(499);
      // Not marked yet: the rental reads still answer 503.
      const mid = await handleRentalsByCollection(new Request(`https://x/rentals/by-collection?chainId=${CHAIN}&collection=${NFT}`), t.env);
      expect(mid.status).toBe(503);
      expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'done', replayed: 2 });
      expect(take()).toBeLessThanOrEqual(RENTAL_SEED_PASS_COST.d1Queries);
      expect(progress(t)).toBeUndefined();
      expect(t.rows()).toHaveLength(501);
      expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'seeded' });
      expect(take()).toBe(1);
    });

    it('reads a page that lies wholly inside one block in full, and resumes after it', async () => {
      const t = db();
      const rows: Array<[number, number, number]> = [];
      for (let l = 0; l < 501; l++) rows.push([5, l, l + 1]);
      rows.push([6, 0, 900]);
      history(t, rows);
      const { d1, take } = counted(t);
      expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'progress', replayed: 501, through: 5 });
      expect(take()).toBeLessThanOrEqual(RENTAL_SEED_PASS_COST.d1Queries);
      expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'done', replayed: 1 });
      expect(t.rows()).toHaveLength(502);
    });

    it('a failed step leaves the last good progress, and the next step resumes from it', async () => {
      const t = db();
      const rows: Array<[number, number, number]> = [];
      for (let b = 1; b <= 600; b++) rows.push([b, 0, b]);
      history(t, rows);
      const d1 = t.h.d1 as unknown as Parameters<typeof seedRentalRights>[0];
      expect((await seedRentalRights(d1, CHAIN, 1_000, NOW)).state).toBe('progress');
      expect(progress(t)).toBe(499);
      const failing = new Proxy(t.h.d1, {
        get(target, prop, recv) {
          if (prop === 'batch') return async () => { throw new Error('D1 down'); };
          const v = Reflect.get(target, prop, recv);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }) as unknown as Parameters<typeof seedRentalRights>[0];
      await expect(seedRentalRights(failing, CHAIN, 1_000, NOW)).rejects.toThrow('D1 down');
      expect(progress(t)).toBe(499);
      expect(await seedRentalRights(d1, CHAIN, 1_000, NOW)).toEqual({ state: 'done', replayed: 101 });
      expect(t.rows()).toHaveLength(600);
    });

    it('writes each step\'s rows in one statement, by the same mapping the scan hook uses', async () => {
      const t = db();
      const big = (2n ** 64n - 1n).toString();
      t.h.db.exec(`DELETE FROM indexer_cursor WHERE kind = '${RENTAL_SEED_CURSOR_KIND}'`);
      t.h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
           VALUES (?, 3, 1, '0x31', 'VaultRentalUpdated', ?, ?)`,
        )
        .run(CHAIN, JSON.stringify({ lender: OWNER.toUpperCase().replace('0X', '0x'), nftContract: NFT, tokenId: '007', loanId: '9', user: RENTER, expires: big, quantity: '3' }), NOW);
      const d1 = t.h.d1 as unknown as Parameters<typeof seedRentalRights>[0];
      await seedRentalRights(d1, CHAIN, 1_000, NOW);
      expect(t.rows()).toEqual([
        expect.objectContaining({ loan_id: 9, token_id: '7', owner: OWNER.toLowerCase(), expires: Number.MAX_SAFE_INTEGER, quantity: '3', block_number: 3, log_index: 1 }),
      ]);
    });
  });

  it('reads activity_events for one value only: the network\'s latest block time at or below the cursor', () => {
    // Design's rule for test 7: the rental routes read the rental table, the
    // cursor and that one value. No row, participant, loan or offer column of
    // activity_events is selected or filtered on, and nothing from it meets a
    // rental row.
    const src = readFileSync(new URL('../src/rentalRoutes.ts', import.meta.url), 'utf8');
    const sql = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    const touching = sql.filter((q) => /\bSELECT\b/.test(q) && /activity_events/.test(q));
    expect(touching).toHaveLength(1);
    const sub = touching[0].match(/\(SELECT a\.[\s\S]*?LIMIT 1\)/)?.[0] ?? '';
    expect(sub).not.toBe('');
    const cols = [...sub.matchAll(/\ba\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(cols)).toEqual(new Set(['block_at', 'chain_id', 'block_number']));
    expect(touching[0]).not.toMatch(/rental_rights/);
  });

  it('holds a uint64 expiry above the signed range at the largest stored value', () => {
    const [r] = rentalRightRows([ev({ loanId: 1, block: 1, expires: 2n ** 64n - 1n })]);
    expect(BigInt(r.expires)).toBe(MAX_STORED_EXPIRY);
  });
});

describe('rental reads (#3882)', () => {
  async function seeded() {
    const t = db();
    await recordRentalRights(
      t.d1,
      CHAIN,
      [
        ev({ loanId: 1, block: 10, tokenId: 7n }),
        ev({ loanId: 2, block: 10, log: 1, tokenId: 8n, user: RENTER2, quantity: 4n }),
        ev({ loanId: 3, block: 10, log: 2, tokenId: 9n, user: ZERO, quantity: 0n }),
      ],
      NOW,
    );
    return t;
  }
  const get = (t: { env: Env }, path: string, h = handleRentalsByCollection) =>
    h(new Request(`https://x${path}${path.includes('?') ? '&' : '?'}chainId=${CHAIN}`), t.env);

  it('by-collection lists the active rentals, with an optional token', async () => {
    const t = await seeded();
    const body = (await (await get(t, `/rentals/by-collection?collection=${NFT}`)).json()) as any;
    expect(body.rentals.map((r: any) => r.rentalId)).toEqual(['1', '2']);
    expect(body.rentals[1]).toEqual({ rentalId: '2', tokenId: '8', user: RENTER2, expires: NOW + 86_400, quantity: '4', owner: OWNER });
    expect(body.nextCursor).toBeNull();
    const one = (await (await get(t, `/rentals/by-collection?collection=${NFT}&tokenId=0008`)).json()) as any;
    expect(one.rentals.map((r: any) => r.rentalId)).toEqual(['2']);
  });

  it('may-use lists what one address may use in one collection', async () => {
    const t = await seeded();
    const body = (await (await get(t, `/rentals/may-use?collection=${NFT}&user=${RENTER2.toUpperCase().replace('0X', '0x')}`, handleRentalsMayUse)).json()) as any;
    expect(body.rentals.map((r: any) => r.rentalId)).toEqual(['2']);
    expect(body.truncated).toBe(false);
  });

  it('refuses a missing, repeated, listed or wildcard collection or user', async () => {
    const t = await seeded();
    const cases: Array<[string, typeof handleRentalsMayUse]> = [
      ['/rentals/by-collection', handleRentalsByCollection],
      [`/rentals/by-collection?collection=${NFT}&collection=${NFT}`, handleRentalsByCollection],
      [`/rentals/by-collection?collection=${NFT},${OWNER}`, handleRentalsByCollection],
      ['/rentals/by-collection?collection=*', handleRentalsByCollection],
      [`/rentals/may-use?user=${RENTER}`, handleRentalsMayUse],
      [`/rentals/may-use?collection=${NFT}`, handleRentalsMayUse],
      [`/rentals/may-use?collection=${NFT}&user=${RENTER}&user=${RENTER2}`, handleRentalsMayUse],
      [`/rentals/may-use?collection=${NFT}&user=${RENTER},${RENTER2}`, handleRentalsMayUse],
      [`/rentals/may-use?collection=${NFT}&user=*`, handleRentalsMayUse],
      [`/rentals/may-use?collection=*&user=${RENTER}`, handleRentalsMayUse],
    ];
    for (const [path, h] of cases) expect((await get(t, path, h)).status, path).toBe(400);
  });
});
