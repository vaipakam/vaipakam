/**
 * #2422 r7 — parsing a review receipt against its en.json templates. The
 * strings are the ones the deployed app rendered for loan 22 → request #45
 * on 2026-10-05, so a parser regression shows up against real output —
 * with every AMOUNT re-rendered by the app's own `formatTokenAmountExact`,
 * because #2537 made every receipt amount exact (the 2026-10-05 build still
 * rounded them). Rendering them through the app's formatter keeps the
 * fixtures from drifting from what the page prints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { formatTokenAmountExact } from '../../src/lib/format';
import { refinancePayoffAt } from './refinanceExpected.mjs';
import {
  amountMatches,
  compareBorrowerReceipt,
  exactUnits,
  compareLenderReceipt,
  matchTemplate,
  parseAmount,
  formatGraceSeconds,
  parseDurationDays,
  parsePercentBps,
  percentMatches,
  rowsLabelled,
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

const WETH = (raw) => `${formatTokenAmountExact(raw, 18)} WETH`;

describe('reviewTerms — values, exactly', () => {
  it('matches an amount only when it IS the on-chain amount, in base units', () => {
    expect(parseAmount('0.005 WETH')).toEqual({ text: '0.005', symbol: 'WETH' });
    expect(amountMatches('0.005', 5_000_000_000_000_000n, 18)).toBe(true);
    // 0.005 WETH × 12% × 30d / 365 = 49,315,068,493,150 wei, rendered whole.
    expect(amountMatches(parseAmount(WETH(49_315_068_493_150n)).text, 49_315_068_493_150n, 18)).toBe(true);
    // A rounded figure is a DIFFERENT amount now (#2537 renders exact ones).
    expect(amountMatches('0.00004932', 49_315_068_493_150n, 18)).toBe(false);
    expect(amountMatches('1.00004', 10n ** 18n, 18)).toBe(false);
    expect(amountMatches('1', 10n ** 18n + 1n, 18)).toBe(false);
    expect(amountMatches('1.000000000000000001', 10n ** 18n + 1n, 18)).toBe(true);
    expect(amountMatches('100', 100n * 10n ** 18n, 18)).toBe(true);
    expect(amountMatches('10', 100n * 10n ** 18n, 18)).toBe(false);
    // More decimals than the token has cannot be any on-chain amount.
    expect(exactUnits('0.1234567', 6)).toBeNull();
    expect(parseAmount('1,234.5 USDC')).toEqual({ text: '1234.5', symbol: 'USDC' });
    expect(parseAmount('12,34.5 USDC')).toBeNull();
    expect(parseAmount('~0.005 WETH')).toBeNull();
    expect(parseAmount('lots of WETH')).toBeNull();
  });

  it('parses percents and lengths', () => {
    expect(parsePercentBps('2%')).toBe(200);
    expect(percentMatches(parsePercentBps('2%'), 200)).toBe(true);
    expect(percentMatches(parsePercentBps('0.2%'), 20)).toBe(true);
    expect(percentMatches(parsePercentBps('2%'), 250)).toBe(false);
    expect(parseDurationDays('1 month', EN.units)).toBe(30);
    expect(parseDurationDays('29 days', EN.units)).toBe(29);
    expect(parseDurationDays('2 years', EN.units)).toBe(730);
    expect(parseDurationDays('a while', EN.units)).toBeNull();
  });

  // #2422 r8: a grace window is compared as the LABEL the app's
  // formatGraceSeconds renders for the configured seconds — the formatter
  // rounds, so parsing the label back to seconds is lossy.
  it('mirrors formatGraceSeconds, branch by branch', () => {
    expect(formatGraceSeconds(60n)).toBe('1 minutes');
    expect(formatGraceSeconds(20n)).toBe('1 minutes');
    expect(formatGraceSeconds(1_800n)).toBe('30 minutes');
    expect(formatGraceSeconds(3_600n)).toBe('1 hour');
    expect(formatGraceSeconds(3_700n)).toBe('1 hour');
    expect(formatGraceSeconds(7_200n)).toBe('2 hours');
    expect(formatGraceSeconds(86_400n)).toBe('1 day');
    expect(formatGraceSeconds(259_200n)).toBe('3 days');
    expect(formatGraceSeconds(604_800n)).toBe('1 week');
    expect(formatGraceSeconds(1_209_600n)).toBe('2 weeks');
    expect(formatGraceSeconds(2_592_000n)).toBe('30 days');
  });

  it('pins the mirror against the app formatter source', () => {
    // The mirror is a copy; this reads the app's own function body and
    // requires the same branch constants and labels, so the two cannot
    // drift silently.
    const src = fs.readFileSync(path.join(HERE, '../../src/lib/grace.ts'), 'utf8');
    const body = /export function formatGraceSeconds[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    for (const needle of ['s < 3_600', 'Math.max(1, Math.round(s / 60))', 's < 86_400', "'1 hour'", '`${h} hours`', 'Math.round(s / 86_400)', "'1 day'", 'days === 7', "'1 week'", 'days === 14', "'2 weeks'", '`${days} days`']) {
      expect(body, needle).toContain(needle);
    }
  });
});

// The receipts the deployed app rendered for loan 22 → request #45 on
// 2026-10-05, row by row — amounts re-rendered exactly (see the header).
const LENDER_ROWS = [
  ['You receive', `Up to ~${WETH(49_315_068_493_150n)} interest if the borrower repays on time, plus your 0.005 WETH back. Interest is full-term: the whole term’s interest applies even if the loan is repaid early.`],
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
const PAYOFF_NOW = refinancePayoffAt(LOAN22, REVIEW_AT);
const HEADROOM = refinancePayoffAt(LOAN22, GRACE_END) - PAYOFF_NOW;
const TOP_UP = PAYOFF_NOW - LOAN22.principal + 10_000_000_000_000n;
const BORROWER_ROWS = [
  ['You receive', EN.refinance.receiptReceive],
  ['You lock', EN.refinance.receiptLock],
  ['You may owe', `~${WETH(PAYOFF_NOW)} to pay off this loan, settled automatically when a lender accepts. The new loan’s money, less its initiation fee, goes straight to your current lender; only the rest comes from your wallet. The old loan’s payoff is always the loan amount plus the full remaining term’s interest — even if interest on the loan normally builds up day by day. That is the exiting lender’s fixed entitlement on an early exit. If a lender accepts after the loan’s due date, the payoff grows — the late fee for being late plus interest that keeps building up — by up to ~${WETH(HEADROOM)} more for this request. The approval you grant covers that too, so a late acceptance can’t fail on it. When a lender accepts, your wallet pays only what the new loan’s money does not cover: about ${WETH(TOP_UP)} (the interest portion plus the new loan’s initiation fee). Keep that much in your wallet while the request is open. The spending approval you grant is sized to that part, not to the whole payoff.`],
  ['You can lose', EN.refinance.shortIsSafe],
  ['Fees', 'Vaipakam charges a 0.2% loan initiation fee on the borrowed amount. The protocol’s 2% cut of the payoff interest settles inside the payoff.'],
  ['When this ends', `When a lender accepts your request, when you cancel it, or when it expires with this loan’s grace window (Nov 1, 2026) — a refinance request can’t outlive the loan it replaces. ${EN.refinance.guardrailNote}`],
].map(([label, value]) => ({ label, value }));
function borrowerCtx(over = {}) {
  return {
    en: EN,
    principal: { decimals: 18, symbol: 'WETH' },
    payoffNow: PAYOFF_NOW,
    headroom: HEADROOM,
    topUp: TOP_UP,
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

  // #2421 — that 2026-10-05 review funded a REFINANCE (request #45 for
  // loan 22, carry-over) and still said "They lock 100 tCOL". Against the
  // request as created, that wording is now a mismatch; the carry-over line
  // naming loan 22 is what passes.
  it('a refinance request is refused unless its review says the collateral carries over from the loan', () => {
    const refiCtx = {
      ...LENDER_CTX,
      req: { ...LENDER_CTX.req, refinanceTargetLoanId: 22n, refinanceCarryOver: true },
    };
    expect(compareLenderReceipt(LENDER_ROWS, refiCtx).mismatches.join()).toMatch(/"You can lose" row/);
    const lead = 'If the borrower defaults, your recovery depends on their collateral.';
    const fixed = LENDER_ROWS.map((r) =>
      r.label === 'You can lose'
        ? {
            ...r,
            value: r.value.replace(
              `${lead} They lock 100 tCOL.`,
              `${lead} Their 100 tCOL, already locked under loan #22, carries over to your loan — it is not a new pledge.`,
            ),
          }
        : r,
    );
    const ok = compareLenderReceipt(fixed, refiCtx);
    expect(ok.mismatches).toEqual([]);
    expect(ok.compared).toContain('refinanced loan');
    const wrongLoan = { ...refiCtx, req: { ...refiCtx.req, refinanceTargetLoanId: 23n } };
    expect(compareLenderReceipt(fixed, wrongLoan).mismatches.join()).toMatch(/refinanced loan/);
    const freshPledge = { ...refiCtx, req: { ...refiCtx.req, refinanceCarryOver: false } };
    expect(compareLenderReceipt(fixed, freshPledge).mismatches.join()).toMatch(/"You can lose" row/);
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
    expect(compareLenderReceipt(missing, LENDER_CTX).mismatches.join()).toMatch(/"Fees" row: shown \[\], expected exactly one row \(none rendered\)/);
  });

  // #2422 r8: a configured grace of 3,700 s renders "1 hour" (the app rounds);
  // the review that shows "1 hour" is the CORRECT review and must pass, and
  // one that shows "2 hours" must not.
  it('a rounded grace label passes when it is what the app renders for the configured seconds', () => {
    const at = (grace) => LENDER_ROWS.map((r) => (r.label === 'When this ends' ? { ...r, value: `Repayment is due within 1 month (grace period: ${grace}). You then claim your funds.` } : r));
    expect(compareLenderReceipt(at('1 hour'), { ...LENDER_CTX, graceSeconds: 3_700n }).mismatches).toEqual([]);
    expect(compareLenderReceipt(at('2 hours'), { ...LENDER_CTX, graceSeconds: 3_700n }).mismatches).toHaveLength(1);
    expect(compareLenderReceipt(LENDER_ROWS, { ...LENDER_CTX, graceSeconds: 86_400n }).mismatches.join()).toMatch(/grace window: shown "3 days", expected "1 day"/);
  });

  // #2422 r8: exactly one row per label — a duplicate row carrying a
  // different figure must not be ignored because the first one was right.
  it('requires exactly one receipt row per label: a duplicate is a mismatch even when the first is right', () => {
    expect(rowsLabelled(LENDER_ROWS, 'Fees')).toHaveLength(1);
    const dup = [...LENDER_ROWS, { label: 'Fees', value: 'Vaipakam keeps 9% of the interest you earn.' }];
    const r = compareLenderReceipt(dup, LENDER_CTX);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]).toMatch(/"Fees" row: .*expected exactly one row \(2 rendered\)/);
    // Even an identical duplicate is refused: the count is the rule.
    const same = [...LENDER_ROWS, LENDER_ROWS.at(-1)];
    expect(compareLenderReceipt(same, LENDER_CTX).mismatches.join()).toMatch(/"When this ends" row: .*2 rendered/);
    const bdup = [...BORROWER_ROWS, BORROWER_ROWS.at(2)];
    expect(compareBorrowerReceipt(bdup, borrowerCtx()).mismatches.join()).toMatch(/"You may owe" row: .*2 rendered/);
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

