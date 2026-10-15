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
  planOwnerNotifications,
  materializeNotifications,
  EVENT_NOTIF_MAP,
  EVENT_OWNER_NOTIF_MAP,
  type NotifSourceLog,
} from '../src/notifications';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';
import { notifiedFloor, planNotifiedWatermark, replayNotificationsFromArchive, reviveArchiveArgs } from '../src/notifications';

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
  // Default to a TERMINAL projected status so the terminal-kind gate
  // (Codex #1292 r7) passes for the repaid/defaulted/internal-match cases;
  // loan_matched cases ignore status. `isSaleVehicle` defaults off.
  status: string | null = 'repaid',
  isSaleVehicle = false,
) => ({
  lender,
  borrower,
  lenderCurrentOwner: lenderCur,
  borrowerCurrentOwner: borrowerCur,
  status,
  isSaleVehicle,
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

  it('reads the alt loan-id arg for offset / refinance close-outs (Codex #1292 r6)', () => {
    // OffsetCompleted(originalLoanId, …) and LoanRefinanced(oldLoanId, …)
    // name the closed loan differently than `loanId`.
    const offset = planNotifications(
      84532,
      [{ eventName: 'OffsetCompleted', args: { originalLoanId: 7n }, blockNumber: 1n, logIndex: 0 }],
      new Map([[7, parties(LENDER, BORROWER)]]),
      new Map(),
      1,
    );
    expect(offset.map((r) => r.loanId)).toEqual([7, 7]);
    expect(offset.every((r) => r.kind === 'loan_repaid')).toBe(true);

    const refi = planNotifications(
      84532,
      [{ eventName: 'LoanRefinanced', args: { oldLoanId: 9n, newLoanId: 10n }, blockNumber: 1n, logIndex: 0 }],
      new Map([[9, parties(LENDER, BORROWER)]]),
      new Map(),
      1,
    );
    // The OLD (closed) loan gets the row; the new loan gets its own
    // LoanInitiated → loan_matched.
    expect(refi.map((r) => r.loanId)).toEqual([9, 9]);
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

  it('suppresses a PARTIAL internal-match leg (loan still active) but keeps a closed leg (Codex #1292 r7)', () => {
    // Loan 4 fully closed (status 'internal_matched'); loan 5 only
    // partial-matched (still 'active', principal reduced). Only the closed
    // leg gets a "closed — check the Claim Center" row.
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
        [4, parties(LENDER, BORROWER, LENDER, BORROWER, 'internal_matched')],
        [5, parties(BUYER, BORROWER, BUYER, BORROWER, 'active')],
      ]),
      new Map(),
      1,
    );
    expect(rows.map((r) => r.loanId).sort()).toEqual([4, 4]); // only leg 4
    expect(rows.every((r) => r.kind === 'internal_matched')).toBe(true);
  });

  it('defers an HF-liquidation terminal row while the loan is still active in D1 (Codex #1292 r7 / #1293)', () => {
    // The indexer does not yet project HFLiquidationTriggered /
    // LiquidationDiscounted to 'defaulted' (issue #1293), so the loan stays
    // 'active'; the terminal-status gate suppresses the loan_defaulted row
    // until that projection lands (it then auto-activates).
    for (const ev of ['HFLiquidationTriggered', 'LiquidationDiscounted']) {
      const rows = planNotifications(
        84532,
        [log(ev, 7)],
        new Map([[7, parties(LENDER, BORROWER, LENDER, BORROWER, 'active')]]),
        new Map(),
        1,
      );
      expect(rows).toHaveLength(0);
    }
    // Once the indexer projects the loan to 'defaulted', the SAME event maps
    // through to both holders.
    const flowed = planNotifications(
      84532,
      [log('HFLiquidationTriggered', 7)],
      new Map([[7, parties(LENDER, BORROWER, LENDER, BORROWER, 'defaulted')]]),
      new Map(),
      1,
    );
    expect(flowed.map((r) => r.recipient).sort()).toEqual([LENDER, BORROWER].sort());
    expect(flowed.every((r) => r.kind === 'loan_defaulted')).toBe(true);
  });

  it('skips a loan_matched row for a lender-sale VEHICLE bookkeeping loan (Codex #1292 r7)', () => {
    const rows = planNotifications(
      84532,
      [log('LoanInitiated', 7)],
      new Map([
        [7, parties(LENDER, BORROWER, LENDER, BORROWER, 'active', /* isSaleVehicle */ true)],
      ]),
      new Map(),
      1,
    );
    expect(rows).toHaveLength(0);
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
  status = 'repaid',
  isSaleVehicle = 0,
) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at, is_sale_vehicle)
       VALUES (84532, ?, 1, ?, ?, ?, '100', '200', 0, 0, '0xlend', '0xcoll',
         30, '0', '0', '1', '2', ?, ?, 500, 0, 0, 0, 0, ?)`,
    )
    .run(loanId, status, lender, borrower, lenderCur, borrowerCur, isSaleVehicle);
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

  it('skips a sale-vehicle bookkeeping loan over the real schema (reads is_sale_vehicle) (Codex #1292 r7)', async () => {
    const h = setup();
    // A normal matched loan → 2 rows; a sale-vehicle temp loan → 0 rows.
    seedLoan(h, 7, LENDER, BORROWER, LENDER, BORROWER, 'active', 0);
    seedLoan(h, 8, LENDER, BORROWER, LENDER, BORROWER, 'active', 1);
    await materializeNotifications(
      h.d1 as never,
      84532,
      [log('LoanInitiated', 7), log('LoanInitiated', 8)],
      new Map(),
      999,
    );
    const rows = h.db
      .prepare('SELECT loan_id FROM notifications ORDER BY loan_id')
      .all() as Array<{ loan_id: number }>;
    expect(rows.map((r) => r.loan_id)).toEqual([7, 7]); // loan 8 suppressed
  });

  it('defers an HF terminal over the real schema while the loan is active (Codex #1292 r7)', async () => {
    const h = setup();
    seedLoan(h, 7, LENDER, BORROWER, LENDER, BORROWER, 'active', 0);
    await materializeNotifications(
      h.d1 as never,
      84532,
      [log('HFLiquidationTriggered', 7)],
      new Map(),
      999,
    );
    expect(countRows(h)).toBe(0);
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

// ─── RL-3 (#1956) — the free pre-expiry notice, addressed to the entry owner ───

const OWNER = '0x00000000000000000000000000000000000000Dd';
const rewardLog = (
  eventName: string,
  entryId: bigint,
  user: string = OWNER,
  blockNumber = 200n,
  logIndex = 0,
  extra: Record<string, unknown> = {},
): NotifSourceLog => ({ eventName, args: { entryId, user, ...extra }, blockNumber, logIndex });

describe('planOwnerNotifications (RL-3)', () => {
  it('maps the last-call and the removal point to the OWNER the event names, with the entry in data', () => {
    const rows = planOwnerNotifications(
      84532,
      [
        rewardLog('RewardEntryExpiryArmed', 9n, OWNER, 200n, 0, { finalNoticeFrom: 1_800_000_000n }),
        rewardLog('RewardEntryExpiryBegun', 9n, OWNER, 201n, 3),
        rewardLog('RewardEntryHorizonStamped', 9n), // the schedule signal: no inbox row
      ],
      new Map([[200n, 1_700_000_000]]),
      42,
    );
    expect(rows.map((r) => r.kind)).toEqual(['reward_final_notice', 'reward_expired']);
    expect(rows.every((r) => r.recipient === OWNER.toLowerCase() && r.loanId === null)).toBe(true);
    expect(JSON.parse(rows[0].dataJson!)).toEqual({ entryId: '9', finalNoticeFrom: 1_800_000_000 });
    expect(JSON.parse(rows[1].dataJson!)).toEqual({ entryId: '9' });
    expect(rows[0].createdAt, 'block time when known').toBe(1_700_000_000);
    expect(rows[1].createdAt, 'now otherwise').toBe(42);
  });

  it('a re-armed entry (horizon reconfiguration) notifies AGAIN — the key carries the event, not just the entry', () => {
    const rows = planOwnerNotifications(
      84532,
      [rewardLog('RewardEntryExpiryArmed', 9n, OWNER, 200n, 0), rewardLog('RewardEntryExpiryArmed', 9n, OWNER, 900n, 1)],
      new Map(),
      0,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupKey)).size).toBe(2);
  });

  it('writes nothing for a missing or zero owner, or a malformed entry id', () => {
    expect(
      planOwnerNotifications(
        84532,
        [
          rewardLog('RewardEntryExpiryArmed', 9n, ZERO),
          { eventName: 'RewardEntryExpiryArmed', args: { entryId: 9n }, blockNumber: 1n, logIndex: 0 },
          { eventName: 'RewardEntryExpiryArmed', args: { entryId: 'x', user: OWNER }, blockNumber: 1n, logIndex: 0 },
        ],
        new Map(),
        0,
      ),
    ).toEqual([]);
  });

  it('owner and loan maps never overlap (a reward event is not a loan event)', () => {
    for (const k of Object.keys(EVENT_OWNER_NOTIF_MAP)) expect(k in EVENT_NOTIF_MAP).toBe(false);
  });
});

describe('materializeNotifications — RL-3 owner rows (over the migrated schema)', () => {
  it('writes the owner row with its data, idempotently, with no loan anywhere in the scan', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const logs = [rewardLog('RewardEntryExpiryArmed', 9n, OWNER, 200n, 0, { finalNoticeFrom: 1_800_000_000n })];
    await materializeNotifications(h.d1 as never, 84532, logs, new Map(), 999);
    await materializeNotifications(h.d1 as never, 84532, logs, new Map(), 999);
    const rows = h.db
      .prepare('SELECT recipient, kind, loan_id, data_json FROM notifications')
      .all() as Array<{ recipient: string; kind: string; loan_id: number | null; data_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient: OWNER.toLowerCase(), kind: 'reward_final_notice', loan_id: null });
    expect(JSON.parse(rows[0].data_json)).toEqual({ entryId: '9', finalNoticeFrom: 1_800_000_000 });
  });

  it('a failed loan-party lookup in the same scan does not cost the owner their notice', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    h.db.exec('DROP TABLE loans'); // the party lookup now throws → null → loan rows skipped
    await materializeNotifications(
      h.d1 as never,
      84532,
      [log('LoanInitiated', 7), rewardLog('RewardEntryExpiryBegun', 9n)],
      new Map(),
      999,
    );
    const kinds = (h.db.prepare('SELECT kind FROM notifications').all() as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toEqual(['reward_expired']);
  });
});


// ─── #2489 r3 — the `notified` watermark means what it says ─────────────────

describe('a failed notification insert is never silent (Codex #2489 r3)', () => {
  it('materializeNotifications lets the insert failure propagate, so the watermark cannot advance over it', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    h.db.exec('DROP TABLE notifications');
    await expect(
      materializeNotifications(h.d1 as never, 84532, [rewardLog('RewardEntryExpiryArmed', 9n)], new Map(), 999),
    ).rejects.toThrow();
  });
});

describe('replayNotificationsFromArchive — the rows re-derived from activity_events', () => {
  const seedEvent = (h: SqliteD1, block: number, logIndex: number, kind: string, args: Record<string, unknown>) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, args_json, block_at)
         VALUES (84532, ?, ?, ?, ?, ?, ?)`,
      )
      .run(block, logIndex, `0x${block.toString(16).padStart(64, '0')}`, kind, JSON.stringify(args), 1_000 + block);
  const kinds = (h: SqliteD1) =>
    (h.db.prepare('SELECT kind, block_number FROM notifications ORDER BY block_number, recipient').all() as Array<{
      kind: string;
      block_number: number;
    }>).map((r) => `${r.kind}@${r.block_number}`);

  it('revives the archive ids (decimal strings) to bigints — or every loan row would be dropped while reporting success', () => {
    const args = reviveArchiveArgs('{"loanId":"7","user":"0x00000000000000000000000000000000000000Dd","ok":true,"n":3,"s":"abc"}');
    expect(args).toEqual({ loanId: 7n, user: '0x00000000000000000000000000000000000000Dd', ok: true, n: 3, s: 'abc' });
  });

  it('re-derives owner AND loan rows in the window, idempotently; a row outside the window waits for its own replay', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 7, LENDER, BORROWER);
    // The archive as the indexer writes it: bigints as decimal strings.
    seedEvent(h, 150, 0, 'LoanInitiated', { loanId: '7' });
    seedEvent(h, 200, 0, 'RewardEntryExpiryArmed', { entryId: '9', user: OWNER, finalNoticeFrom: '1800000000' });
    seedEvent(h, 300, 0, 'LoanInitiated', { loanId: '7' }); // past the window
    seedEvent(h, 210, 0, 'OfferCreated', { offerId: '1' }); // not notification-worthy
    expect(await replayNotificationsFromArchive(h.d1 as never, 84532, 100n, 250n, 999)).toBe(3);
    expect(kinds(h)).toEqual(['loan_matched@150', 'loan_matched@150', 'reward_final_notice@200']);
    const data = (h.db.prepare("SELECT data_json FROM notifications WHERE kind = 'reward_final_notice'").get() as { data_json: string }).data_json;
    expect(JSON.parse(data)).toEqual({ entryId: '9', finalNoticeFrom: 1_800_000_000 });
    expect(await replayNotificationsFromArchive(h.d1 as never, 84532, 100n, 250n, 999), 'idempotent').toBe(0);
    expect(await replayNotificationsFromArchive(h.d1 as never, 84532, 250n, 300n, 999), 'the next window').toBe(2);
    expect(await replayNotificationsFromArchive(h.d1 as never, 1, 0n, 999n, 999), 'another chain').toBe(0);
  });

  it('throws when its own insert fails, so the caller leaves the watermark where it was', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedEvent(h, 200, 0, 'RewardEntryExpiryArmed', { entryId: '9', user: OWNER });
    h.db.exec('DROP TABLE notifications');
    await expect(replayNotificationsFromArchive(h.d1 as never, 84532, 100n, 250n, 999)).rejects.toThrow();
  });
});

