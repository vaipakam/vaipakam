/**
 * HF-band inbox rows (#1213 PR 2b) — band classification and the
 * downgrade-only crossing semantics, exercised over the REAL migration DDL
 * of BOTH databases (#2450): the shared one (apps/indexer/migrations —
 * `indexer_cursor`, `loans`, `notifications`) and the keeper's private one
 * (apps/keeper/migrations — `hf_band_state`). The shared harness has no
 * keeper tables (see helpers/schemas.ts), so a statement sent to the wrong
 * handle fails instead of passing against a stale copy. Assertions read the
 * tables rather than returned counts — the shim does carry `meta.changes` per
 * statement since #2234, but the table is the fact and the count is a report
 * of it.
 */
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
import type { SqliteD1 } from './helpers/sqliteD1';
import { bindings, createKeeperD1, createSharedD1 } from './helpers/schemas';
import type { Env } from '../src/env';

const CHAIN = 84532;
const BORROWER = '0x00000000000000000000000000000000000000bb';
const NEW_BORROWER = '0x00000000000000000000000000000000000000cc';
const NOW = 1_800_000_000;
const HEAD = 4_242;

const E15 = 10n ** 15n;
/** milli-HF → the 1e18-scaled bigint the contract returns. */
const hf = (milli: number) => BigInt(milli) * E15;

/** Both databases, and the bindings the pass reads them through. */
interface Harness {
  /** The shared database — `indexer_cursor`, `loans`, `notifications`. */
  shared: SqliteD1;
  /** The keeper's private database — `hf_band_state`. */
  keeper: SqliteD1;
  dbs: Pick<Env, 'DB' | 'KEEPER_DB'>;
}

/** `watermarkAt = null` seeds no `notified` watermark at all. */
function harness(watermarkAt: number | null = NOW): Harness {
  const shared = createSharedD1();
  const keeper = createKeeperD1();
  // The indexer's post-materialization `notified` watermark the pass
  // stamps rows from and gates staleness on (Codex #1300 r1 — NOT the
  // main `diamond` cursor, which advances before materialization).
  if (watermarkAt !== null) {
    shared.db
      .prepare(
        `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'notified', ?, ?)`,
      )
      .run(CHAIN, HEAD, watermarkAt);
  }
  return { shared, keeper, dbs: bindings(shared, keeper) };
}

