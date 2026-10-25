/**
 * Calendar notification sweep (#1213 PR 2) — the time-derived inbox rows
 * (maturity T-7d / T-1d, grace entered). `planCalendarRows` is the pure
 * window/dedup logic; `sweepCalendarNotifications` runs it over the REAL
 * migrated schema. No RPC anywhere — that's the point (illiquid loans
 * get calendar rows despite having no oracle).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CRON_LOG_INDEX,
  calendarWindowSql,
  defaultGraceSeconds,
  effectiveGraceSeconds,
  graceCaseSql,
  maxGraceSeconds,
  pauseCreditSql,
  pausedAtSql,
  planCalendarRows,
  sweepCalendarNotifications,
  _resetQuarantineTableProbe,
  type CalendarLoanRow,
  type GraceBucketJson,
} from '../src/calendarNotifications';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';
import { pausedSecondsAt, pauseLogToJson, type PauseLog } from '@vaipakam/lib/loanClock';

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

  it('fires grace_ended for BOTH parties once grace has closed, for one week only', () => {
    // 30d loan → 3d grace. 4 days past due: grace has ended.
    const ended = planCalendarRows(CHAIN, [maturingIn(5, -4 * DAY)], NOW, HEAD, null, NOW);
    expect(ended.map((r) => r.kind)).toEqual(['grace_ended', 'grace_ended']);
    expect(ended.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
    expect(ended[0].dedupKey).toContain(':grace_ended:5:');
    // Past grace end + 7d → quiet; the loan was already announced.
    const stale = planCalendarRows(CHAIN, [maturingIn(9, -11 * DAY)], NOW, HEAD, null, NOW);
    expect(stale).toHaveLength(0);
  });

  it('starts grace_ended STRICTLY after grace end — the contract`s own comparison', () => {
    // isLoanDefaultable is `block.timestamp > maturity + grace`, so at the
    // exact second grace ends the loan is not yet defaultable and nothing
    // may say it is.
    const atEdge = planCalendarRows(CHAIN, [maturingIn(10, -3 * DAY)], NOW, HEAD, null, NOW);
    expect(atEdge.filter((r) => r.kind === 'grace_ended')).toHaveLength(0);
    const justPast = planCalendarRows(CHAIN, [maturingIn(10, -3 * DAY - 1)], NOW, HEAD, null, NOW);
    expect(justPast.map((r) => r.kind)).toEqual(['grace_ended', 'grace_ended']);
  });

  it('judges grace_ended on the CHAIN clock, and withholds it without one (#2479 r1)', () => {
    // triggerDefault compares block.timestamp, not the indexer's wall clock.
    // A chain whose settled head lags wall time must not be told a loan is
    // past grace before the chain itself would agree.
    const loan = maturingIn(12, -3 * DAY - 60); // 60s past grace by WALL time
    const behind = planCalendarRows(CHAIN, [loan], NOW, HEAD, null, NOW - 120);
    expect(behind.filter((r) => r.kind === 'grace_ended')).toHaveLength(0);
    const unknown = planCalendarRows(CHAIN, [loan], NOW, HEAD, null, null);
    expect(unknown.filter((r) => r.kind === 'grace_ended')).toHaveLength(0);
    const caughtUp = planCalendarRows(CHAIN, [loan], NOW, HEAD, null, NOW);
    expect(caughtUp.map((r) => r.kind)).toEqual(['grace_ended', 'grace_ended']);
  });

  it('times grace_ended against the CONFIGURED schedule, not the default', () => {
    const buckets: GraceBucketJson[] = [{ maxDurationDays: '0', graceSeconds: String(10 * DAY) }];
    // 4 days past due: past the default 3d grace, but inside a 10d one.
    const inCustomGrace = planCalendarRows(CHAIN, [maturingIn(11, -4 * DAY)], NOW, HEAD, buckets, NOW);
    expect(inCustomGrace.map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
    const pastCustom = planCalendarRows(CHAIN, [maturingIn(11, -11 * DAY)], NOW, HEAD, buckets, NOW);
    expect(pastCustom.map((r) => r.kind)).toEqual(['grace_ended', 'grace_ended']);
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
function seedGraceConfig(h: SqliteD1, bucketsJson = '[]', pauseLogJson: string | null = '[]') {
  h.db
    .prepare(
      `INSERT INTO protocol_config
         (chain_id, bundle_json, grace_buckets_json, pause_intervals_json,
          source_block, updated_at)
       VALUES (?, '[]', ?, ?, 1, ?)`,
    )
    .run(CHAIN, bucketsJson, pauseLogJson, NOW);
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

  it('withholds a reminder for a loan this tick could not establish (#2211 r3)', async () => {
    // THE GHOST CASE. An orphaned row — one the chain has never heard of —
    // is still sitting at `status = 'active'`, so the window selects it and
    // would mint an unretractable "prepare to repay" for a loan that does
    // not exist. The reconciliation pass names those ids; the sweep leaves
    // them out.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 11, NOW + 6 * DAY - 30 * DAY, 30); // the ghost
    seedLoan(h, 12, NOW + 6 * DAY - 30 * DAY, 30); // a healthy neighbour
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set([11]));
    const rows = rowsInDb(h);
    // PER ROW, not per tick: the neighbour's reminder is not collateral
    // damage of the ghost's. Deferring the whole sweep would withhold every
    // loan on the chain because one row could not be read, indefinitely if
    // that row stays unreadable.
    expect(rows.map((r) => r.loan_id)).toEqual([12]);
  });

  it('withholds a QUARANTINED loan on a tick that never examined it (#2212)', async () => {
    // THE CASE THE PER-PASS EXCLUSION COULD NOT COVER. The rotation looks at
    // one or three rows a turn, so on almost every tick the ghost is not in
    // the pass's report at all — the in-memory exclusion is empty for its id
    // and the unretractable reminder is minted. The table is what remembers.
    //
    // Note the sweep is called with NO exclusion set: this is purely the
    // stored mark doing the work.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 21, NOW + 6 * DAY - 30 * DAY, 30); // quarantined ghost
    seedLoan(h, 22, NOW + 6 * DAY - 30 * DAY, 30); // healthy neighbour
    h.db
      .prepare(
        `INSERT INTO loan_reconcile_quarantine (chain_id, loan_id, reason, first_seen_at, last_seen_at)
         VALUES (?, ?, 'orphan', ?, ?)`,
      )
      .run(CHAIN, 21, NOW - 100, NOW - 100);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    // Per row, still: the neighbour is not collateral damage.
    expect(rowsInDb(h).map((r) => r.loan_id)).toEqual([22]);
  });

  it('reminds again once the quarantine is released', async () => {
    // The release path seen from the surface that cares. A row held back on
    // one bad read must not be held back forever — the reminder is late, not
    // lost.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 23, NOW + 6 * DAY - 30 * DAY, 30);
    h.db
      .prepare(
        `INSERT INTO loan_reconcile_quarantine (chain_id, loan_id, reason, first_seen_at, last_seen_at)
         VALUES (?, ?, 'unread', ?, ?)`,
      )
      .run(CHAIN, 23, NOW - 100, NOW - 100);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h)).toHaveLength(0);
    h.db.prepare('DELETE FROM loan_reconcile_quarantine WHERE loan_id = ?').run(23);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h).map((r) => r.loan_id)).toEqual([23]);
  });

  it('still reminds when migration 0049 has NOT been applied yet (#2213 r1)', async () => {
    // THE DEPLOY WINDOW. `deploy-chain.sh` and `deploy-testnet.sh` push the
    // Worker BEFORE applying D1 migrations, so this build runs against a
    // database with no quarantine table — guaranteed, not hypothetical, and
    // open indefinitely if the migration then fails.
    //
    // Referencing the table unconditionally fails the window query, and the
    // sweep's fail-open catch turns that into EVERY reminder on EVERY chain
    // suppressed — a far larger outage than the one the quarantine prevents.
    // The right degradation is the prior behaviour: remind, and say so.
    _resetQuarantineTableProbe();
    const h = createSqliteD1(ALL_MIGRATIONS.filter((m) => !m.includes('loan_reconcile_quarantine')));
    seedGraceConfig(h);
    seedLoan(h, 31, NOW + 6 * DAY - 30 * DAY, 30);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h).map((r) => r.loan_id)).toEqual([31]);
    // NOT silently: this build is not doing what it believes it is doing.
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('migration 0049');
    warn.mockRestore();
    _resetQuarantineTableProbe();
  });

  it('DEFERS when it cannot tell whether the memory exists (#2213 r13)', async () => {
    // The third answer. "Could not ask" used to be reported as "not there",
    // which dropped the exclusion on a database where the table DOES exist —
    // minting unretractable reminders for precisely the loans being held
    // back, while telling an operator to apply a migration that was already
    // applied. One tick of silence is the cheaper error.
    _resetQuarantineTableProbe();
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 51, NOW + 6 * DAY - 30 * DAY, 30);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();
    // The probe's own query fails; every other query still works, which is
    // what a transient failure looks like.
    const realPrepare = h.d1.prepare.bind(h.d1);
    const d1 = {
      ...h.d1,
      prepare: (sql: string) =>
        sql.includes('sqlite_master')
          ? {
              bind: () => ({ first: async () => { throw new Error('D1_ERROR: probe'); } }),
              first: async () => {
                throw new Error('D1_ERROR: probe');
              },
            }
          : realPrepare(sql),
    };
    const out = await sweepCalendarNotifications(d1 as never, CHAIN, NOW, HEAD);
    // Nothing minted, and the loan is untouched rather than reminded about.
    expect(rowsInDb(h)).toEqual([]);
    expect(out.inserted).toBe(0);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('DEFERRED');
    // And NOT the misleading remedy.
    expect(said).not.toContain('migration 0049');
    warn.mockRestore();
    _resetQuarantineTableProbe();
  });

  it('starts withholding the moment the migration lands, with no redeploy (#2213 r1)', async () => {
    // The probe caches only a TRUE. Caching a false would be the quieter
    // half of the same bug: the table appears, and this isolate goes on
    // reminding about unsettled loans until it happens to recycle — which on
    // a Worker can be hours, and nothing would say so.
    //
    // Deliberately no reset between the halves: this is ONE isolate seeing
    // the schema change underneath it, which is exactly the deploy sequence.
    _resetQuarantineTableProbe();
    const h = createSqliteD1(ALL_MIGRATIONS.filter((m) => !m.includes('loan_reconcile_quarantine')));
    seedGraceConfig(h);
    seedLoan(h, 41, NOW + 6 * DAY - 30 * DAY, 30);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h).map((r) => r.loan_id)).toEqual([41]);

    // The migration lands, and the loan is quarantined.
    const migration = ALL_MIGRATIONS.find((m) => m.includes('loan_reconcile_quarantine'));
    for (const stmt of (migration ?? '').split(';')) {
      // SKIP COMMENT-ONLY CHUNKS. Splitting on `;` leaves whatever follows the
      // last statement as a chunk of its own, so a migration that ENDS in a
      // comment hands this loop a non-empty string with no SQL in it — which
      // `prepare` accepts and then fails on, with an error naming the
      // statement rather than the parse (#2213 r24). Stripping line comments
      // before the emptiness test makes the splitter judge SQL rather than
      // characters.
      const sql = stmt
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n');
      if (sql.trim()) h.db.prepare(sql).run();
    }
    h.db
      .prepare(
        `INSERT INTO loan_reconcile_quarantine (chain_id, loan_id, reason, first_seen_at, last_seen_at)
         VALUES (?, ?, 'orphan', ?, ?)`,
      )
      .run(CHAIN, 42, NOW - 100, NOW - 100);
    seedLoan(h, 42, NOW + 6 * DAY - 30 * DAY, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    // 41 already had its reminder; 42 is withheld — so no NEW row for 42.
    expect(rowsInDb(h).map((r) => r.loan_id)).toEqual([41]);
    warn.mockRestore();
    _resetQuarantineTableProbe();
  });

  it('sweeps normally when nothing is withheld, including an empty exclusion', async () => {
    // The default path must be untouched — this parameter is optional and
    // most callers pass nothing.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 13, NOW + 6 * DAY - 30 * DAY, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set());
    expect(rowsInDb(h).map((r) => r.loan_id)).toEqual([13]);
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
    // 2000 loans (the full SWEEP_LIMIT) that are 11–27 days overdue on the
    // default 3d grace — past their OWN grace end AND the grace_ended week
    // after it, so they emit nothing (but still sit inside the max-grace
    // look-back, which is what makes them a starvation risk).
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
      const overdue = (11 + (i % 17)) * DAY; // 11..27 days overdue
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
           (chain_id, bundle_json, grace_buckets_json, pause_intervals_json,
            source_block, updated_at)
         VALUES (?, '[]', ?, '[]', 1, ?)`,
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
        `INSERT INTO protocol_config (chain_id, bundle_json, source_block, updated_at)
         VALUES (?, '[]', 1, ?)`,
      )
      .run(CHAIN, NOW);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h)).toHaveLength(0);
    // '[]' = the DEFINITIVE no-buckets state → default schedule applies.
    // (#2808: the pause log must be known too — '[]' = never paused.)
    h.db
      .prepare(
        `UPDATE protocol_config SET grace_buckets_json = '[]', pause_intervals_json = '[]' WHERE chain_id = ?`,
      )
      .run(CHAIN);
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

  it('never suppresses a DIFFERENT loan sharing recipient + maturity (Codex #1298 r6 qualification bug)', async () => {
    // Pre-r6 the probe's unqualified chain_id/loan_id resolved to
    // notifications' OWN columns, so any stored row whose
    // recipient/kind/maturity matched suppressed EVERY such loan.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 1, NOW - 1 * DAY - 30 * DAY, 30); // in grace
    seedLoan(h, 2, NOW - 1 * DAY - 30 * DAY, 30); // same parties, SAME maturity
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    const byLoan = (id: number) => rowsInDb(h).filter((r) => r.loan_id === id);
    expect(byLoan(1).map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
    expect(byLoan(2).map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
  });

  it('re-selects a grace-stage loan for a NEW lender-position holder (Codex #1298 r6)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 11, NOW - 1 * DAY - 30 * DAY, 30); // in grace
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD);
    expect(rowsInDb(h)).toHaveLength(2); // both parties
    // The lender position sells mid-grace — the claim follows the NFT,
    // so the NEW holder must still learn a default may be near.
    const NEW_LENDER = '0x00000000000000000000000000000000000000cc';
    h.db
      .prepare(`UPDATE loans SET lender_current_owner = ? WHERE loan_id = 11`)
      .run(NEW_LENDER);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 60, HEAD + 5);
    const rows = rowsInDb(h);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.recipient === NEW_LENDER).map((r) => r.kind)).toEqual([
      'grace_entered',
    ]);
    // And once the new holder's key exists, the loan suppresses again.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 120, HEAD + 10);
    expect(rowsInDb(h)).toHaveLength(3);
  });

  it('emits grace_ended to both parties once grace has closed, then goes quiet (#2463 follow-up)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 21, NOW - 1 * DAY - 30 * DAY, 30); // 1d past due, 3d grace
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(rowsInDb(h).map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
    // Three days later grace has closed. The loan ALREADY carries both
    // parties' grace_entered rows, so a lender probe keyed on a fixed
    // 'grace_entered' would read as satisfied and drop it from the window.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 3 * DAY, HEAD + 5, new Set(), NOW + 3 * DAY);
    const ended = rowsInDb(h).filter((r) => r.kind === 'grace_ended');
    expect(ended.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
    // Re-tick: one-shot.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 3 * DAY + 60, HEAD + 10, new Set(), NOW + 3 * DAY + 60);
    expect(rowsInDb(h)).toHaveLength(4);
  });

  it('never lets an announced past-grace loan occupy the LIMIT (grace_ended suppression)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
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
    // SWEEP_LIMIT loans 4–5 days overdue on a 3d grace: all in their
    // grace_ended week, all earlier-maturing than the straggler.
    for (let i = 1; i <= 2000; i++) {
      const overdue = 4 * DAY + (i % 1000);
      stmt.run(CHAIN, i, LENDER, BORROWER, LENDER, BORROWER, NOW - overdue - 30 * DAY);
    }
    seedLoan(h, 3000, NOW - 12 * 3_600 - 30 * DAY, 30); // in grace, latest maturity
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(rowsInDb(h).filter((r) => r.loan_id === 3000)).toHaveLength(0); // tick 1: starved
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 60, HEAD + 5, new Set(), NOW + 60);
    const straggler = rowsInDb(h).filter((r) => r.loan_id === 3000);
    expect(straggler.map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']); // tick 2: served
  });

  it('keeps a lagging chain`s loan selectable until its CHAIN-clock grace_ended week opens (#2479 r2)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    // 30d loan, 3d grace. By WALL time it is an hour past its grace_ended
    // week; by the chain's settled head, two hours behind, it is inside it.
    seedLoan(h, 31, NOW - 30 * DAY - 3 * DAY - 7 * DAY - 3_600, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW - 7_200);
    expect(rowsInDb(h).map((r) => r.kind)).toEqual(['grace_ended', 'grace_ended']);
  });

  it('decides the SQL stage on the chain clock, then emits once the chain agrees (#2479 r2)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    seedLoan(h, 32, NOW - 30 * DAY - 2 * DAY, 30); // in grace
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(rowsInDb(h).map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
    // Wall time is now past grace; the chain is not. Nothing new.
    const later = NOW + DAY + 60;
    await sweepCalendarNotifications(h.d1 as never, CHAIN, later, HEAD + 5, new Set(), later - 120);
    expect(rowsInDb(h)).toHaveLength(2);
    // The chain catches up.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, later + 60, HEAD + 10, new Set(), later + 60);
    expect(rowsInDb(h).filter((r) => r.kind === 'grace_ended')).toHaveLength(2);
  });

  it('writes a saturated window in a handful of D1 queries, not one per row (#2479 r2)', async () => {
    // D1 counts each statement in a batch against its per-invocation query
    // ceiling (50 on the free tier). 2,000 two-sided grace_ended loans plan
    // 4,000 rows; a statement per row would be refused wholesale.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h);
    for (let i = 1; i <= 2000; i++) seedLoan(h, i, NOW - 4 * DAY - (i % 1000) - 30 * DAY, 30);
    const d1 = h.d1 as { batch: (s: unknown[]) => Promise<unknown> };
    const realBatch = d1.batch.bind(d1);
    const batchSizes: number[] = [];
    d1.batch = async (stmts: unknown[]) => {
      batchSizes.push(stmts.length);
      return realBatch(stmts);
    };
    const out = await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(out.inserted).toBe(4000);
    expect(rowsInDb(h).filter((r) => r.kind === 'grace_ended')).toHaveLength(4000);
    expect(batchSizes).toEqual([8]); // one subrequest, eight queries
  });

  it('range-scans idx_loans_calendar_maturity; dedup probes stay indexed lookups (Codex #1298 r4/r6)', () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // EXPLAIN QUERY PLAN over the EXACT production SQL (default and
    // governance-bucket grace CASEs): migration 0040's partial
    // expression index must serve both the window filter and the
    // ORDER BY, or the every-tick sweep scales with the chain's whole
    // active loan set instead of the due/grace window. The correlated
    // suppression probes must SEARCH the unique dedup index — an
    // unqualified outer column makes their RHS vary per `n` row and
    // degrades them to full history scans (r6).
    for (const graceCase of [
      graceCaseSql(null),
      graceCaseSql([
        { maxDurationDays: '30', graceSeconds: String(2 * DAY) },
        { maxDurationDays: '0', graceSeconds: String(45 * DAY) },
      ]),
    ]) {
      const plan = h.db
        .prepare(`EXPLAIN QUERY PLAN ${calendarWindowSql(graceCase)}`)
        .all(CHAIN, NOW - 52 * DAY, NOW + 7 * DAY, ...Array<number>(9).fill(NOW))
        .map((r) => String((r as { detail: string }).detail))
        .join(' | ');
      expect(plan).toContain('idx_loans_calendar_maturity');
      expect(plan).not.toContain('TEMP B-TREE');
      expect(plan).toContain('idx_notifications_dedup');
      expect(plan).not.toMatch(/SCAN n2?(\s|$|\|)/);
    }
  });
});

/**
 * #2808 — the calendar runs on the D2 loan clock: every due date it keys on
 * is the original one moved by the loan's pause credit (#668 / #935), in the
 * SQL window and in the planner alike.
 */
