import { describe, expect, it } from 'vitest';
import {
  CURVE_TERMS,
  OWN_LOANS_RULE,
  capWalletShares,
  curveTermFor,
  lookbackDays,
  ownLoansCurve,
  paidInterestOf,
  weightedQuantile,
  type CurveLoanRow,
  type PaidInterestEvent,
} from '../src/rateCurve';
import { daysToCompute, BACKFILL_DAYS_PER_RUN, ruleStatement } from '../src/rateCurveRoutes';

const DAY = 86_400;
const NOW = 1_800_000_000;

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

let nextId = 1;
function loan(over: Partial<CurveLoanRow> = {}): CurveLoanRow {
  // The opening parties default to the lender and borrower given, so a row
  // reads as a loan nobody has sold or handed over (#3879).
  const lender = over.lender ?? addr(1);
  const borrower = over.borrower ?? addr(1001);
  return {
    loan_id: nextId++,
    lender,
    borrower,
    init_lender: 'init_lender' in over ? (over.init_lender ?? null) : lender,
    init_borrower: 'init_borrower' in over ? (over.init_borrower ?? null) : borrower,
    status: 'repaid',
    start_at: NOW - 40 * DAY,
    terminal_at: NOW - 10 * DAY,
    init_rate_bps: 500,
    init_duration_days: 30,
    init_terms_unbacked: 0,
    ...over,
  };
}

/** n repaid 30-day loans, each between its own lender and borrower. */
function market(n: number, rate: (i: number) => number, paid = 100n) {
  const rows: CurveLoanRow[] = [];
  const pay = new Map<number, bigint>();
  for (let i = 0; i < n; i++) {
    const r = loan({ lender: addr(10 + i), borrower: addr(500 + i), init_rate_bps: rate(i) });
    rows.push(r);
    pay.set(r.loan_id, paid);
  }
  return { rows, pay };
}

const point = (figs: ReturnType<typeof ownLoansCurve>, days: number) => figs.find((f) => f.days === days)!;

describe('rate curve: terms and look-backs', () => {
  it('groups loan durations into the five points by range', () => {
    expect(curveTermFor(1)).toBe(7);
    expect(curveTermFor(14)).toBe(7);
    expect(curveTermFor(15)).toBe(30);
    expect(curveTermFor(60)).toBe(30);
    expect(curveTermFor(61)).toBe(90);
    expect(curveTermFor(270)).toBe(180);
    expect(curveTermFor(271)).toBe(365);
    expect(curveTermFor(2000)).toBe(365);
    expect(curveTermFor(0)).toBeNull();
  });

  it('looks back the larger of 90 days and twice the term', () => {
    expect(CURVE_TERMS.map(lookbackDays)).toEqual([90, 90, 180, 360, 730]);
  });
});

