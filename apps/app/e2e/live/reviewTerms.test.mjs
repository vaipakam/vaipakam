/**
 * #2422 r7 — parsing a review receipt against its en.json templates. The
 * strings are the ones the deployed app rendered for loan 22 → request #45
 * on 2026-10-05, so a parser regression shows up against real output —
 * with every AMOUNT re-rendered by the app's own `formatTokenAmountExact`,
 * because #2537 made every receipt amount exact (the 2026-10-05 build still
 * rounded them). Rendering them through the app's formatter keeps the
 * fixtures from drifting from what the page prints.
 *
 * The BORROWER's review is the permit-route review (#1558 / #3042, #3295):
 * the 2026-10-05 build reviewed an approval of the Diamond, which the
 * deployed app no longer asks for, so that review is kept only as the
 * retired text the parser must now refuse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { formatTokenAmountExact } from '../../src/lib/format';
import { refinancePayoffAt } from './refinanceExpected.mjs';
import {
  amountMatches,
  amountWithin,
  bracketOf,
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
};
const REVIEW_AT = 1_791_190_250n; // chain time of the 2026-10-05 review
const GRACE_END = 1_793_470_120n + 86_400n; // loan end + 1-day grace
// #3295 — the permit route's figures, as `getRefinancePayoff` reports them
// (the loan-22 numbers: the payoff today, its growth to the grace end, the
// wallet share today — interest plus the 0.2% LIF — and the share at the
// request's last fillable moment, which the permit is signed for).
const PAYOFF_NOW = refinancePayoffAt(LOAN22, REVIEW_AT);
const HEADROOM = refinancePayoffAt(LOAN22, GRACE_END) - PAYOFF_NOW;
const TOP_UP = PAYOFF_NOW - LOAN22.principal + 10_000_000_000_000n;
const BOUND = TOP_UP + HEADROOM;
/** The "You may owe" row the deployed permit-route review renders
 *  (RefinanceFlow: receiptYouMayOwe, payoffNote, permit.growthDisclosure,
 *  permit.signDisclosure, permit.permit2ApprovalNote, walletNote). */
const permitOwe = ({ headroom = HEADROOM, bound = BOUND } = {}) =>
  `~${WETH(PAYOFF_NOW)} to pay off this loan, settled automatically when a lender accepts. The new loan’s money, less its initiation fee, covers most of it; the rest comes from your wallet. The old loan’s payoff is always the loan amount plus the full remaining term’s interest — even if interest on the loan normally builds up day by day. That is the exiting lender’s fixed entitlement on an early exit. ` +
  (headroom > 0n
    ? `If a lender accepts after the loan’s due date, the payoff grows (the late fee plus interest that keeps building up) by up to ~${WETH(headroom)} more for this request. The permit covers that too, so a late acceptance can’t fail on it. `
    : '') +
  (bound > 0n
    ? `You’ll sign a payoff permit for at most ${WETH(bound)}: your wallet’s share of the payoff if a lender accepts at the last moment this request allows. The new loan’s money, less its initiation fee, pays the rest of the payoff straight to your current lender. Whoever completes the refinance can use the permit once, only for your share at that moment, so the rest of it is never taken. It lapses when the request ends, and nothing stays approved to the protocol. If your wallet hasn’t approved Permit2 (Uniswap’s permit contract) for this token for at least that amount, you approve it first. That approval moves nothing on its own: Permit2 pays only against a signature you make. `
    : '') +
  `When a lender accepts, the new loan’s money, less its initiation fee, covers most of the payoff in the same transaction, so keep about ${WETH(TOP_UP)} in your wallet (the interest portion plus the new loan’s initiation fee) while the request is open.`;
/** The wallet-steps note the deployed card shows below the receipt. */
const PERMIT_STEPS =
  'Posting takes up to five wallet steps: the guardrails, the Permit2 approval if needed, the request, your signature on the payoff permit, and the transaction that attaches it. If you stop after the request is posted, it stays open without a permit and no lender can complete it; sign the permit from the request’s card, or cancel the request.';
/** The retired approval-route review (the 2026-10-05 build). */
const RETIRED_OWE = `~${WETH(PAYOFF_NOW)} to pay off this loan, settled automatically when a lender accepts. The new loan’s money, less its initiation fee, covers most of it; the rest comes from your wallet. The old loan’s payoff is always the loan amount plus the full remaining term’s interest — even if interest on the loan normally builds up day by day. That is the exiting lender’s fixed entitlement on an early exit. If a lender accepts after the loan’s due date, the payoff grows — the late fee for being late plus interest that keeps building up — by up to ~${WETH(HEADROOM)} more for this request. The approval you grant covers that too, so a late acceptance can’t fail on it. When a lender accepts, the new loan’s money, less its initiation fee, covers most of the payoff in the same transaction, so keep about ${WETH(TOP_UP)} in your wallet (the interest portion plus the new loan’s initiation fee) while the request is open.`;
const RETIRED_STEPS =
  'Posting takes up to three wallet confirmations (guardrails, payoff approval, the request itself). If you stop partway, the earlier steps stay in place on-chain until you finish posting or cancel — cancelling also removes the approval.';