describe('the loan clock (#2808)', () => {
  const START = NOW - 31 * DAY; // 30-day loan, originally due a day ago
  /** One 3-day pause during the loan, long over. */
  const CLOSED: PauseLog = [
    { start: BigInt(START + 5 * DAY), end: BigInt(START + 8 * DAY), pausedBefore: 0n },
  ];
  const json = (log: PauseLog) => JSON.stringify(pauseLogToJson(log));
  const keys = (h: SqliteD1) =>
    (h.db.prepare('SELECT kind, dedup_key FROM notifications ORDER BY id').all() as {
      kind: string;
      dedup_key: string;
    }[]);

  it('pausedAtSql is the contract walk, value for value', () => {
    const log: PauseLog = [
      { start: 100n, end: 200n, pausedBefore: 0n },
      { start: 500n, end: 530n, pausedBefore: 100n },
    ];
    const h = createSqliteD1(ALL_MIGRATIONS);
    for (const x of [0, 99, 100, 150, 200, 300, 500, 515, 530, 10_000]) {
      const got = (h.db.prepare(`SELECT ${pausedAtSql(log, 'x')} AS p FROM (SELECT ? AS x)`).get(x) as {
        p: number;
      }).p;
      expect(got, String(x)).toBe(Number(pausedSecondsAt(log, BigInt(x))));
    }
    expect(pausedAtSql([], 'x')).toBe('0');
    expect(pauseCreditSql([])).toBeNull();
    expect(() => pausedAtSql([{ start: 1n, end: 2n ** 64n - 1n, pausedBefore: 0n }], 'x')).toThrow();
  });

  it('plans on the moved due date and keys the row on it', () => {
    const loan: CalendarLoanRow = {
      loan_id: 1,
      lender: LENDER,
      borrower: BORROWER,
      lender_current_owner: null,
      borrower_current_owner: null,
      start_time: START,
      duration_days: 30,
    };
    // Original clock: a day past due → grace_entered. Loan clock: due in two
    // days → the T-7d reminder only.
    const rows = planCalendarRows(CHAIN, [loan], NOW, 1, null, NOW, CLOSED);
    const effective = START + 30 * DAY + 3 * DAY;
    expect(rows.map((r) => r.kind)).toEqual(['maturity_7d']);
    expect(rows[0].dedupKey).toBe(`${CHAIN}:${BORROWER}:maturity_7d:1:${effective}`);
  });

  it('credits only the pauses after the loan started', () => {
    const before: PauseLog = [
      { start: BigInt(START - 10 * DAY), end: BigInt(START - 7 * DAY), pausedBefore: 0n },
    ];
    const rows = planCalendarRows(
      CHAIN,
      [{ loan_id: 1, lender: LENDER, borrower: BORROWER, lender_current_owner: null, borrower_current_owner: null, start_time: START, duration_days: 30 }],
      NOW,
      1,
      null,
      NOW,
      before,
    );
    expect(rows.map((r) => r.kind)).toEqual(['grace_entered', 'grace_entered']);
  });

  it('sweeps on the moved due date, end to end over the migrated schema', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h, '[]', json(CLOSED));
    seedLoan(h, 1, START, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    const effective = START + 33 * DAY;
    expect(keys(h)).toEqual([
      { kind: 'maturity_7d', dedup_key: `${CHAIN}:${BORROWER}:maturity_7d:1:${effective}` },
    ]);
    // A second tick adds nothing: the suppression probe finds the key the
    // planner wrote, because both use the moved date.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW + 60, HEAD + 5, new Set(), NOW + 60);
    expect(keys(h)).toHaveLength(1);
  });

  it('keeps a loan in its grace window that the original clock would call closed', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // 30-day loan, originally due 5 days ago with 3 days' grace → grace has
    // closed on the original clock; a 3-day credit puts it 2 days into grace.
    const start = NOW - 35 * DAY;
    seedGraceConfig(
      h,
      '[]',
      json([{ start: BigInt(start + DAY), end: BigInt(start + 4 * DAY), pausedBefore: 0n }]),
    );
    seedLoan(h, 2, start, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(keys(h).map((k) => k.kind)).toEqual(['grace_entered', 'grace_entered']);
  });

  it('leaves out a loan the credit pushes past the reminder window', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    // Originally due in 6 days (inside T-7d); a 3-day credit makes it 9.
    const start = NOW - 24 * DAY;
    seedGraceConfig(
      h,
      '[]',
      json([{ start: BigInt(start + DAY), end: BigInt(start + 4 * DAY), pausedBefore: 0n }]),
    );
    seedLoan(h, 3, start, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(keys(h)).toEqual([]);
  });

  it('defers while the pause log is unknown or unreadable', async () => {
    for (const pl of [null, 'not json', '[{"start":"5"}]']) {
      const h = createSqliteD1(ALL_MIGRATIONS);
      seedGraceConfig(h, '[]', pl);
      seedLoan(h, 9, NOW - 1 * DAY - 30 * DAY, 30); // would emit grace_entered
      await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
      expect(keys(h), String(pl)).toEqual([]);
    }
  });

  it('keys nothing while a pause is in force, and resumes once it has ended on both clocks', async () => {
    const open: PauseLog = [{ start: BigInt(NOW - DAY), end: 2n ** 64n - 1n, pausedBefore: 0n }];
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedGraceConfig(h, '[]', json(open));
    seedLoan(h, 9, NOW - 1 * DAY - 30 * DAY, 30);
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(keys(h)).toEqual([]);
    // Closed on the wall clock but not yet on the chain's: still waits.
    const justEnded: PauseLog = [{ start: BigInt(NOW - DAY), end: BigInt(NOW - 10), pausedBefore: 0n }];
    h.db.prepare(`UPDATE protocol_config SET pause_intervals_json = ?`).run(json(justEnded));
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW - 20);
    expect(keys(h)).toEqual([]);
    // Ended on both: the loan is credited the day and keyed once.
    await sweepCalendarNotifications(h.d1 as never, CHAIN, NOW, HEAD, new Set(), NOW);
    expect(keys(h).map((k) => k.kind)).toEqual(['grace_entered', 'grace_entered']);
    expect(keys(h)[0].dedup_key.endsWith(`:9:${NOW - DAY + (DAY - 10)}`)).toBe(true);
  });

  it('still range-scans the maturity index with a pause credit in the query', () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const plan = h.db
      .prepare(`EXPLAIN QUERY PLAN ${calendarWindowSql(graceCaseSql(null), true, pauseCreditSql(CLOSED))}`)
      .all(CHAIN, NOW - 52 * DAY, NOW + 7 * DAY, ...Array<number>(9).fill(NOW))
      .map((r) => String((r as { detail: string }).detail))
      .join(' | ');
    expect(plan).toContain('idx_loans_calendar_maturity');
    expect(plan).not.toContain('TEMP B-TREE');
    expect(plan).toContain('idx_notifications_dedup');
  });
});
