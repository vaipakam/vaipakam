/**
 * HF-band inbox rows (#1213 PR 2b) — band classification and the
 * downgrade-only crossing semantics, exercised over the REAL shared-DB
 * migration DDL (apps/indexer/migrations owns the schema; the keeper
 * only reads/writes it). The D1 shim's batch() surfaces no
 * meta.changes, so every assertion reads the tables.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CRON_LOG_INDEX,
  HF_ALERT_MILLI,
  HF_CRITICAL_MILLI,
  HF_WARN_MILLI,
  classifyBand,
  hfToMilli,
  recordHfBandNotifications,
} from '../src/hfBandNotifications';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../../indexer/migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const BORROWER = '0x00000000000000000000000000000000000000bb';
const NEW_BORROWER = '0x00000000000000000000000000000000000000cc';
const NOW = 1_800_000_000;
const HEAD = 4_242;

const E15 = 10n ** 15n;
/** milli-HF → the 1e18-scaled bigint the contract returns. */
const hf = (milli: number) => BigInt(milli) * E15;

function harness(watermarkAt = NOW): SqliteD1 {
  const h = createSqliteD1(ALL_MIGRATIONS);
  // The indexer's post-materialization `notified` watermark the pass
  // stamps rows from and gates staleness on (Codex #1300 r1 — NOT the
  // main `diamond` cursor, which advances before materialization).
  h.db
    .prepare(
      `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'notified', ?, ?)`,
    )
    .run(CHAIN, HEAD, watermarkAt);
  return h;
}