describe('notifiedFloor — where a failed insert pins the watermark (one rule for head and catch-up passes)', () => {
  it('a failed insert pins a never-stamped chain just below its scan; a stamped one only when the scan is below the stamp', () => {
    expect(notifiedFloor(null, 400n, false)).toBe(399n);
    expect(notifiedFloor(1000n, 900n, false), 're-scan below the watermark').toBe(899n);
    expect(notifiedFloor(300n, 400n, false), 'the watermark already sits below the scan').toBeNull();
    expect(notifiedFloor(399n, 400n, false), 'exactly at the floor: nothing to write').toBeNull();
  });
  it('proves nothing on a successful or quiet tick', () => {
    expect(notifiedFloor(null, 400n, true)).toBeNull();
    expect(notifiedFloor(null, null, false)).toBeNull();
    expect(notifiedFloor(1000n, 900n, true)).toBeNull();
  });
});

describe('the scan tail remembers a failed insert on a catch-up pass short of the head (Codex #2489 r6)', () => {
  // Source-shape pin, as the healer tests pin their order: there is no tick
  // harness, and this wiring is exactly what the finding showed missing.
  const src = readFileSync(new URL('../src/chainIndexer.ts', import.meta.url), 'utf8');
  it('stamps at the head, and otherwise holds the watermark below a failed scan', () => {
    const gate = src.indexOf('if (scanTo === head) {\n    await stampNotifiedWatermark(env, chainId, scanTo, scanFrom, notifiedOk);');
    expect(gate).toBeGreaterThan(-1);
    const tail = src.slice(gate, gate + 400);
    expect(tail).toContain('} else if (!notifiedOk) {\n    await holdNotifiedWatermark(env, chainId, scanFrom);');
  });
  it('the hold and the head stamp share one floor rule, and a failed replay writes the hold', () => {
    const hold = src.slice(src.indexOf('async function holdNotifiedWatermark('), src.indexOf('\n}\n', src.indexOf('async function holdNotifiedWatermark(')));
    expect(hold).toContain('notifiedFloor(await readNotifiedWatermark(env, chainId), scanFrom, false)');
    const stamp = src.slice(src.indexOf('async function stampNotifiedWatermark('), src.indexOf('async function holdNotifiedWatermark('));
    expect(stamp).toContain('if (plan.holdAt !== undefined) await _writeNotifiedWatermark(env, chainId, plan.holdAt);');
  });
});

