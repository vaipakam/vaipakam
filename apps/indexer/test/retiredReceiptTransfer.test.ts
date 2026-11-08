/**
 * #3205 (#3318 Codex r3) — a standalone PositionNFT never burns: a closed
 * position's token is RETIRED and keeps moving as a receipt. The indexer's
 * Transfer handler reads ONE live-side predicate for its owner updates and its
 * participation history, so a receipt bought after its position closed is
 * neither a holder nor a participant of that loan. A live side behaves as
 * before.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { processLoanLogs } from '../src/chainIndexer';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000d1a90' as never;
const ZERO = '0x0000000000000000000000000000000000000000';
const SELLER = '0x00000000000000000000000000000000000000a1';
const BUYER = '0x00000000000000000000000000000000000000b2';

const stubClient = {
  readContract: async () => {
    throw new Error('unexpected RPC in a Transfer scan');
  },
} as never;

function seedLoan(h: SqliteD1, lenderOwner: string) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, 7, 1, 'repaid', ?, '0xborrow', '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '11', '12', ?, '0xborrow',
         500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, SELLER, lenderOwner);
}

const transfer = (tokenId: bigint) => ({
  eventName: 'Transfer',
  args: { from: SELLER, to: BUYER, tokenId },
  blockNumber: 100n,
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: 0,
});

const run = (h: SqliteD1) =>
  processLoanLogs([transfer(11n)] as never, { DB: h.d1 } as unknown as Env, CHAIN, new Map([[100n, 500]]), stubClient, DIAMOND);

const participants = (h: SqliteD1) =>
  h.db.prepare('SELECT wallet, role FROM loan_participants WHERE chain_id = ? AND loan_id = 7').all(CHAIN);
const lenderOwner = (h: SqliteD1) =>
  (h.db.prepare('SELECT lender_current_owner AS o FROM loans WHERE chain_id = ? AND loan_id = 7').get(CHAIN) as { o: string }).o;

describe('a retired receipt moving on', () => {
  it('is neither a holder nor a participant of the closed side', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, ZERO); // the lender side was retired (PositionRetired)
    await run(h);
    expect(lenderOwner(h)).toBe(ZERO);
    expect(participants(h)).toEqual([]);
  });

  it('a live side still re-points its holder and records the participant', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, SELLER);
    await run(h);
    expect(lenderOwner(h)).toBe(BUYER);
    expect(participants(h)).toEqual([{ wallet: BUYER, role: 'lender' }]);
  });
});
