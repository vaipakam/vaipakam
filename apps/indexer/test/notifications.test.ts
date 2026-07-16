/**
 * In-app notification center (#1213 / E-11) — the materialization
 * contract, pinned. `planNotifications` is the pure recipient/dedup
 * resolver; `materializeNotifications` runs it over the REAL migrated
 * schema (via the sqlite D1 shim) and INSERT-OR-IGNOREs the rows.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  planNotifications,
  materializeNotifications,
  EVENT_NOTIF_MAP,
  type NotifSourceLog,
} from '../src/notifications';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const LENDER = '0x00000000000000000000000000000000000000aa';
const BORROWER = '0x00000000000000000000000000000000000000bb';
const BUYER = '0x00000000000000000000000000000000000000cc';
const ZERO = '0x0000000000000000000000000000000000000000';

const log = (
  eventName: string,
  loanId: number | bigint,
  blockNumber = 100n,
  logIndex = 0,
): NotifSourceLog => ({
  eventName,
  args: { loanId: typeof loanId === 'bigint' ? loanId : BigInt(loanId) },
  blockNumber,
  logIndex,
});

const parties = (
  lender: string | null,
  borrower: string | null,
  lenderCur = lender,
  borrowerCur = borrower,
) => ({
  lender,
  borrower,
  lenderCurrentOwner: lenderCur,
  borrowerCurrentOwner: borrowerCur,
});

describe('planNotifications', () => {
  it('materializes both parties for a both-sided event', () => {
    const rows = planNotifications(
      84532,
      [log('LoanInitiated', 7)],
      new Map([[7, parties(LENDER, BORROWER)]]),
      new Map([[100n, 1000]]),
      9999,
    );
    expect(rows.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
    expect(rows.every((r) => r.kind === 'loan_matched')).toBe(true);
    expect(rows.every((r) => r.createdAt === 1000)).toBe(true); // block time
  });

  it('materializes only the lender for partial_repay', () => {
    const rows = planNotifications(
      84532,
      [log('PartialRepaid', 7)],
      new Map([[7, parties(LENDER, BORROWER)]]),
      new Map(),
      9999,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(LENDER);
    expect(rows[0].kind).toBe('partial_repay');
    expect(rows[0].createdAt).toBe(9999); // nowSec fallback (no block ts)
  });

  it('resolves the CURRENT position-NFT holder, not the origination party (Codex #1292 r3)', () => {
    // The lender side was sold to BUYER (current owner) — the design's
    // ownership discipline routes the row to the current holder (who owns
    // the claim), not the exited origination lender.
    const rows = planNotifications(
      84532,
      [log('LoanRepaid', 7)],
      new Map([[7, parties(LENDER, BORROWER, BUYER, BORROWER)]]),
      new Map(),
      1,
    );
    expect(rows.map((r) => r.recipient).sort()).toEqual([BUYER, BORROWER].sort());
    expect(rows.some((r) => r.recipient === LENDER)).toBe(false);
  });

  it('skips a burned/cash-satisfied side (0x0 current owner) — the backstop lender case', () => {
    // BackstopAbsorbedLoan burns + cash-satisfies the lender NFT
    // (lender_current_owner → 0x0), so only the live borrower (residual
    // claim) is notified — the cashed-out lender is not pinged.
    const rows = planNotifications(
      84532,
      [log('BackstopAbsorbedLoan', 7)],
      new Map([[7, parties(LENDER, BORROWER, ZERO, BORROWER)]]),
      new Map(),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(BORROWER);
    expect(rows[0].kind).toBe('loan_defaulted');
  });

  it('self-dedups a wallet on both sides of its own loan', () => {
    const rows = planNotifications(
      84532,
      [log('LoanRepaid', 7)],
      new Map([[7, parties(LENDER, LENDER)]]),
      new Map(),
      1,
    );
    expect(rows).toHaveLength(1);
  });

  it('fans an internal-match close out to every leg (multi-loan event)', () => {
    // InternalMatchExecuted carries loanIdA/B/C; a two-way match sets C=0.
    const rows = planNotifications(
      84532,
      [
        {
          eventName: 'InternalMatchExecuted',
          args: { loanIdA: 4n, loanIdB: 5n, loanIdC: 0n },
          blockNumber: 100n,
          logIndex: 0,
        },
      ],
      new Map([
        [4, parties(LENDER, BORROWER)],
        [5, parties(BUYER, BORROWER)],
      ]),
      new Map(),
      1,
    );
    // Loan 4 → LENDER + BORROWER; loan 5 → BUYER + BORROWER; loan 0 skipped.
    expect(rows.map((r) => r.loanId).sort()).toEqual([4, 4, 5, 5]);
    expect(rows.every((r) => r.kind === 'internal_matched')).toBe(true);
    // A shared party across legs still gets one row PER leg (distinct loanId).
    expect(rows.filter((r) => r.recipient === BORROWER).map((r) => r.loanId).sort()).toEqual([4, 5]);
  });

  it('ignores unmapped events and unknown loans', () => {
    expect(
      planNotifications(84532, [log('OfferCreated', 1)], new Map(), new Map(), 1),
    ).toHaveLength(0);
    expect(
      planNotifications(84532, [log('LoanRepaid', 7)], new Map(), new Map(), 1),
    ).toHaveLength(0); // no parties row → no recipient
  });

  it('every mapped event kind resolves to a known notification kind', () => {
    for (const m of Object.values(EVENT_NOTIF_MAP)) {
      expect(typeof m.kind).toBe('string');
      expect(['both', 'lender', 'borrower']).toContain(m.recipients);
    }
  });

  it('maps the swap-to-repay + backstop paths that have no LoanRepaid/Defaulted companion (Codex #1292 r1)', () => {
    // These emit only their own event on-chain, so without a direct
    // mapping the affected wallets would get no inbox row.
    expect(EVENT_NOTIF_MAP.SwapToRepayExecuted).toEqual({
      kind: 'loan_repaid',
      recipients: 'both',
    });
    expect(EVENT_NOTIF_MAP.SwapToRepayPartialExecuted).toEqual({
      kind: 'partial_repay',
      recipients: 'lender',
    });
    expect(EVENT_NOTIF_MAP.BackstopAbsorbedLoan).toEqual({
      kind: 'loan_defaulted',
      recipients: 'both',
    });
    // Terminal HF liquidations emit only HFLiquidationTriggered /
    // LiquidationDiscounted (no LoanDefaulted companion) — mapped so a
    // real HF liquidation still produces a terminal row (Codex #1292 r4).
    expect(EVENT_NOTIF_MAP.HFLiquidationTriggered).toEqual({
      kind: 'loan_defaulted',
      recipients: 'both',
    });
    expect(EVENT_NOTIF_MAP.LiquidationDiscounted).toEqual({
      kind: 'loan_defaulted',
      recipients: 'both',
    });

    const rows = planNotifications(
      84532,
      [log('SwapToRepayExecuted', 7)],
      new Map([[7, parties(LENDER, BORROWER)]]),
      new Map(),
      1,
    );
    expect(rows.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
    expect(rows.every((r) => r.kind === 'loan_repaid')).toBe(true);
  });

  it('chunks the party lookup so a >99-loan scan does not overflow D1 binds', async () => {
    // 120 distinct notification-worthy loans in one scan: the single-IN
    // query would exceed D1's 100-bind cap and (fail-open) skip the whole
    // scan; chunking keeps every row.
    const h = createSqliteD1(ALL_MIGRATIONS);
    const logs: NotifSourceLog[] = [];
    for (let id = 1; id <= 120; id++) {
      seedLoan(h, id, LENDER, BORROWER);
      logs.push(log('LoanRepaid', id, BigInt(100 + id), 0));
    }
    await materializeNotifications(h.d1 as never, 84532, logs, new Map(), 999);
    const n = (
      h.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }
    ).n;
    expect(n).toBe(240); // 120 loans × both parties
  });
});

function seedLoan(
  h: SqliteD1,
  loanId: number,
  lender: string,
  borrower: string,
  lenderCur = lender,
  borrowerCur = borrower,
) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (84532, ?, 1, 'repaid', ?, ?, '100', '200', 0, 0, '0xlend', '0xcoll',
         30, '0', '0', '1', '2', ?, ?, 500, 0, 0, 0, 0)`,
    )
    .run(loanId, lender, borrower, lenderCur, borrowerCur);
}

describe('materializeNotifications (over the migrated schema)', () => {
  const setup = () => createSqliteD1(ALL_MIGRATIONS);
  const countRows = (h: SqliteD1) =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;

  it('inserts one row per recipient and is idempotent on re-run', async () => {
    const h = setup();
    seedLoan(h, 7, LENDER, BORROWER);
    const logs = [log('LoanInitiated', 7)];
    await materializeNotifications(h.d1 as never, 84532, logs, new Map([[100n, 500]]), 999);
    expect(countRows(h)).toBe(2);
    const rows = h.db
      .prepare('SELECT recipient, kind, loan_id FROM notifications ORDER BY recipient')
      .all() as Array<{ recipient: string; kind: string; loan_id: number }>;
    expect(rows.map((r) => r.recipient)).toEqual([LENDER, BORROWER].sort());
    expect(rows.every((r) => r.kind === 'loan_matched' && r.loan_id === 7)).toBe(true);

    // Re-scan the same event → INSERT OR IGNORE, no duplicates.
    await materializeNotifications(h.d1 as never, 84532, logs, new Map([[100n, 500]]), 999);
    expect(countRows(h)).toBe(2);
  });

  it('does nothing when the scan has no notification-worthy events', async () => {
    const h = setup();
    seedLoan(h, 7, LENDER, BORROWER);
    await materializeNotifications(
      h.d1 as never,
      84532,
      [log('OfferCreated', 7), log('AutoDailyDeducted', 7)],
      new Map(),
      999,
    );
    expect(countRows(h)).toBe(0);
  });
});
