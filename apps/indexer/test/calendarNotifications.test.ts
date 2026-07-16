/**
 * Calendar notification sweep (#1213 PR 2) — the time-derived inbox rows
 * (maturity T-7d / T-1d, grace entered). `planCalendarRows` is the pure
 * window/dedup logic; `sweepCalendarNotifications` runs it over the REAL
 * migrated schema. No RPC anywhere — that's the point (illiquid loans
 * get calendar rows despite having no oracle).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CRON_LOG_INDEX,
  calendarWindowSql,
  defaultGraceSeconds,
  effectiveGraceSeconds,
  graceCaseSql,
  maxGraceSeconds,
  planCalendarRows,
  sweepCalendarNotifications,
  type CalendarLoanRow,
  type GraceBucketJson,
} from '../src/calendarNotifications';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const LENDER = '0x00000000000000000000000000000000000000aa';
const BORROWER = '0x00000000000000000000000000000000000000bb';
const DAY = 86_400;
const NOW = 1_800_000_000;
const HEAD = 4_242;

const loanRow = (
  loanId: number,
  startTime: number,
  durationDays: number,
): CalendarLoanRow => ({
  loan_id: loanId,
  lender: LENDER,
  borrower: BORROWER,
  lender_current_owner: LENDER,
  borrower_current_owner: BORROWER,
  start_time: startTime,
  duration_days: durationDays,
});

/** A loan whose maturity is `deltaSec` away from NOW (negative = past). */
const maturingIn = (loanId: number, deltaSec: number, durationDays = 30) =>
  loanRow(loanId, NOW + deltaSec - durationDays * DAY, durationDays);

describe('defaultGraceSeconds (LibVaipakam.gracePeriod zero-bucket mirror)', () => {
  it('matches the compile-time schedule', () => {
    expect(defaultGraceSeconds(3)).toBe(3_600);
    expect(defaultGraceSeconds(7)).toBe(DAY);
    expect(defaultGraceSeconds(30)).toBe(3 * DAY);
    expect(defaultGraceSeconds(90)).toBe(7 * DAY);
    expect(defaultGraceSeconds(180)).toBe(14 * DAY);
    expect(defaultGraceSeconds(365)).toBe(30 * DAY);
  });
});

describe('effectiveGraceSeconds (governance buckets — LibVaipakam.gracePeriod semantics)', () => {
  const BUCKETS: GraceBucketJson[] = [
    { maxDurationDays: '30', graceSeconds: '7200' }, // <30d → 2h
    { maxDurationDays: '0', graceSeconds: String(45 * DAY) }, // catch-all → 45d
  ];

  it('falls back to the default schedule when no buckets are set', () => {
    expect(effectiveGraceSeconds(30, null)).toBe(3 * DAY);
    expect(effectiveGraceSeconds(30, [])).toBe(3 * DAY);
  });

  it('walks buckets in order — first strictly-exceeding threshold wins, 0 is the catch-all', () => {
    expect(effectiveGraceSeconds(10, BUCKETS)).toBe(7200); // 10 < 30
    expect(effectiveGraceSeconds(30, BUCKETS)).toBe(45 * DAY); // 30 !< 30 → catch-all
    expect(effectiveGraceSeconds(365, BUCKETS)).toBe(45 * DAY);
  });

  it('bounds the sweep look-back by the WIDEST grace (custom > default supported)', () => {
    expect(maxGraceSeconds(null)).toBe(30 * DAY);
    expect(maxGraceSeconds(BUCKETS)).toBe(45 * DAY); // custom 45d wins
    // A schedule narrower than the default never SHRINKS the window
    // (defensive — missing a live grace loan is the worse failure).
    expect(maxGraceSeconds([{ maxDurationDays: '0', graceSeconds: '3600' }])).toBe(30 * DAY);
  });

  it('plans grace_entered against the CONFIGURED schedule, not the default', () => {
    // 30d loan, 4 days past due. Default grace (3d) would suppress; the
    // configured catch-all (45d) keeps the window open (Codex #1298 r1).
    const rows = planCalendarRows(CHAIN, [maturingIn(40, -4 * DAY)], NOW, HEAD, BUCKETS);
    expect(rows.filter((r) => r.kind === 'grace_entered')).toHaveLength(2);
    // And a schedule SHORTER than default closes it earlier: 2h grace,
    // 1 day past due → suppressed.
    const short: GraceBucketJson[] = [{ maxDurationDays: '0', graceSeconds: '7200' }];
    const none = planCalendarRows(CHAIN, [maturingIn(41, -1 * DAY)], NOW, HEAD, short);
    expect(none.filter((r) => r.kind === 'grace_entered')).toHaveLength(0);
  });
});