describe('rate curve: which loans count', () => {
  it('shows a point with five distinct lenders and borrowers', () => {
    const { rows, pay } = market(5, (i) => 400 + i * 100);
    const f = point(ownLoansCurve(rows, pay, NOW), 30);
    expect(f.state).toBe('shown');
    expect(f.loans).toBe(5);
    expect([f.p25Bps, f.medianBps, f.p75Bps]).toEqual([500, 600, 700]);
  });

  it('withholds below five lenders or five borrowers', () => {
    const { rows, pay } = market(5, () => 500);
    rows[4].init_lender = rows[3].init_lender; // four distinct lenders
    const f = point(ownLoansCurve(rows, pay, NOW), 30);
    expect(f.state).toBe('withheld');
    expect(f.reason).toBe('not-enough-loans');
    expect(f.p25Bps).toBeNull();
    expect(OWN_LOANS_RULE.minLenders).toBe(5);
    expect(OWN_LOANS_RULE.minBorrowers).toBe(5);
  });

  it('leaves out open, defaulted, one-address, unconfirmed, too-young and unpaid loans', () => {
    const { rows, pay } = market(5, () => 500);
    const extra = [
      loan({ status: 'active', terminal_at: null, init_rate_bps: 9_000 }),
      loan({ status: 'defaulted', init_rate_bps: 9_000 }),
      loan({ lender: addr(77), borrower: addr(77), init_rate_bps: 9_000 }),
      loan({ init_terms_unbacked: 1, init_rate_bps: 9_000 }),
      loan({ start_at: NOW - 2 * DAY, terminal_at: NOW - DAY, init_rate_bps: 9_000 }),
      loan({ init_rate_bps: 9_000 }), // repaid, but no interest recorded
    ];
    for (const e of extra.slice(0, 5)) pay.set(e.loan_id, 10_000n);
    const f = point(ownLoansCurve([...rows, ...extra], pay, NOW), 30);
    expect(f.loans).toBe(5);
    expect(f.p75Bps).toBe(500);
  });

  describe('the counting rule for public figures (#3879)', () => {
    it('leaves out one-address and unknown-party loans and counts each on its own line', () => {
      const { rows, pay } = market(5, () => 500);
      const one = loan({ lender: addr(77), borrower: addr(77), init_rate_bps: 9_000 });
      const unknown = loan({ init_lender: null, init_rate_bps: 9_000 });
      // A one-address loan that fails another test is not in scope at all.
      const oneOpen = loan({ lender: addr(78), borrower: addr(78), status: 'active', terminal_at: null });
      for (const e of [one, unknown, oneOpen]) pay.set(e.loan_id, 10_000n);
      const f = point(ownLoansCurve([...rows, one, unknown, oneOpen], pay, NOW), 30);
      expect(f.loans).toBe(5);
      expect(f.p75Bps).toBe(500);
      expect(f.oneAddress).toBe(1);
      expect(f.openingPartiesUnknown).toBe(1);
    });

    it('reads the opening parties, so a later sale or handover moves a loan neither in nor out', () => {
      const { rows, pay } = market(5, () => 500);
      // Loan 0 was later sold to its own borrower: the current holders are
      // one address, the opening parties two. It stays counted.
      rows[0].lender = rows[0].borrower;
      // A loan opened with one address on both sides and later sold to a
      // different lender stays out.
      const sold = loan({ lender: addr(90), borrower: addr(91), init_lender: addr(91), init_borrower: addr(91), init_rate_bps: 9_000 });
      pay.set(sold.loan_id, 10_000n);
      const f = point(ownLoansCurve([...rows, sold], pay, NOW), 30);
      expect(f.loans).toBe(5);
      expect(f.state).toBe('shown');
      expect(f.oneAddress).toBe(1);
    });

    it('states the rule on every response', () => {
      const r = ruleStatement();
      expect(r.excludes).toEqual(expect.arrayContaining(['one-address-at-opening', 'opening-parties-unknown']));
      expect(r.excludes).not.toContain('self-trade-pairs');
      expect(r.oneAddressRule).toMatch(/cannot see two addresses that belong to one person/);
      expect(r.rates).toMatch(/per lending asset and term range/);
    });
  });

  it('counts a loan repaid AFTER the as-of time as not yet closed on that day', () => {
    const { rows, pay } = market(5, () => 500);
    const asOf = NOW - 20 * DAY; // before every terminal_at (NOW - 10d)
    expect(point(ownLoansCurve(rows, pay, asOf), 30).loans).toBe(0);
  });

  it('respects each point\'s own look-back', () => {
    const { rows, pay } = market(5, () => 500);
    for (const r of rows) {
      r.start_at = NOW - 100 * DAY;
      r.terminal_at = NOW - 60 * DAY;
    }
    expect(point(ownLoansCurve(rows, pay, NOW), 30).loans).toBe(0); // 90-day look-back
    for (const r of rows) r.init_duration_days = 100;
    expect(point(ownLoansCurve(rows, pay, NOW), 90).loans).toBe(5); // 180-day look-back
  });

  it('withholds a point whose look-back reaches before a truncated scan', () => {
    const { rows, pay } = market(5, () => 500);
    const coveredFrom = NOW - 60 * DAY;
    const f = point(ownLoansCurve(rows, pay, NOW, coveredFrom), 30);
    expect(f.state).toBe('withheld');
    expect(f.reason).toBe('history-incomplete');
  });
});

