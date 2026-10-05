/**
 * #2422 r7 — parsing a review receipt against its en.json templates. The
 * strings are the ones the deployed app rendered for loan 22 → request #45
 * on 2026-10-05, so a parser regression shows up against real output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { refinancePayoffAt } from './refinanceExpected.mjs';
import {
  amountMatches,
  compareBorrowerReceipt,
  compareLenderReceipt,
  matchTemplate,
  parseAmount,
  parseDurationDays,
  parseGraceSeconds,
  parsePercentBps,
  percentMatches,
  templateRegex,
} from './reviewTerms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(fs.readFileSync(path.join(HERE, '../../src/i18n/locales/en.json'), 'utf8')).copy;
const R = EN.offerFlow.receipts;

describe('reviewTerms — templates', () => {
  it('captures the placeholders of the real lender receipt rows', () => {
    expect(
      matchTemplate(
        R.lenderYouReceive,
        'Up to ~0.00004932 WETH interest if the borrower repays on time, plus your 0.005 WETH back. Interest is full-term: the whole term’s interest applies even if the loan is repaid early.',
        { prefix: true },
      ),
    ).toEqual({ interest: '0.00004932 WETH', principal: '0.005 WETH' });
    expect(matchTemplate(R.lenderYouLockAccept, '0.005 WETH lent to the borrower, now.')).toEqual({ principal: '0.005 WETH' });
    expect(
      matchTemplate(R.lenderWhenEndsAccept, 'Repayment is due within 1 month (grace period: 3 days). You then claim your funds.'),
    ).toEqual({ duration: '1 month', grace: '3 days' });
    expect(matchTemplate(EN.fees.lenderYieldFee, 'Vaipakam keeps 2% of the interest you earn.')).toEqual({ pct: '2%' });
  });

  it('refuses text whose literal parts differ — unparseable is a failure, not a skip', () => {
    expect(matchTemplate(R.lenderYouLockAccept, '0.005 WETH lent to someone else, now.')).toBeNull();
    // A full-row template is anchored at both ends.
    expect(matchTemplate(R.lenderYouLockAccept, '0.005 WETH lent to the borrower, now. And more.')).toBeNull();
  });

  it('escapes regex metacharacters in the literal text', () => {
    expect(templateRegex('a (b) {{x}}.').test('a (b) y.')).toBe(true);
    expect(templateRegex('a (b) {{x}}.').test('a b y.')).toBe(false);
  });
});

describe('reviewTerms — values at display precision', () => {
  it('matches amounts the way formatTokenAmount rounds them', () => {
    expect(parseAmount('0.005 WETH')).toEqual({ num: 0.005, symbol: 'WETH' });
    expect(amountMatches(0.005, 5_000_000_000_000_000n, 18)).toBe(true);
    // 0.005 WETH × 12% × 30d / 365 = 0.0000493150… → "0.00004932"
    expect(amountMatches(0.00004932, 49_315_068_493_150n, 18)).toBe(true);
    expect(amountMatches(0.00004931, 49_315_068_493_150n, 18)).toBe(false);
    expect(amountMatches(100, 100n * 10n ** 18n, 18)).toBe(true);
    expect(amountMatches(10, 100n * 10n ** 18n, 18)).toBe(false);
    expect(parseAmount('1,234.5 USDC')).toEqual({ num: 1234.5, symbol: 'USDC' });
    expect(parseAmount('lots of WETH')).toBeNull();
  });

  it('parses percents, lengths and grace windows', () => {
    expect(parsePercentBps('2%')).toBe(200);
    expect(percentMatches(parsePercentBps('2%'), 200)).toBe(true);
    expect(percentMatches(parsePercentBps('0.2%'), 20)).toBe(true);
    expect(percentMatches(parsePercentBps('2%'), 250)).toBe(false);
    expect(parseDurationDays('1 month', EN.units)).toBe(30);
    expect(parseDurationDays('29 days', EN.units)).toBe(29);
    expect(parseDurationDays('2 years', EN.units)).toBe(730);
    expect(parseDurationDays('a while', EN.units)).toBeNull();
    expect(parseGraceSeconds('3 days')).toBe(259_200n);
    expect(parseGraceSeconds('1 hour')).toBe(3_600n);
    expect(parseGraceSeconds('soon')).toBeNull();
  });
});

// The receipts the deployed app rendered for loan 22 → request #45 on
// 2026-10-05, row by row, exactly as captured.
const LENDER_ROWS = [
  ['You receive', 'Up to ~0.00004932 WETH interest if the borrower repays on time, plus your 0.005 WETH back. Interest is full-term: the whole term’s interest applies even if the loan is repaid early.'],
  ['You lock', '0.005 WETH lent to the borrower, now.'],
  ['You may owe', 'Nothing — the borrower owes you.'],
  ['You can lose', 'If the borrower defaults, your recovery depends on their collateral. They lock 100 tCOL. One side of this deal isn’t priced by the protocol — it has no usable market price or deep-enough trading market right now. If it ends in default, the entire collateral transfers directly to the lender — nobody sells it for a fair market price first, and there is no automatic price-based liquidation. Only proceed if you accept that.'],
  ['Fees', 'Vaipakam keeps 2% of the interest you earn.'],
  ['When this ends', 'Repayment is due within 1 month (grace period: 3 days). You then claim your funds.'],
].map(([label, value]) => ({ label, value }));
const LENDER_CTX = {
  en: EN,
  req: { amount: 5_000_000_000_000_000n, interestRateBpsMax: 1200n, durationDays: 30n, collateralAmount: 100n * 10n ** 18n },
  principal: { decimals: 18, symbol: 'WETH' },
  collateral: { decimals: 18, symbol: 'tCOL' },
  treasuryFeeBps: 200n,
  graceSeconds: 259_200n,
};

const LOAN22 = {
  principal: 5_000_000_000_000_000n,
  startTime: 1_790_964_520n,
  durationDays: 29n,
  interestRateBps: 1000n,
  interestAccrualStart: 1_790_964_520n,
  interestRemainingDays: 29,
};
const REVIEW_AT = 1_791_190_250n; // chain time of the 2026-10-05 review
const GRACE_END = 1_793_470_120n + 86_400n; // loan end + 1-day grace
const BORROWER_ROWS = [
  ['You receive', EN.refinance.receiptReceive],
  ['You lock', EN.refinance.receiptLock],
  ['You may owe', '~0.00504 WETH to pay off this loan, pulled automatically when a lender accepts. The old loan’s payoff is always the loan amount plus the full remaining term’s interest — even if interest on the loan normally builds up day by day. That is the exiting lender’s fixed entitlement on an early exit. If a lender accepts after the loan’s due date, the payoff grows — the late fee for being late plus interest that keeps building up — by up to ~0.00007637 WETH more for this request. The approval you grant covers that too, so a late acceptance can’t fail on it. The payoff is pulled from your wallet automatically at the moment a lender accepts. The new loan’s money arrives in the same transaction, so keep about 0.00004973 WETH spare in your wallet (the interest portion plus the new loan’s initiation fee) while the request is open.'],
  ['You can lose', EN.refinance.shortIsSafe],
  ['Fees', 'Vaipakam charges a 0.2% loan initiation fee on the borrowed amount. The protocol’s 2% cut of the payoff interest settles inside the payoff.'],
  ['When this ends', `When a lender accepts your request, when you cancel it, or when it expires with this loan’s grace window (Nov 1, 2026) — a refinance request can’t outlive the loan it replaces. ${EN.refinance.guardrailNote}`],
].map(([label, value]) => ({ label, value }));
function borrowerCtx(over = {}) {
  const payoffNow = refinancePayoffAt(LOAN22, REVIEW_AT);
  return {
    en: EN,
    principal: { decimals: 18, symbol: 'WETH' },
    payoffNow,
    headroom: refinancePayoffAt(LOAN22, GRACE_END) - payoffNow,
    topUp: payoffNow - LOAN22.principal + 10_000_000_000_000n,
    lifBps: 20,
    treasuryFeeBps: 200n,
    clamped: true,
    graceEndDates: [new Date(Number(GRACE_END) * 1000).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })],
    requestWindowDays: 30n,
    ...over,
  };
}

describe('reviewTerms — the real loan-22 receipts', () => {
  it('the lender review matches the request on chain, every term', () => {
    const r = compareLenderReceipt(LENDER_ROWS, LENDER_CTX);
    expect(r.mismatches).toEqual([]);
    expect(r.compared).toEqual([
      'interest (full term at the ceiling rate)',
      'principal returned',
      'principal lent',
      '"You may owe" text',
      'collateral',
      'yield fee (treasuryFeeBps)',
      'loan length',
      'grace window',
    ]);
  });

  it('the lender review is refused when a term differs from the chain', () => {
    // A request at 15% would carry a different interest figure.
    expect(compareLenderReceipt(LENDER_ROWS, { ...LENDER_CTX, req: { ...LENDER_CTX.req, interestRateBpsMax: 1500n } }).mismatches).toHaveLength(1);
    // A different yield fee, collateral amount, or length.
    expect(compareLenderReceipt(LENDER_ROWS, { ...LENDER_CTX, treasuryFeeBps: 100n }).mismatches).toHaveLength(1);
    expect(compareLenderReceipt(LENDER_ROWS, { ...LENDER_CTX, req: { ...LENDER_CTX.req, collateralAmount: 99n * 10n ** 18n } }).mismatches).toHaveLength(1);
    expect(compareLenderReceipt(LENDER_ROWS, { ...LENDER_CTX, req: { ...LENDER_CTX.req, durationDays: 31n } }).mismatches.length).toBeGreaterThan(0);
  });

  it('an unparseable or missing row is a mismatch, never a skip', () => {
    const tampered = LENDER_ROWS.map((r) => (r.label === 'You lock' ? { ...r, value: 'half of it, maybe' } : r));
    expect(compareLenderReceipt(tampered, LENDER_CTX).mismatches.join()).toMatch(/"You lock" row/);
    const missing = LENDER_ROWS.filter((r) => r.label !== 'Fees');
    expect(compareLenderReceipt(missing, LENDER_CTX).mismatches.join()).toMatch(/"Fees" row: shown null/);
  });

  it('the borrower review matches the app\u2019s own payoff formulas, every term', () => {
    const r = compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx());
    expect(r.mismatches).toEqual([]);
    expect(r.compared.length).toBe(8);
  });

  it('the borrower review is refused on a wrong payoff, fee or lifetime branch', () => {
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ payoffNow: 5_100_000_000_000_000n })).mismatches.length).toBeGreaterThan(0);
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ lifBps: 30 })).mismatches).toHaveLength(1);
    // Not clamped ⇒ the review should have said "30 days after posting".
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ clamped: false })).mismatches).toHaveLength(1);
    // No headroom ⇒ the late-fee disclosure must be absent.
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ headroom: 0n })).mismatches).toHaveLength(1);
  });
});

