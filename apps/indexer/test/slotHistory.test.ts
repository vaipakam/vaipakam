/**
 * Auto-lend per-slot history — the pure rules (terms, rate comparison, share
 * of time lent) and the route over the real migrated schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  compareRates,
  lentShareFrom,
  slotTermsFrom,
  type ComparableCandidate,
  type SlotEventRow,
  type SlotLedgerRow,
  type SlotTerms,
} from '../src/slotHistory';
import { handleSlotHistory, parseSlotKey } from '../src/slotHistoryRoute';
import { createSqliteD1 } from './helpers/sqliteD1';

const DAY = 86_400;
const NOW = 1_800_000_000;
const OWNER = '0x1111111111111111111111111111111111111111';
const LEND = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COLL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHAIN_ID = 84532;

function setArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Checksummed spelling, as viem decodes it: the route lower-cases.
    owner: '0x1111111111111111111111111111111111111111'.toUpperCase().replace('0X', '0x'),
    lendingAsset: LEND,
    collateralAsset: COLL,
    slot: 0,
    maxExposure: '1000',
    minRateBps: '500',
    maxInitLtvBps: 7000,
    maxDurationDays: 60,
    minFillAmount: '100',
    requiresKeeperAuth: false,
    lendUntil: '0',
    acceptsProRata: true,
    ...over,
  };
}

let seq = 0;
function ev(kind: string, at: number, args: Record<string, unknown>): SlotEventRow {
  seq += 1;
  return { kind, block_number: seq, log_index: 0, block_at: at, args_json: JSON.stringify(args) };
}

describe('slotTermsFrom', () => {
  it('keeps termsSince across a re-set with the same terms, moves it on a change', () => {
    const t = slotTermsFrom([
      ev('LenderIntentSet', 100, setArgs()),
      ev('LenderIntentSet', 200, setArgs()),
      ev('LenderIntentSet', 300, setArgs({ minRateBps: '600' })),
      ev('LenderIntentSet', 400, setArgs({ minRateBps: '600' })),
    ]);
    expect(t).toMatchObject({ state: 'open', minRateBps: 600, termsSince: 300, lastChangedAt: 400 });
  });

  it('restarts after a cancel, and reports a cancelled slot', () => {
    expect(
      slotTermsFrom([ev('LenderIntentSet', 100, setArgs()), ev('LenderIntentCancelled', 150, setArgs())]),
    ).toMatchObject({ state: 'cancelled', termsSince: 100 });
    expect(
      slotTermsFrom([
        ev('LenderIntentSet', 100, setArgs()),
        ev('LenderIntentCancelled', 150, setArgs()),
        ev('LenderIntentSet', 200, setArgs()),
      ]),
    ).toMatchObject({ state: 'open', termsSince: 200 });
  });

  it('is unknown with no set, or a set it cannot read', () => {
    expect(slotTermsFrom([])).toBeNull();
    expect(slotTermsFrom([ev('LenderIntentSet', 1, setArgs({ minRateBps: 'x' }))])).toBeNull();
  });
});

function loan(id: number, rate: number, principal: string, borrower: string, lender = '0xL'): ComparableCandidate {
  return { loan_id: id, init_rate_bps: rate, init_principal: principal, init_lender: lender, init_borrower: borrower };
}

describe('compareRates', () => {
  it('states the range and the rate below which half the amount opened', () => {
    const { comparison } = compareRates(
      [
        loan(1, 400, '100', '0xb1'),
        loan(2, 500, '100', '0xb2'),
        loan(3, 600, '600', '0xb3'),
        loan(4, 700, '100', '0xb1'),
        loan(5, 800, '100', '0xb2'),
      ],
      '100',
    );
    // Total 1,000: 400 and 500 reach 200, 600 reaches 800 ≥ 500.
    expect(comparison).toEqual({
      enough: true,
      loanCount: 5,
      borrowerCount: 3,
      lowestBps: 400,
      highestBps: 800,
      halfAmountBps: 600,
    });
  });

  it('leaves out self loans, loans under the smallest fill and unknown parties', () => {
    const { comparison, excluded } = compareRates(
      [
        loan(1, 400, '100', '0xb1'),
        loan(2, 500, '100', '0xAA', '0xaa'),
        loan(3, 600, '99', '0xb3'),
        { ...loan(4, 700, '100', '0xb1'), init_borrower: null },
      ],
      '100',
    );
    expect(excluded).toEqual({ selfLoans: 1, belowMinimumFill: 1, partiesUnknown: 1 });
    expect(comparison).toEqual({ enough: false });
  });

  it('shows no figure below five loans or three borrowers', () => {
    const fourLoans = [1, 2, 3, 4].map((i) => loan(i, 500, '100', `0xb${i}`));
    expect(compareRates(fourLoans, '1').comparison).toEqual({ enough: false });
    const twoBorrowers = [1, 2, 3, 4, 5].map((i) => loan(i, 500, '100', `0xb${i % 2}`));
    expect(compareRates(twoBorrowers, '1').comparison).toEqual({ enough: false });
  });
});

const TERMS: SlotTerms = {
  state: 'open',
  minRateBps: 500,
  maxDurationDays: 60,
  minFillAmount: '100',
  maxExposure: '1000',
  maxInitLtvBps: 7000,
  lendUntil: 0,
  termsSince: NOW - 10 * DAY,
  lastChangedAt: NOW - 10 * DAY,
};

function move(at: number, live: string, capital: string): SlotLedgerRow {
  seq += 1;
  return { block_number: seq, log_index: 0, block_at: at, args_json: JSON.stringify({ live, capital }) };
}

describe('lentShareFrom', () => {
  it('weights live principal by time over the money behind the slot, capped at its exposure', () => {
    const start = NOW - 10 * DAY;
    // Days 0–5: 500 lent of 1,500 behind (capped at 1,000) → 500/1,000.
    // Days 5–10: 1,000 lent, nothing unlent → 1,000/1,000.
    const share = lentShareFrom(TERMS, move(start - 1, '500', '1000'), [move(start + 5 * DAY, '1000', '0')], NOW);
    expect(share).toMatchObject({ available: true, daysOfRecord: 10, shareBps: 7_500, fundedSeconds: 10 * DAY });
  });

  it('counts time with nothing behind the slot for nothing', () => {
    const start = NOW - 10 * DAY;
    const share = lentShareFrom(TERMS, move(start, '0', '0'), [move(start + 5 * DAY, '500', '500')], NOW);
    expect(share).toMatchObject({ available: true, shareBps: 5_000, fundedSeconds: 5 * DAY });
    const empty = lentShareFrom(TERMS, move(start, '0', '0'), [], NOW);
    expect(empty).toMatchObject({ available: true, shareBps: null, fundedSeconds: 0 });
  });

  it('is unavailable without a record at the start of the period', () => {
    expect(lentShareFrom(TERMS, null, [], NOW)).toMatchObject({
      available: false,
      reason: 'no-record-at-period-start',
      periodStart: NOW - 10 * DAY,
      daysOfRecord: 10,
    });
  });

  it('covers at most 30 days', () => {
    const old = { ...TERMS, termsSince: NOW - 90 * DAY };
    expect(lentShareFrom(old, null, [], NOW)).toMatchObject({ periodStart: NOW - 30 * DAY, daysOfRecord: 30 });
  });
});

describe('parseSlotKey', () => {
  it('needs every part well formed', () => {
    const ok = new URL(`https://i/x?owner=${OWNER}&lendingAsset=${LEND}&collateralAsset=${COLL}&slot=2`);
    expect(parseSlotKey(ok)).toEqual({ owner: OWNER, lendingAsset: LEND, collateralAsset: COLL, slot: 2 });
    for (const bad of ['slot=-1', 'slot=x', 'slot=1000', 'slot=']) {
      expect(parseSlotKey(new URL(`https://i/x?owner=${OWNER}&lendingAsset=${LEND}&collateralAsset=${COLL}&${bad}`))).toBeNull();
    }
    expect(parseSlotKey(new URL(`https://i/x?owner=0x12&lendingAsset=${LEND}&collateralAsset=${COLL}&slot=0`))).toBeNull();
  });
});

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

describe('GET /loans/slot-history', () => {
  function harness() {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    let block = 0;
    const event = (kind: string, at: number, args: Record<string, unknown>, loanId: number | null = null) => {
      block += 1;
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
           VALUES (?, ?, 0, '0x1', ?, ?, ?, ?)`,
        )
        .run(CHAIN_ID, block, kind, loanId, JSON.stringify(args), at);
    };
    const loanRow = (id: number, rate: number, principal: string, durationDays: number, startAt: number, saleVehicle = 0) =>
      h.db
        .prepare(
          `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
             principal, collateral_amount, asset_type, collateral_asset_type,
             lending_asset, collateral_asset, duration_days, token_id,
             collateral_token_id, lender_token_id, borrower_token_id,
             lender_current_owner, borrower_current_owner, interest_rate_bps,
             start_time, start_block, start_at, updated_at,
             init_rate_bps, init_duration_days, init_principal,
             init_terms_unbacked, init_principal_unbacked, is_sale_vehicle)
           VALUES (?, ?, 1, 'active', '0xl', '0xb', ?, '200', 0, 0, ?, ?,
             ?, '0', '0', '1', '2', '0xl', '0xb', ?, 0, 0, ?, 0,
             ?, ?, ?, 0, 0, ?)`,
        )
        .run(CHAIN_ID, id, principal, LEND, COLL, durationDays, rate, startAt, rate, durationDays, principal, saleVehicle);
    const call = async (q = `owner=${OWNER}&lendingAsset=${LEND}&collateralAsset=${COLL}&slot=0`) => {
      const res = await handleSlotHistory(new Request(`https://idx/loans/slot-history?chainId=${CHAIN_ID}&${q}`), env, NOW);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { h, event, loanRow, call };
  }

  it('serves the terms, the comparison and the share from the ledger', async () => {
    const { event, loanRow, call } = harness();
    event('LenderIntentSet', NOW - 40 * DAY, setArgs());
    // Another slot of the same owner, and another owner: never read.
    event('LenderIntentSet', NOW - 40 * DAY, setArgs({ slot: 1, minRateBps: '900' }));
    event('LenderIntentSet', NOW - 40 * DAY, setArgs({ owner: LEND, minRateBps: '900' }));
    event('SlotLedgerSet', NOW - 31 * DAY, { owner: OWNER, lendingAsset: LEND, collateralAsset: COLL, slot: 0, loanId: '0', live: '0', capital: '1000' });
    event('SlotLedgerSet', NOW - 15 * DAY, { owner: OWNER, lendingAsset: LEND, collateralAsset: COLL, slot: 0, loanId: '7', live: '1000', capital: '0' });
    const rates = [400, 500, 600, 700, 800];
    rates.forEach((r, i) => {
      loanRow(i + 1, r, '200', 30, NOW - DAY);
      event('LoanInitiated', NOW - DAY, { loanId: String(i + 1), lender: '0xL', borrower: `0xb${i % 3}` }, i + 1);
    });
    // Left out: too long a term, a sale vehicle, too old.
    loanRow(20, 100, '200', 90, NOW - DAY);
    loanRow(21, 100, '200', 30, NOW - DAY, 1);
    loanRow(22, 100, '200', 30, NOW - 31 * DAY);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.basis).toBe('past-loans-not-a-forecast');
    expect(body.terms).toMatchObject({ state: 'open', minRateBps: 500 });
    expect(body.rates.slotMinimumBps).toBe(500);
    expect(body.rates.comparison).toEqual({
      enough: true,
      loanCount: 5,
      borrowerCount: 3,
      lowestBps: 400,
      highestBps: 800,
      halfAmountBps: 600,
    });
    expect(body.lentShare).toMatchObject({ available: true, daysOfRecord: 30, shareBps: 5_000 });
  });

  it('says the share is unavailable on a chain whose build has no ledger event', async () => {
    const { event, call } = harness();
    event('LenderIntentSet', NOW - 5 * DAY, setArgs());
    const { body } = await call();
    expect(body.lentShare).toMatchObject({ available: false, reason: 'no-record-at-period-start', daysOfRecord: 5 });
    expect(body.rates.comparison).toEqual({ enough: false });
  });

  it('is 404 for a slot the ledger has never seen, and 400 on a bad key', async () => {
    const { call } = harness();
    expect((await call()).status).toBe(404);
    expect((await call('owner=0x1&slot=0')).status).toBe(400);
  });
});