describe('rate curve: weight is interest paid', () => {
  it('weighs by interest paid, so a large payer moves the median', () => {
    const { rows, pay } = market(6, (i) => 400 + i * 100);
    pay.set(rows[5].loan_id, 1_000n); // the 900 bps loan paid far more
    const f = point(ownLoansCurve(rows, pay, NOW), 30);
    expect(f.medianBps).toBeGreaterThan(600);
  });

  it('sums the two payment events and ignores others and later ones', () => {
    const ev = (loan_id: number, kind: string, args: object, block_at: number): PaidInterestEvent => ({
      loan_id,
      kind,
      args_json: JSON.stringify(args),
      block_at,
    });
    const events = [
      ev(1, 'LoanSettlementBreakdown', { interest: '70' }, 100),
      ev(1, 'InterestPaymentBooked', { settled: '30' }, 50),
      ev(1, 'PeriodicInterestSettled', { paidByBorrower: '30' }, 50),
      ev(2, 'LoanSettlementBreakdown', { interest: '5' }, 500),
      ev(3, 'toString', { interest: '9' }, 10),
    ];
    const m = paidInterestOf(events, 200);
    expect(m.get(1)).toBe(100n);
    expect(m.has(2)).toBe(false);
    expect(m.has(3)).toBe(false);
  });
});

describe('rate curve: wallet cap and quantiles', () => {
  it('caps one wallet at 20% of the weight on each side', () => {
    const items = [
      { weight: 100, lender: 'a', borrower: 'x1', rate: 1 },
      ...[2, 3, 4, 5, 6].map((i) => ({ weight: 1, lender: `l${i}`, borrower: `x${i}`, rate: i })),
    ];
    const out = capWalletShares(items, 2_000);
    const total = out.reduce((s, i) => s + i.weight, 0);
    const a = out.filter((i) => i.lender === 'a').reduce((s, i) => s + i.weight, 0);
    expect(a / total).toBeLessThanOrEqual(0.2 + 1e-6);
  });

  it('returns an observed rate, never an average', () => {
    expect(weightedQuantile([{ rate: 100, weight: 1 }, { rate: 300, weight: 1 }], 0.5)).toBe(100);
    expect(weightedQuantile([], 0.5)).toBeNull();
  });
});

describe('rate curve: the pass and the stated rule', () => {
  it('computes today, yesterday and a bounded backfill of missing days', () => {
    const today = Math.floor(NOW / DAY);
    const days = daysToCompute(NOW, new Set([today - 2, today - 4]));
    expect(days[0]).toEqual({ day: today, asOf: NOW });
    expect(days[1]).toEqual({ day: today - 1, asOf: today * DAY - 1 });
    expect(days.length).toBe(2 + BACKFILL_DAYS_PER_RUN);
    expect(days.map((d) => d.day)).not.toContain(today - 2);
  });

  it('states every setting and each point\'s range and look-back', () => {
    const r = ruleStatement();
    expect(r.provisional).toBe(true);
    expect(r.weight).toBe('interest-paid');
    expect(r.points.map((p) => p.lookbackDays)).toEqual([90, 90, 180, 360, 730]);
    expect(r.points[4].termRange).toEqual([271, null]);
  });
});

// ─── Against the REAL migrated schema ──────────────────────────────────
// The pass's three reads and its one json_each upsert, and both public
// reads, executed on every migration in order (the sqlSchemaGuard floor
// counts the pass's dynamic `kind IN (…)` read as executed here).

import { readFileSync, readdirSync } from 'node:fs';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  handleRateCurve,
  handleRateCurveHistory,
  refreshRateCurveForChain,
} from '../src/rateCurveRoutes';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const BASE = 84532;
const USDC = '0x00000000000000000000000000000000000000c1';
const OPEN = { limit: async () => ({ success: true }) };

