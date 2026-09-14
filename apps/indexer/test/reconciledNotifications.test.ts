/**
 * Inbox rows for terminals the #2101 repair found rather than an event
 * announced (#2190 r2 `4006071734`).
 *
 * Without these the holders of a ghost position get no terminal row at all —
 * the event was missed for good, so the event materializer never sees it.
 * The cases below are mostly about what the rows DO NOT claim: the repair
 * cannot know when the loan ended, so nothing here is dated to the ending.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  materializeReconciledNotifications,
  RECONCILED_EVENT_KIND,
} from '../src/notifications';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const LENDER = '0x00000000000000000000000000000000000000aa';
const BORROWER = '0x00000000000000000000000000000000000000bb';

function seedLoan(h: SqliteD1, loanId: number, status: string, saleVehicle = 0) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at, is_sale_vehicle)
       VALUES (?, ?, 1, ?, ?, ?, '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '1', '2', ?, ?,
         500, 0, 0, 0, 0, ?)`,
    )
    .run(CHAIN, loanId, status, LENDER, BORROWER, LENDER, BORROWER, saleVehicle);
}

const rowsFor = (h: SqliteD1, loanId: number) =>
  h.db
    .prepare('SELECT * FROM notifications WHERE chain_id = ? AND loan_id = ? ORDER BY recipient')
    .all(CHAIN, loanId) as Array<Record<string, unknown>>;

describe('materializeReconciledNotifications', () => {
  it('gives BOTH holders a terminal row they would otherwise never get', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 8, 'defaulted');
    const n = await materializeReconciledNotifications(
      h.d1 as never, CHAIN, [{ loanId: 8, to: 'defaulted' }], 500, 1_700_000_000,
    );
    expect(n).toBe(2);
    const rows = rowsFor(h, 8);
    expect(rows.map((r) => r.recipient)).toEqual([LENDER, BORROWER]);
    expect(rows.every((r) => r.kind === 'loan_defaulted')).toBe(true);
  });

  it('does not claim an event it never saw, nor a time it cannot know', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 9, 'repaid');
    await materializeReconciledNotifications(
      h.d1 as never, CHAIN, [{ loanId: 9, to: 'repaid' }], 777, 1_700_000_042,
    );
    const [row] = rowsFor(h, 9);
    // Provenance, not a fabricated event name — and NOT null, which already
    // means "cron-derived calendar row".
    expect(row.event_kind).toBe(RECONCILED_EVENT_KIND);
    expect(RECONCILED_EVENT_KIND).not.toBeNull();
    // No log behind it.
    expect(row.log_index).toBe(-1);
    // Dated to when the platform found out, which is true; the block is the
    // one the state was observed at, so the row sorts as current.
    expect(row.created_at).toBe(1_700_000_042);
    expect(row.block_number).toBe(777);
  });

  it('is idempotent, so a re-run cannot double-notify a holder', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 10, 'repaid');
    const first = await materializeReconciledNotifications(
      h.d1 as never, CHAIN, [{ loanId: 10, to: 'repaid' }], 500, 1_700_000_000,
    );
    // A DIFFERENT observed block on the re-run: the dedup key must not move
    // with the head, or the same holder gets the same news twice.
    const second = await materializeReconciledNotifications(
      h.d1 as never, CHAIN, [{ loanId: 10, to: 'repaid' }], 900, 1_700_000_500,
    );
    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(rowsFor(h, 10)).toHaveLength(2);
  });

  it('writes nothing for a sale-vehicle loan', async () => {
    // Bookkeeping, not a position anyone holds — the same exclusion the
    // event path applies.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 11, 'repaid', 1);
    const n = await materializeReconciledNotifications(
      h.d1 as never, CHAIN, [{ loanId: 11, to: 'repaid' }], 500, 1_700_000_000,
    );
    expect(n).toBe(0);
    expect(rowsFor(h, 11)).toHaveLength(0);
  });

  it('writes nothing for a status it does not recognise', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 12, 'repaid');
    const n = await materializeReconciledNotifications(
      h.d1 as never, CHAIN, [{ loanId: 12, to: 'something_new' }], 500, 1_700_000_000,
    );
    expect(n).toBe(0);
  });
});
