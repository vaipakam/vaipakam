/**
 * Inbox rows for terminals the #2101 repair found rather than an event
 * announced (#2190 r2 `4006071734`).
 *
 * Without these the holders of a ghost position get no terminal row at all —
 * the event was missed for good, so the event materializer never sees it.
 * The cases below are mostly about what the rows DO NOT claim: the repair
 * cannot know when the loan ended, so nothing here is dated to the ending,
 * and it cannot always say HOW it ended, so sometimes it says nothing.
 *
 * The rows are PLANNED here and committed through the same statement the
 * repair folds into its own transaction — writing them afterwards was the
 * defect #2190 r4 `4007360360` caught, since a repaired row leaves the live
 * set and no later pass can rediscover it to try again.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DERIVED_LOG_INDEX,
  notificationInsertStatement,
  planReconciledNotifications,
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

/** Plan the rows and commit them the way the repair does — in one batch —
 *  so these cases exercise the same statements the transaction carries. */
async function planAndWrite(
  h: SqliteD1,
  repaired: Array<{ loanId: number; to: string }>,
  observedBlock: number,
  nowSec: number,
  verifiedHolders?: { lender: string | null; borrower: string | null },
): Promise<number> {
  const rows = await planReconciledNotifications(
    h.d1 as never, CHAIN, repaired, observedBlock, nowSec, verifiedHolders,
  );
  if (rows.length === 0) return 0;
  const results = await (h.d1 as { batch(s: unknown[]): Promise<Array<{ meta?: { changes?: number } }>> })
    .batch(rows.map((r) => notificationInsertStatement(h.d1 as never, r)));
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

const rowsFor = (h: SqliteD1, loanId: number) =>
  h.db
    .prepare('SELECT * FROM notifications WHERE chain_id = ? AND loan_id = ? ORDER BY recipient')
    .all(CHAIN, loanId) as Array<Record<string, unknown>>;

describe('planReconciledNotifications', () => {
  it('gives BOTH holders a terminal row they would otherwise never get', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 8, 'defaulted');
    const n = await planAndWrite(h, [{ loanId: 8, to: 'defaulted' }], 500, 1_700_000_000);
    expect(n).toBe(2);
    const rows = rowsFor(h, 8);
    expect(rows.map((r) => r.recipient)).toEqual([LENDER, BORROWER]);
    expect(rows.every((r) => r.kind === 'loan_defaulted')).toBe(true);
  });

  it('does not claim an event it never saw, nor a time it cannot know', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 9, 'repaid');
    await planAndWrite(h, [{ loanId: 9, to: 'repaid' }], 777, 1_700_000_042);
    const [row] = rowsFor(h, 9);
    // Provenance, not a fabricated event name — and NOT null, which already
    // means "cron-derived calendar row".
    expect(row.event_kind).toBe(RECONCILED_EVENT_KIND);
    expect(RECONCILED_EVENT_KIND).not.toBeNull();
    // No log behind it — but it must still sort NEWEST within its block, or
    // the client's `(block, logIndex, id)` read cursor treats it as already
    // seen when the holder has opened any event row at that same head. The
    // calendar sweep learned this first; the repair reintroduced it with -1
    // (#2190 r5), which is why the sentinel is now shared.
    expect(row.log_index).toBe(DERIVED_LOG_INDEX);
    expect(DERIVED_LOG_INDEX).toBeGreaterThan(0);
    // Dated to when the platform found out, which is true; the block is the
    // one the state was observed at, so the row sorts as current.
    expect(row.created_at).toBe(1_700_000_042);
    expect(row.block_number).toBe(777);
  });

  it('is idempotent, so a re-run cannot double-notify a holder', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 10, 'repaid');
    const first = await planAndWrite(h, [{ loanId: 10, to: 'repaid' }], 500, 1_700_000_000);
    // A DIFFERENT observed block on the re-run: the dedup key must not move
    // with the head, or the same holder gets the same news twice.
    const second = await planAndWrite(h, [{ loanId: 10, to: 'repaid' }], 900, 1_700_000_500);
    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(rowsFor(h, 10)).toHaveLength(2);
  });

  it('writes nothing for a sale-vehicle loan', async () => {
    // Bookkeeping, not a position anyone holds — the same exclusion the
    // event path applies.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 11, 'repaid', 1);
    const n = await planAndWrite(h, [{ loanId: 11, to: 'repaid' }], 500, 1_700_000_000);
    expect(n).toBe(0);
    expect(rowsFor(h, 11)).toHaveLength(0);
  });

  it('labels an internal match as a match, not as a repayment', async () => {
    // `internal_matched` has its own kind; mapping it to `loan_repaid`
    // tells the holder the loan was fully repaid, which is a different
    // financial outcome (#2190 r4).
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 13, 'internal_matched');
    await planAndWrite(h, [{ loanId: 13, to: 'internal_matched' }], 500, 1_700_000_000);
    expect(rowsFor(h, 13).every((r) => r.kind === 'internal_matched')).toBe(true);
  });

  it('writes NOTHING for a settled loan rather than calling it repaid', async () => {
    // On-chain `Settled` says the claims are done, not how the loan ended —
    // a repayment, a default and a forced sale all reach it. Telling a
    // holder their loan was "fully repaid" when it may have been
    // liquidated is an unsupported financial claim, and there is no kind
    // meaning "ended, and this pass cannot say how".
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 14, 'settled');
    const n = await planAndWrite(h, [{ loanId: 14, to: 'settled' }], 500, 1_700_000_000);
    expect(n).toBe(0);
    expect(rowsFor(h, 14)).toHaveLength(0);
  });

  it('writes nothing for a status it does not recognise', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 12, 'repaid');
    const n = await planAndWrite(h, [{ loanId: 12, to: 'something_new' }], 500, 1_700_000_000);
    expect(n).toBe(0);
  });
});

describe('who the notice actually goes to', () => {
  const NEW_HOLDER = '0x00000000000000000000000000000000000000cc';

  it('prefers the chain-verified holder over the stored column', async () => {
    // The window that lost the terminal could equally have contained the
    // position transfer, so `*_current_owner` is stale for the same reason
    // the status was (#2190 r5). Sending the one notice a holder gets to
    // somebody who exited — while the real holder hears nothing — is worse
    // than the silence this notice exists to end.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 30, 'defaulted');
    await planAndWrite(h, [{ loanId: 30, to: 'defaulted' }], 500, 1_700_000_000, {
      lender: NEW_HOLDER,
      borrower: BORROWER,
    });
    const recipients = rowsFor(h, 30).map((r) => r.recipient);
    expect(recipients).toContain(NEW_HOLDER);
    expect(recipients).not.toContain(LENDER);
  });

  it('WITHHOLDS a side it could not substantiate, rather than guessing', async () => {
    // A burned token reverts, and so does any other read failure. Falling
    // back to the stored column there would use exactly the value the
    // verification exists to distrust.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 31, 'defaulted');
    const n = await planAndWrite(
      h, [{ loanId: 31, to: 'defaulted' }], 500, 1_700_000_000,
      { lender: null, borrower: BORROWER },
    );
    expect(n).toBe(1);
    expect(rowsFor(h, 31).map((r) => r.recipient)).toEqual([BORROWER]);
  });

  it('falls back to the stored columns when no verification was done', async () => {
    // A caller with no reason to distrust the columns passes nothing, and
    // the existing behaviour is unchanged.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 32, 'defaulted');
    const n = await planAndWrite(h, [{ loanId: 32, to: 'defaulted' }], 500, 1_700_000_000);
    expect(n).toBe(2);
  });
});