function seedLoan(h: Harness, loanId: number, status = 'active', borrowerOwner: string | null = BORROWER) {
  h.shared.db
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

const notifRows = (h: Harness) =>
  h.shared.db
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

const stateRows = (h: Harness) =>
  h.keeper.db
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

describe('recordHfBandNotifications (over the migrated shared + keeper schemas)', () => {
  it('mints a borrower row on first observation inside a band, stamped at the cursor head', async () => {
    const h = harness();
    seedLoan(h, 1);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 1n, hf: hf(1_400) }], NOW);
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
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 2n, hf: hf(2_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0);
  });

  it('downgrades mint, same-band re-ticks are silent, recoveries delete state without a row', async () => {
    const h = harness();
    seedLoan(h, 3);
    // warn
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 3n, hf: hf(1_400) }], NOW);
    // same band next tick — nothing new
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 3n, hf: hf(1_350) }], NOW + 60);
    expect(notifRows(h)).toHaveLength(1);
    // deeper — alert row
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 3n, hf: hf(1_100) }], NOW + 120);
    expect(notifRows(h).map((r) => r.kind)).toEqual(['hf_warn', 'hf_alert']);
    // recovery — state gone, no "got safer" row
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 3n, hf: hf(1_800) }], NOW + 180);
    expect(notifRows(h)).toHaveLength(2);
    expect(stateRows(h)).toHaveLength(0);
  });

  it('a same-day flap re-crossing the same band is bounded by the day-bucket dedup; a new UTC day re-alerts', async () => {
    const h = harness();
    seedLoan(h, 4);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 4n, hf: hf(1_400) }], NOW);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 4n, hf: hf(1_600) }], NOW + 60);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 4n, hf: hf(1_400) }], NOW + 120);
    expect(notifRows(h)).toHaveLength(1); // same day bucket → INSERT OR IGNORE
    // next UTC day: recover + re-drop mints a fresh row (freshen the
    // watermark as the live indexer would keep doing — a day-old stamp
    // correctly defers under the staleness gate).
    const nextDay = NOW + 86_400;
    h.shared.db
      .prepare(`UPDATE indexer_cursor SET updated_at = ? WHERE kind = 'notified'`)
      .run(nextDay);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 4n, hf: hf(1_600) }], nextDay);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 4n, hf: hf(1_400) }], nextDay + 60);
    expect(notifRows(h)).toHaveLength(2);
  });

  it('defers a crossing whose loan row has not been indexed yet (retries next tick)', async () => {
    const h = harness();
    // no loans row for id 5
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 5n, hf: hf(1_100) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0); // state NOT committed — retry
    seedLoan(h, 5);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 5n, hf: hf(1_100) }], NOW + 60);
    expect(notifRows(h).map((r) => r.kind)).toEqual(['hf_alert']);
  });

  it('resolves the CURRENT borrower-position holder and skips burned sides', async () => {
    const h = harness();
    seedLoan(h, 6, 'active', NEW_BORROWER); // migrated borrower position
    seedLoan(h, 7, 'active', '0x0000000000000000000000000000000000000000'); // burned
    await recordHfBandNotifications(
      h.dbs,
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
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 8n, hf: hf(1_400) }], NOW);
    expect(stateRows(h)).toHaveLength(1);
    h.shared.db.prepare(`UPDATE loans SET status = 'repaid' WHERE loan_id = 8`).run();
    // Any subsequent pass (here: an unrelated healthy reading) prunes it.
    seedLoan(h, 9);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 9n, hf: hf(2_000) }], NOW + 60);
    expect(stateRows(h)).toHaveLength(0);
  });

  it('skips the whole pass when the indexer has no notified watermark for the chain', async () => {
    const h = harness(null); // no watermark seeded
    // A `diamond` cursor alone is NOT enough — it advances before
    // materialization, so keying rows on it could out-sort pending
    // same-block event rows (Codex #1300 r1).
    h.shared.db
      .prepare(
        `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'diamond', ?, ?)`,
      )
      .run(CHAIN, HEAD, NOW);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 1n, hf: hf(1_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
  });

  it('defers while the diamond tip is ahead of the notified watermark (scan in flight, Codex #1300 r2)', async () => {
    const h = harness(); // fresh notified watermark at HEAD
    h.shared.db
      .prepare(
        `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'diamond', ?, ?)`,
      )
      .run(CHAIN, HEAD + 10, NOW); // event rows for HEAD+1..HEAD+10 may be pending
    seedLoan(h, 12);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 12n, hf: hf(1_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0);
    // Watermark catches the tip → the crossing re-detects.
    h.shared.db
      .prepare(`UPDATE indexer_cursor SET last_block = ? WHERE kind = 'notified'`)
      .run(HEAD + 10);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 12n, hf: hf(1_000) }], NOW + 60);
    expect(notifRows(h).map((r) => [r.kind, r.block_number])).toEqual([
      ['hf_critical', HEAD + 10],
    ]);
  });

  it('re-alerts the NEW borrower-position holder on a same-band transfer (Codex #1300 r2)', async () => {
    const h = harness();
    seedLoan(h, 13);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 13n, hf: hf(1_400) }], NOW);
    expect(notifRows(h)).toHaveLength(1);
    // Same band next tick — silent.
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 13n, hf: hf(1_390) }], NOW + 60);
    expect(notifRows(h)).toHaveLength(1);
    // The borrower position migrates while STILL in warn — the new
    // holder must learn the loan they now hold is inside a band.
    h.shared.db
      .prepare(`UPDATE loans SET borrower_current_owner = ? WHERE loan_id = 13`)
      .run(NEW_BORROWER);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 13n, hf: hf(1_390) }], NOW + 120);
    const rows = notifRows(h);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ recipient: NEW_BORROWER, kind: 'hf_warn', loan_id: 13 });
    // And the new holder is now the stored edge — no re-alert next tick.
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 13n, hf: hf(1_390) }], NOW + 180);
    expect(notifRows(h)).toHaveLength(2);
  });

  it('defers minting on a stale watermark (indexer behind — D1 ownership may lag live HF)', async () => {
    const h = harness(NOW - 3_600); // watermark an hour old
    seedLoan(h, 10);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 10n, hf: hf(1_000) }], NOW);
    expect(notifRows(h)).toHaveLength(0);
    expect(stateRows(h)).toHaveLength(0); // crossing NOT committed — retries when fresh
  });

  it('prunes terminal state even on a zero-readings pass (Codex #1300 r1)', async () => {
    const h = harness();
    seedLoan(h, 11);
    await recordHfBandNotifications(h.dbs, CHAIN, [{ id: 11n, hf: hf(1_400) }], NOW);
    expect(stateRows(h)).toHaveLength(1);
    // The loan closes and the active set goes empty — the liquidator
    // still calls the pass with [] and the state row must not linger.
    h.shared.db.prepare(`UPDATE loans SET status = 'repaid' WHERE loan_id = 11`).run();
    await recordHfBandNotifications(h.dbs, CHAIN, [], NOW + 60);
    expect(stateRows(h)).toHaveLength(0);
  });
  // #2450 — the prune used to be ONE statement joining `hf_band_state` to
  // `loans`; the two now live in different databases, so it reads each side
  // and deletes. These pin that the split kept the join's exact semantics.
  it('keeps band state for a loan the index has not recorded yet — only a recorded terminal status prunes (#2450)', async () => {
    const h = harness();
    // State for loan 20, but NO `loans` row: the old `EXISTS` join kept it,
    // because a missing row is lag, not a terminal status.
    h.keeper.db
      .prepare(
        `INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at)
         VALUES (?, 20, 'warn', 1400, ?, ?)`,
      )
      .run(CHAIN, BORROWER, NOW);
    // And one for loan 21, recorded and closed — that one goes.
    seedLoan(h, 21, 'repaid');
    h.keeper.db
      .prepare(
        `INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at)
         VALUES (?, 21, 'warn', 1400, ?, ?)`,
      )
      .run(CHAIN, BORROWER, NOW);
    await recordHfBandNotifications(h.dbs, CHAIN, [], NOW + 60);
    expect(stateRows(h).map((r) => r.loan_id)).toEqual([20]);
  });

  it('prunes a terminal backlog wider than one D1 IN-list, on this chain only (#2450)', async () => {
    const h = harness();
    // 150 banded loans: more than D1's 100-parameter cap allows in one IN
    // list, so both the cross-database read and the delete must chunk.
    const insert = h.keeper.db.prepare(
      `INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at)
       VALUES (?, ?, 'warn', 1400, ?, ?)`,
    );
    for (let id = 1; id <= 150; id++) {
      seedLoan(h, id, id <= 120 ? 'repaid' : 'active');
      insert.run(CHAIN, id, BORROWER, NOW);
    }
    // Another chain's row for a terminal loan id is not this pass's to prune.
    insert.run(CHAIN + 1, 1, BORROWER, NOW);
    await recordHfBandNotifications(h.dbs, CHAIN, [], NOW + 60);
    const left = h.keeper.db
      .prepare('SELECT chain_id, loan_id FROM hf_band_state ORDER BY chain_id, loan_id')
      .all() as Array<{ chain_id: number; loan_id: number }>;
    expect(left.filter((r) => r.chain_id === CHAIN).map((r) => r.loan_id)).toEqual(
      Array.from({ length: 30 }, (_, i) => 121 + i),
    );
    expect(left.filter((r) => r.chain_id === CHAIN + 1)).toHaveLength(1);
  });
});