describe('graceCaseSql (per-loan grace as a SQL predicate)', () => {
  it('renders the default schedule when no buckets are set', () => {
    const sql = graceCaseSql(null);
    expect(sql).toContain('WHEN duration_days < 7 THEN 3600');
    expect(sql).toContain('ELSE 2592000 END');
  });

  it('renders configured buckets (catch-all → ELSE) and rejects malformed values', () => {
    const sql = graceCaseSql([
      { maxDurationDays: '30', graceSeconds: '7200' },
      { maxDurationDays: '0', graceSeconds: String(45 * DAY) },
    ]);
    expect(sql).toBe(`CASE WHEN duration_days < 30 THEN 7200 ELSE ${45 * DAY} END`);
    // A single catch-all renders as a constant.
    expect(graceCaseSql([{ maxDurationDays: '0', graceSeconds: '3600' }])).toBe('3600');
    // Malformed values must never be interpolated — default instead.
    expect(graceCaseSql([{ maxDurationDays: 'DROP TABLE', graceSeconds: '1' }])).toContain(
      'WHEN duration_days < 7 THEN 3600',
    );
  });
});

describe('planCalendarRows (pure window + dedup logic)', () => {
  it('fires T-7d (borrower only) inside the window, not before', () => {
    const inWindow = planCalendarRows(CHAIN, [maturingIn(1, 6 * DAY)], NOW, HEAD);
    expect(inWindow).toHaveLength(1);
    expect(inWindow[0]).toMatchObject({
      kind: 'maturity_7d',
      recipient: BORROWER,
      loanId: 1,
      blockNumber: HEAD,
      // The sentinel keeps a head-stamped cron row NEWER than any real
      // log in the same block, so a read cursor set on an event row
      // can't swallow a fresh reminder (Codex #1298 r2).
      logIndex: CRON_LOG_INDEX,
      eventKind: null,
    });
    // 8 days out — not yet.
    expect(planCalendarRows(CHAIN, [maturingIn(2, 8 * DAY)], NOW, HEAD)).toHaveLength(0);
  });

  it('fires BOTH T-7d and T-1d inside the last day (each its own one-shot row)', () => {
    const rows = planCalendarRows(CHAIN, [maturingIn(3, 12 * 3_600)], NOW, HEAD);
    expect(rows.map((r) => r.kind).sort()).toEqual(['maturity_1d', 'maturity_7d']);
    expect(rows.every((r) => r.recipient === BORROWER)).toBe(true);
  });

  it('fires grace_entered for BOTH parties while the grace window runs, and stops past grace end', () => {
    // 30d loan → 3d grace. 1 day past due: in grace.
    const inGrace = planCalendarRows(CHAIN, [maturingIn(4, -1 * DAY)], NOW, HEAD);
    const graceRows = inGrace.filter((r) => r.kind === 'grace_entered');
    expect(graceRows.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
    // 4 days past due (grace 3d) → grace over; a stale "grace running"
    // nudge would be wrong (the terminal row arrives via the default
    // events instead).
    const pastGrace = planCalendarRows(CHAIN, [maturingIn(5, -4 * DAY)], NOW, HEAD);
    expect(pastGrace.filter((r) => r.kind === 'grace_entered')).toHaveLength(0);
  });

  it('embeds the maturity in the dedup key so an extension re-arms the milestone', () => {
    const before = planCalendarRows(CHAIN, [maturingIn(6, 6 * DAY)], NOW, HEAD);
    // Extended: same loan, maturity pushed out — later, inside the new
    // window, the key differs → a fresh row (INSERT OR IGNORE won't drop it).
    const extended = planCalendarRows(
      CHAIN,
      [maturingIn(6, 6 * DAY + 30 * DAY)],
      NOW + 30 * DAY,
      HEAD + 1,
    );
    expect(before[0].dedupKey).not.toBe(extended[0].dedupKey);
    expect(before[0].dedupKey).toContain(':maturity_7d:6:');
  });

  it('skips a zero start_time (unhealed stub) and a burned side', () => {
    expect(planCalendarRows(CHAIN, [loanRow(7, 0, 30)], NOW, HEAD)).toHaveLength(0);
    const burned = {
      ...maturingIn(8, -1 * DAY),
      lender_current_owner: '0x0000000000000000000000000000000000000000',
    };
    const rows = planCalendarRows(CHAIN, [burned], NOW, HEAD);
    // grace_entered still reaches the live borrower; the burned lender
    // side is skipped by recipientFor.
    expect(rows.filter((r) => r.kind === 'grace_entered').map((r) => r.recipient)).toEqual([
      BORROWER,
    ]);
  });
});

// ── The sweep over the real migrated schema ────────────────────────────

function seedLoan(
  h: SqliteD1,
  loanId: number,
  startTime: number,
  durationDays: number,
  status = 'active',
  flags: { isStub?: number; isSaleVehicle?: number } = {},
) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at,
         is_stub, is_sale_vehicle)
       VALUES (?, ?, 1, ?, ?, ?, '100', '200', 0, 0, '0xa', '0xc', ?, '0', '0',
         '1', '2', ?, ?, 500, ?, 0, 0, 0, ?, ?)`,
    )
    .run(
      CHAIN,
      loanId,
      status,
      LENDER,
      BORROWER,
      durationDays,
      LENDER,
      BORROWER,
      startTime,
      flags.isStub ?? 0,
      flags.isSaleVehicle ?? 0,
    );
}

/** Seed the grace snapshot the sweep now REQUIRES (Codex #1298 r5):
 *  '[]' = the definitive no-buckets state (default schedule); a JSON
 *  array = governance buckets; without a populated row the sweep
 *  defers rather than guess. */
function seedGraceConfig(h: SqliteD1, bucketsJson = '[]') {
  h.db
    .prepare(
      `INSERT INTO protocol_config
         (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
       VALUES (?, '[]', '[]', ?, 1, ?)`,
    )
    .run(CHAIN, bucketsJson, NOW);
}

describe('sweepCalendarNotifications (over the migrated schema)', () => {
  const rowsInDb = (h: SqliteD1) =>
    h.db
      .prepare(
        'SELECT recipient, kind, loan_id, block_number, log_index, event_kind FROM notifications ORDER BY id',
      )
      .all() as Array<{
      recipient: string;
      kind: string;
      loan_id: number;
      block_number: number;
      log_index: number;
      event_kind: string | null;
    }>;

  it('inserts due milestones stamped at the head block, idempotent across ticks', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 1, NOW + 6 * DAY - 30 * DAY, 30); // matures in 6d → T-7d due
    // NB: assert on the TABLE, not the return value — the test shim's
    // db.batch() surfaces no meta.changes counts.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    const rows = rowsInDb(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'maturity_7d',
      recipient: BORROWER,
      loan_id: 1,
      block_number: HEAD, // stamped — a NULL block would sink + break keyset paging
      log_index: CRON_LOG_INDEX, // above real logs in the block (r2)
      event_kind: null,
    });
    // Next cron tick, same window → INSERT OR IGNORE no-op.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 60, HEAD + 5);
    expect(rowsInDb(h)).toHaveLength(1);
  });

  it('skips terminal loans, vehicles, and stubs', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 2, NOW + DAY - 30 * DAY, 30, 'repaid');
    seedLoan(h, 3, NOW + DAY - 30 * DAY, 30, 'active', { isSaleVehicle: 1 });
    seedLoan(h, 5, NOW + DAY - 30 * DAY, 30, 'active', { isStub: 1 });
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h)).toHaveLength(0);
  });

  it('never lets dead past-grace loans occupy the LIMIT and starve live reminders (Codex #1298 r2)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    // 2000 loans (the full SWEEP_LIMIT) that are 4–20 days overdue on the
    // default 3d grace — past their OWN grace end, so they emit nothing.
    // Their maturities are all EARLIER than the live loan's, so a
    // window-then-LIMIT ordering without the per-loan-grace SQL filter
    // would serve exactly these 2000 and starve the live loan forever.
    const stmt = h.db.prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at, is_stub, is_sale_vehicle)
       VALUES (?, ?, 1, 'active', ?, ?, '100', '200', 0, 0, '0xa', '0xc', 30, '0', '0',
         '1', '2', ?, ?, 500, ?, 0, 0, 0, 0, 0)`,
    );
    for (let i = 1; i <= 2000; i++) {
      const overdue = (4 + (i % 17)) * DAY; // 4..20 days overdue
      stmt.run(CHAIN, i, LENDER, BORROWER, LENDER, BORROWER, NOW - overdue - 30 * DAY);
    }
    // The one live loan: in grace (1 day past due), latest maturity.
    seedLoan(h, 3000, NOW - 1 * DAY - 30 * DAY, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    const rows = rowsInDb(h);
    expect(rows.map((r) => r.loan_id)).toEqual([3000, 3000]); // both parties, only the live loan
  });

  it('honors snapshotted governance grace buckets over the default schedule', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // 30d loan, 4 days past due — default grace (3d) has closed, but the
    // snapshotted catch-all bucket (45d) keeps the window open.
    seedLoan(h, 7, NOW - 4 * DAY - 30 * DAY, 30);
    h.db
      .prepare(
        `INSERT INTO protocol_config
           (chain_id, bundle_json, master_flags_json, grace_buckets_json, source_block, updated_at)
         VALUES (?, '[]', '[]', ?, 1, ?)`,
      )
      .run(
        CHAIN,
        JSON.stringify([{ maxDurationDays: '0', graceSeconds: String(45 * DAY) }]),
        NOW,
      );
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    const rows = rowsInDb(h);
    expect(rows.map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
  });

  it('emits grace_entered to both parties for a just-past-due loan', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 6, NOW - 1 * DAY - 30 * DAY, 30); // 1d past due, 3d grace
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    // grace_entered × both parties (T-7d/T-1d windows are behind us —
    // their `now < maturity` bound excludes a past-due loan).
    const rows = rowsInDb(h);
    expect(rows.map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
    expect(rows.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
  });

  it('defers while the grace schedule is unknown, sweeps once it is definitive (Codex #1298 r5)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 9, NOW - 1 * DAY - 30 * DAY, 30); // in grace — would emit
    // No protocol_config row at all → schedule unknown → defer.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h)).toHaveLength(0);
    // Pre-0039 row (NULL column) → still unknown → defer.
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, source_block, updated_at)
         VALUES (?, '[]', '[]', 1, ?)`,
      )
      .run(CHAIN, NOW);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h)).toHaveLength(0);
    // '[]' = the DEFINITIVE no-buckets state → default schedule applies.
    h.db.prepare(`UPDATE protocol_config SET grace_buckets_json = '[]' WHERE chain_id = ?`).run(CHAIN);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h).map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
  });

  it('advances past already-notified loans instead of re-spending the LIMIT on them (Codex #1298 r5)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    // SWEEP_LIMIT in-grace loans (30d duration → 3d default grace, all
    // ~1 day overdue) whose maturities all precede the straggler's.
    const stmt = h.db.prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at, is_stub, is_sale_vehicle)
       VALUES (?, ?, 1, 'active', ?, ?, '100', '200', 0, 0, '0xa', '0xc', 30, '0', '0',
         '1', '2', ?, ?, 500, ?, 0, 0, 0, 0, 0)`,
    );
    for (let i = 1; i <= 2000; i++) {
      const overdue = DAY + (i % 1000); // in grace, earlier maturity than the straggler
      stmt.run(CHAIN, i, LENDER, BORROWER, LENDER, BORROWER, NOW - overdue - 30 * DAY);
    }
    // The straggler: in grace too, but the LATEST maturity — pre-r5 the
    // 2000 already-notified rows would re-occupy the LIMIT every tick
    // (INSERT OR IGNORE no-ops) and starve it for its whole window.
    seedLoan(h, 3000, NOW - 12 * 3_600 - 30 * DAY, 30); // 12h overdue
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h).filter((r) => r.loan_id === 3000)).toHaveLength(0); // tick 1: starved
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 60, HEAD + 5);
    const straggler = rowsInDb(h).filter((r) => r.loan_id === 3000);
    expect(straggler.map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']); // tick 2: served
  });

  it('range-scans idx_loans_calendar_maturity — no full-set temp B-tree (Codex #1298 r4)', () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // EXPLAIN QUERY PLAN over the EXACT production SQL (default and
    // governance-bucket grace CASEs): migration 0040's partial
    // expression index must serve both the window filter and the
    // ORDER BY, or the every-tick sweep scales with the chain's whole
    // active loan set instead of the due/grace window.
    for (const graceCase of [
      graceCaseSql(null),
      graceCaseSql([
        { maxDurationDays: '30', graceSeconds: String(2 * DAY) },
        { maxDurationDays: '0', graceSeconds: String(45 * DAY) },
      ]),
    ]) {
      const plan = h.db
        .prepare(`EXPLAIN QUERY PLAN ${calendarWindowSql(graceCase)}`)
        .all(CHAIN, NOW - 45 * DAY, NOW + 7 * DAY, NOW, NOW, NOW)
        .map((r) => String((r as { detail: string }).detail))
        .join(' | ');
      expect(plan).toContain('idx_loans_calendar_maturity');
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });
});