describe('rate curve against the migrated schema', () => {
  function seeded(now: number) {
    const h = createSqliteD1(migrations());
    // Six two-party loans, then one opened with one address on both sides
    // (id 7, rate 9000) that the counting rule leaves out (#3879).
    for (let i = 0; i < 7; i++) {
      const id = i + 1;
      const [lender, borrower] = i < 6 ? [addr(10 + i), addr(500 + i)] : [addr(77), addr(77)];
      h.db
        .prepare(
          `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower, principal,
             collateral_amount, lending_asset, collateral_asset, duration_days, start_block, start_at,
             terminal_at, updated_at, init_rate_bps, init_duration_days, init_terms_unbacked,
             init_principal, init_principal_unbacked, init_lender, init_borrower)
           VALUES (?, ?, ?, 'repaid', ?, ?, '1000', '2000', ?, ?, 30, 1, ?, ?, ?, ?, 30, 0, '1000', 0, ?, ?)`,
        )
        .run(
          BASE, id, id, lender, borrower, USDC, addr(99), now - 40 * DAY, now - 10 * DAY, now,
          i < 6 ? 400 + i * 100 : 9_000, lender, borrower,
        );
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, actor, args_json, block_at)
           VALUES (?, ?, 0, ?, 'LoanSettlementBreakdown', ?, NULL, ?, ?)`,
        )
        .run(BASE, id, `0x${id}`, id, JSON.stringify({ loanId: String(id), interest: '50' }), now - 10 * DAY);
    }
    return h;
  }

  it('writes the daily rows and serves both halves labelled apart', async () => {
    const now = Math.floor(Date.now() / 1000);
    const h = seeded(now);
    const r = await refreshRateCurveForChain(h.d1 as D1Database, BASE, now);
    expect(r.rows).toBe(r.days * 5);

    const env = { DB: h.d1, RATE_CURVE_RATELIMIT: OPEN, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    const res = await handleRateCurve(new Request(`https://x/rates/curve?chainId=${BASE}&asset=${USDC}`), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.computed).toBe(true);
    expect(body.reference.source).toBe('outside-rate-reference');
    expect(body.reference.terms.every((t: any) => t.state === 'not-published' && t.valueBps === null)).toBe(true);
    expect(body.ownLoans.source).toBe('platform-repaid-loans');
    const p30 = body.ownLoans.terms.find((t: any) => t.days === 30);
    expect(p30).toMatchObject({
      state: 'shown',
      loans: 6,
      lenders: 6,
      borrowers: 6,
      p25Bps: 500,
      medianBps: 600,
      leftOut: { oneAddress: 1, openingPartiesUnknown: 0 },
    });
    expect(body.ownLoans.rule.excludes).toContain('one-address-at-opening');
    expect(body.ownLoans.terms.find((t: any) => t.days === 7).state).toBe('withheld');

    const hist = await handleRateCurveHistory(
      new Request(`https://x/rates/curve/history?chainId=${BASE}&asset=${USDC}&days=30&range=30d`),
      env,
    );
    const hb = (await hist.json()) as any;
    expect(hb.rows.length).toBe(r.days);
    expect(hb.rows.at(-1).ownLoans.medianBps).toBe(600);
  });

  it('refuses a bad asset, a bad term and a spent budget', async () => {
    const h = seeded(Math.floor(Date.now() / 1000));
    const env = { DB: h.d1, RATE_CURVE_RATELIMIT: OPEN, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    expect((await handleRateCurve(new Request('https://x/rates/curve?asset=nope'), env)).status).toBe(400);
    expect(
      (await handleRateCurveHistory(new Request(`https://x/rates/curve/history?asset=${USDC}&days=31`), env)).status,
    ).toBe(400);
    const spent = { ...env, RATE_CURVE_RATELIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
    expect((await handleRateCurve(new Request(`https://x/rates/curve?asset=${USDC}`), spent)).status).toBe(429);
    const missing = { ...env, RATE_CURVE_RATELIMIT: undefined } as unknown as Env;
    expect((await handleRateCurve(new Request(`https://x/rates/curve?asset=${USDC}`), missing)).status).toBe(503);
  });
});