describe('planNotifiedWatermark — what one tick replays and where it stamps (straddles)', () => {
  it('a never-stamped chain stamps without replaying history — unless its OWN first scan failed (Codex #2489 r4)', () => {
    expect(planNotifiedWatermark(null, 500n, 400n, true)).toEqual({ stampTo: 500n });
    expect(planNotifiedWatermark(null, 500n, null, false), 'quiet tick, nothing to write').toEqual({ stampTo: 500n });
    // The first scan's insert failed: the watermark is held just below the
    // scan and the scan is replayed from the archive from there; if that
    // replay fails too, `holdAt` is written — so the next tick replays
    // exactly the failed scan, nothing older, nothing skipped (r6: the
    // previous shape stamped 399 and deferred; a lost hold left no record).
    expect(planNotifiedWatermark(null, 500n, 400n, false)).toEqual({
      replayAfter: 399n,
      replayThrough: 500n,
      stampTo: 500n,
      holdAt: 399n,
    });
    expect(planNotifiedWatermark(399n, 600n, 501n, true), 'the next tick replays the failed scan').toEqual({
      replayAfter: 399n,
      replayThrough: 500n,
      stampTo: 600n,
    });
  });

  it('a failed re-scan BELOW the stored watermark lowers it to the scan (Codex #2489 r6)', () => {
    // Mutation: replay from the stored watermark → blocks 900..1000 of the
    // failed scan are never replayed, and the stamp certifies them.
    expect(planNotifiedWatermark(1000n, 1100n, 900n, false)).toEqual({
      replayAfter: 899n,
      replayThrough: 1100n,
      stampTo: 1100n,
      holdAt: 899n,
    });
    // A failed scan above the watermark holds nothing extra: the gap replay
    // already starts below it.
    expect(planNotifiedWatermark(399n, 500n, 400n, false)).toEqual({ replayAfter: 399n, replayThrough: 500n, stampTo: 500n });
  });

  it('a healthy scanning tick (the watermark meets the fresh rows) stamps, no replay', () => {
    expect(planNotifiedWatermark(399n, 500n, 400n, true)).toEqual({ stampTo: 500n });
    expect(planNotifiedWatermark(398n, 500n, 400n, true), 'one block short: replay exactly it').toEqual({
      replayAfter: 398n,
      replayThrough: 399n,
      stampTo: 500n,
    });
  });

  it('a tick whose insert failed replays through its own end and stamps only after that', () => {
    expect(planNotifiedWatermark(399n, 500n, 400n, false)).toEqual({ replayAfter: 399n, replayThrough: 500n, stampTo: 500n });
  });

  it('a quiet tick with nothing missing just refreshes the stamp', () => {
    expect(planNotifiedWatermark(500n, 500n, null, false)).toEqual({ stampTo: 500n });
  });

  it('a long gap drains one window at a time, stamping only what was replayed', () => {
    expect(planNotifiedWatermark(0n, 50_000n, null, false, 20_000n)).toEqual({
      replayAfter: 0n,
      replayThrough: 20_000n,
      stampTo: 20_000n,
    });
    expect(planNotifiedWatermark(0n, 20_000n, null, false, 20_000n), 'the window reaches the end: stamp the end').toEqual({
      replayAfter: 0n,
      replayThrough: 20_000n,
      stampTo: 20_000n,
    });
    expect(planNotifiedWatermark(0n, 30_000n, 20_001n, true, 20_000n), 'gap ends where fresh rows begin').toEqual({
      replayAfter: 0n,
      replayThrough: 20_000n,
      stampTo: 30_000n,
    });
  });
});
