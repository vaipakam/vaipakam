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
  rentalActiveAt,
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
  return { h, rows, env, d1: h.d1 as Parameters<typeof recordRentalRights>[0] };
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
    t.h.db
      .prepare('INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)')
      .run(CHAIN, CURSOR_KIND, 50, NOW);
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