function seedLoan(h: SqliteD1, loanId: number, status = 'active', borrowerOwner: string | null = BORROWER) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at, is_stub, is_sale_vehicle)
       VALUES (?, ?, 1, ?, '0xaa', ?, '100', '200', 0, 0, '0xa', '0xc', 30, '0', '0',
         '1', '2', '0xaa', ?, 500, ?, 0, 0, 0, 0, 0)`,
    )
    .run(CHAIN, loanId, status, BORROWER, borrowerOwner, NOW - 86_400);
}

const notifRows = (h: SqliteD1) =>
  h.db
    .prepare(
      'SELECT recipient, kind, loan_id, block_number, log_index, event_kind, dedup_key FROM notifications ORDER BY id',
    )
    .all() as Array<{
    recipient: string;
    kind: string;
    loan_id: number;
    block_number: number;
    log_index: number;
    event_kind: string | null;
    dedup_key: string;
  }>;

const stateRows = (h: SqliteD1) =>
  h.db
    .prepare('SELECT loan_id, last_band, last_hf_milli FROM hf_band_state ORDER BY loan_id')
    .all() as Array<{ loan_id: number; last_band: string; last_hf_milli: number }>;

describe('classifyBand / hfToMilli', () => {
  it('maps the protocol thresholds with exclusive lower bounds', () => {
    expect(classifyBand(HF_WARN_MILLI)).toBe('healthy'); // 1.5 exactly = healthy
    expect(classifyBand(HF_WARN_MILLI - 1)).toBe('warn');
    expect(classifyBand(HF_ALERT_MILLI)).toBe('warn');
    expect(classifyBand(HF_ALERT_MILLI - 1)).toBe('alert');
    expect(classifyBand(HF_CRITICAL_MILLI)).toBe('alert');
    expect(classifyBand(HF_CRITICAL_MILLI - 1)).toBe('critical');
    expect(classifyBand(0)).toBe('critical');
  });

  it('clamps uint256.max (zero-borrow) and huge readings to healthy', () => {
    expect(classifyBand(hfToMilli(2n ** 256n - 1n))).toBe('healthy');
    expect(hfToMilli(hf(1_499))).toBe(1_499);
    expect(hfToMilli(hf(10_000_000))).toBe(1_000_000); // capped
  });
});

describe('recordHfBandNotifications (over the migrated shared schema)', () => {
  it('mints a borrower row on first observation inside a band, stamped at the cursor head', async () => {
    const h = harness();
    seedLoan(h, 1);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 1n, hf: hf(1_400) }], NOW);
    const rows = notifRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient: BORROWER,
      kind: 'hf_warn',
      loan_id: 1,
      block_number: HEAD,
      log_index: CRON_LOG_INDEX,
      event_kind: null,
    });
    expect(stateRows(h)).toEqual([{ loan_id: 1, last_band: 'warn', last_hf_milli: 1_400 }]);
  });

  it('healthy loans mint nothing and carry no state row', async () => {
    const h = harness();
    seedLoan(h, 2);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 2n, hf: hf(2_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0);
  });

  it('downgrades mint, same-band re-ticks are silent, recoveries delete state without a row', async () => {
    const h = harness();
    seedLoan(h, 3);
    // warn
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 3n, hf: hf(1_400) }], NOW);
    // same band next tick — nothing new
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 3n, hf: hf(1_350) }], NOW + 60);
    expect(notifRows(h)).toHaveLength(1);
    // deeper — alert row
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 3n, hf: hf(1_100) }], NOW + 120);
    expect(notifRows(h).map((r) => r.kind)).toEqual(['hf_warn', 'hf_alert']);
    // recovery — state gone, no "got safer" row
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 3n, hf: hf(1_800) }], NOW + 180);
    expect(notifRows(h)).toHaveLength(2);
    expect(stateRows(h)).toHaveLength(0);
  });

  it('a same-day flap re-crossing the same band is bounded by the day-bucket dedup; a new UTC day re-alerts', async () => {
    const h = harness();
    seedLoan(h, 4);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 4n, hf: hf(1_400) }], NOW);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 4n, hf: hf(1_600) }], NOW + 60);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 4n, hf: hf(1_400) }], NOW + 120);
    expect(notifRows(h)).toHaveLength(1); // same day bucket → INSERT OR IGNORE
    // next UTC day: recover + re-drop mints a fresh row (freshen the
    // watermark as the live indexer would keep doing — a day-old stamp
    // correctly defers under the staleness gate).
    const nextDay = NOW + 86_400;
    h.db
      .prepare(`UPDATE indexer_cursor SET updated_at = ? WHERE kind = 'notified'`)
      .run(nextDay);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 4n, hf: hf(1_600) }], nextDay);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 4n, hf: hf(1_400) }], nextDay + 60);
    expect(notifRows(h)).toHaveLength(2);
  });

  it('defers a crossing whose loan row has not been indexed yet (retries next tick)', async () => {
    const h = harness();
    // no loans row for id 5
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 5n, hf: hf(1_100) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0); // state NOT committed — retry
    seedLoan(h, 5);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 5n, hf: hf(1_100) }], NOW + 60);
    expect(notifRows(h).map((r) => r.kind)).toEqual(['hf_alert']);
  });

  it('resolves the CURRENT borrower-position holder and skips burned sides', async () => {
    const h = harness();
    seedLoan(h, 6, 'active', NEW_BORROWER); // migrated borrower position
    seedLoan(h, 7, 'active', '0x0000000000000000000000000000000000000000'); // burned
    await recordHfBandNotifications(
      h.d1 as never,
      CHAIN,
      [
        { id: 6n, hf: hf(1_000) },
        { id: 7n, hf: hf(1_000) },
      ],
      NOW,
    );
    const rows = notifRows(h);
    expect(rows.map((r) => [r.loan_id, r.recipient])).toEqual([[6, NEW_BORROWER]]);
  });

  it('prunes band state for loans that left the active set', async () => {
    const h = harness();
    seedLoan(h, 8);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 8n, hf: hf(1_400) }], NOW);
    expect(stateRows(h)).toHaveLength(1);
    h.db.prepare(`UPDATE loans SET status = 'repaid' WHERE loan_id = 8`).run();
    // Any subsequent pass (here: an unrelated healthy reading) prunes it.
    seedLoan(h, 9);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 9n, hf: hf(2_000) }], NOW + 60);
    expect(stateRows(h)).toHaveLength(0);
  });

  it('skips the whole pass when the indexer has no notified watermark for the chain', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS); // no watermark seeded
    // A `diamond` cursor alone is NOT enough — it advances before
    // materialization, so keying rows on it could out-sort pending
    // same-block event rows (Codex #1300 r1).
    h.db
      .prepare(
        `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'diamond', ?, ?)`,
      )
      .run(CHAIN, HEAD, NOW);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 1n, hf: hf(1_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
  });

  it('defers minting on a stale watermark (indexer behind — D1 ownership may lag live HF)', async () => {
    const h = harness(NOW - 3_600); // watermark an hour old
    seedLoan(h, 10);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 10n, hf: hf(1_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0); // crossing NOT committed — retries when fresh
  });

  it('prunes terminal state even on a zero-readings pass (Codex #1300 r1)', async () => {
    const h = harness();
    seedLoan(h, 11);
    await recordHfBandNotifications(h.d1 as never, CHAIN, [{ id: 11n, hf: hf(1_400) }], NOW);
    expect(stateRows(h)).toHaveLength(1);
    // The loan closes and the active set goes empty — the liquidator
    // still calls the pass with [] and the state row must not linger.
    h.db.prepare(`UPDATE loans SET status = 'repaid' WHERE loan_id = 11`).run();
    await recordHfBandNotifications(h.d1 as never, CHAIN, [], NOW + 60);
    expect(stateRows(h)).toHaveLength(0);
  });
});