const borrowerRows = (owe) => [
  ['You receive', EN.refinance.receiptReceive],
  ['You lock', EN.refinance.receiptLock],
  ['You may owe', owe],
  ['You can lose', EN.refinance.shortIsSafe],
  ['Fees', 'Vaipakam charges a 0.2% loan initiation fee on the borrowed amount. The protocol’s 2% cut of the payoff interest settles inside the payoff.'],
  ['When this ends', `When a lender accepts your request, when you cancel it, or when it expires with this loan’s grace window (Nov 1, 2026) — a refinance request can’t outlive the loan it replaces. ${EN.refinance.guardrailNote}`],
].map(([label, value]) => ({ label, value }));
const BORROWER_ROWS = borrowerRows(permitOwe());
function borrowerCtx(over = {}) {
  return {
    en: EN,
    principal: { decimals: 18, symbol: 'WETH' },
    payoffNow: PAYOFF_NOW,
    headroom: HEADROOM,
    topUp: TOP_UP,
    bound: BOUND,
    lifBps: 20,
    treasuryFeeBps: 200n,
    clamped: true,
    graceEndDates: [new Date(Number(GRACE_END) * 1000).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })],
    requestWindowDays: 30n,
    cardText: `Review refinance request ${PERMIT_STEPS} Confirm — post refinance request`,
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

  it('the borrower review matches the contract\u2019s payoff figures, every term (permit route, #3295)', () => {
    const r = compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx());
    expect(r.mismatches).toEqual([]);
    expect(r.compared).toEqual([
      '"You receive" text',
      '"You lock" text',
      'payoff (today)',
      'payoff growth before the last fillable moment',
      'no approval-route disclosure',
      'payoff permit maximum (wallet share at the last fillable moment)',
      'Permit2 approval note',
      'wallet top-up (payoff interest + LIF)',
      'loan initiation fee (live LIF)',
      'treasury cut (treasuryFeeBps)',
      'request lifetime',
      'wallet-steps note',
    ]);
  });

  // #3295 — the live run halted here: the parser still expected the
  // approval route's "The approval you grant covers that too". That review
  // is now itself a mismatch, and so is its three-confirmation note.
  it('refuses the retired approval-route review and its steps note', () => {
    const old = compareBorrowerReceipt(borrowerRows(RETIRED_OWE), borrowerCtx({ cardText: RETIRED_STEPS })).mismatches.join(' | ');
    expect(old).toMatch(/payoff-growth disclosure/);
    expect(old).toMatch(/approval-route disclosure/);
    expect(old).toMatch(/payoff-permit disclosure/);
    expect(old).toMatch(/wallet-steps note/);
    // The permit review with the retired steps note alongside is refused too.
    const both = compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ cardText: `${PERMIT_STEPS} ${RETIRED_STEPS}` }));
    expect(both.mismatches).toHaveLength(1);
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ cardText: undefined })).mismatches).toHaveLength(1);
  });

  it('pins the permit\u2019s maximum and its presence to the wallet share', () => {
    // A permit disclosed for a different maximum than the contract's share.
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ bound: BOUND + 1n })).mismatches.join()).toMatch(/payoff permit maximum/);
    // A zero share: no permit is signed, so none may be disclosed…
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ bound: 0n })).mismatches.join()).toMatch(/payoff-permit disclosure/);
    // …and the review without one passes.
    expect(compareBorrowerReceipt(borrowerRows(permitOwe({ bound: 0n })), borrowerCtx({ bound: 0n })).mismatches).toEqual([]);
    // A share above zero with the disclosure missing is refused.
    expect(compareBorrowerReceipt(borrowerRows(permitOwe({ bound: 0n })), borrowerCtx()).mismatches.join()).toMatch(/payoff-permit disclosure/);
  });

  it('the borrower review is refused on a wrong payoff, fee or lifetime branch', () => {
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ payoffNow: 5_100_000_000_000_000n })).mismatches.length).toBeGreaterThan(0);
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ lifBps: 30 })).mismatches).toHaveLength(1);
    // Not clamped ⇒ the review should have said "30 days after posting".
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ clamped: false })).mismatches).toHaveLength(1);
    // No headroom ⇒ the growth disclosure must be absent, and a review
    // without one passes.
    expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ headroom: 0n })).mismatches).toHaveLength(1);
    expect(compareBorrowerReceipt(borrowerRows(permitOwe({ headroom: 0n })), borrowerCtx({ headroom: 0n })).mismatches).toEqual([]);
  });

  // #3302 — the live run on loan 3 halted here: the page computed its
  // figures from its own (earlier) chain time, the drive from a later read,
  // and the share at the later deadline was 3,805,175 wei higher. The
  // review's amounts are now BRACKETED by the figure at a block before the
  // page loaded and one after the rows were read; no tolerance is added.
  describe('the review bracket (#3302)', () => {
    const LO = 2_027_362_379_502n; // loan 3: what the page showed
    const HI = 2_027_366_184_677n; // loan 3: the drive's later read
    it('bracketOf orders its ends, and a bigint is the exact bracket', () => {
      expect(bracketOf(HI, LO)).toEqual({ lo: LO, hi: HI });
      expect(bracketOf(LO)).toEqual({ lo: LO, hi: LO });
      expect(bracketOf({ lo: HI, hi: LO })).toEqual({ lo: LO, hi: HI });
    });
    it('accepts a figure inside the bracket, ends included, and refuses one below or above', () => {
      expect(amountWithin('0.000002027362379502', { lo: LO, hi: HI }, 18)).toBe(true);
      expect(amountWithin('0.000002027366184677', { lo: LO, hi: HI }, 18)).toBe(true);
      expect(amountWithin('0.000002027364', { lo: LO, hi: HI }, 18)).toBe(true);
      expect(amountWithin('0.000002027362379501', { lo: LO, hi: HI }, 18)).toBe(false);
      expect(amountWithin('0.000002027366184678', { lo: LO, hi: HI }, 18)).toBe(false);
      // The exact (degenerate) bracket is exactly `amountMatches`.
      expect(amountWithin('0.000002027362379502', LO, 18)).toBe(true);
      expect(amountWithin('0.000002027366184677', LO, 18)).toBe(false);
    });
    const span = (v, below, above) => ({ lo: v - below, hi: v + above });
    it('the borrower review passes when every figure lies in its bracket', () => {
      const ctx = borrowerCtx({
        payoffNow: span(PAYOFF_NOW, 0n, 0n),
        headroom: span(HEADROOM, 5n, 3_805_175n),
        topUp: span(TOP_UP, 0n, 7n),
        bound: span(BOUND, 2n, 3_805_175n),
      });
      expect(compareBorrowerReceipt(BORROWER_ROWS, ctx).mismatches).toEqual([]);
    });
    it('refuses a permit maximum or growth figure below or above its bracket', () => {
      const below = compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ bound: span(BOUND + 1n, 0n, 3_805_175n) })).mismatches;
      expect(below).toHaveLength(1);
      expect(below[0]).toMatch(/payoff permit maximum.*expected between/);
      const above = compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ bound: span(BOUND - 3_805_175n, 0n, 3_805_174n) })).mismatches;
      expect(above).toHaveLength(1);
      expect(above[0]).toMatch(/payoff permit maximum/);
      expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ headroom: span(HEADROOM + 1n, 0n, 9n) })).mismatches.join()).toMatch(/payoff growth/);
      expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ headroom: span(HEADROOM - 10n, 0n, 9n) })).mismatches.join()).toMatch(/payoff growth/);
      expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ topUp: span(TOP_UP + 1n, 0n, 1n) })).mismatches.join()).toMatch(/wallet top-up/);
    });
    it('a disclosure is required when the whole bracket is above zero, refused when it is zero, and either when it straddles zero', () => {
      const noGrowth = borrowerRows(permitOwe({ headroom: 0n }));
      expect(compareBorrowerReceipt(noGrowth, borrowerCtx({ headroom: { lo: 1n, hi: HEADROOM } })).mismatches.join()).toMatch(/payoff-growth disclosure/);
      expect(compareBorrowerReceipt(noGrowth, borrowerCtx({ headroom: { lo: 0n, hi: HEADROOM } })).mismatches).toEqual([]);
      expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ headroom: { lo: 0n, hi: HEADROOM } })).mismatches).toEqual([]);
      expect(compareBorrowerReceipt(BORROWER_ROWS, borrowerCtx({ headroom: { lo: 0n, hi: 0n } })).mismatches.join()).toMatch(/payoff-growth disclosure/);
    });
  });
});
