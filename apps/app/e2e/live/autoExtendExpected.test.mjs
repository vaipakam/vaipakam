import { describe, expect, it } from 'vitest';
import { structMismatches } from './expectedPayload.mjs';
import { createWritePlan } from './writePlan.mjs';
import {
  MAX_INTEREST_BPS,
  autoExtendPlanSteps,
  capsMismatches,
  expectedCapsCall,
  fill,
  formatBpsAsPercent,
  formatTokenAmount,
  formatTokenAmountExact,
  fundedRowFor,
  reserveFigureMismatches,
} from './autoExtendExpected.mjs';

const DIAMOND = '0x63816B149266C9dBFB7683dfd02D851915238049';
const WETH = '0x4200000000000000000000000000000000000006';
const B = '0xC86BB89f8ddF703c34724Cf11137498bC69F039D';
const L = '0x648897f2c549956eFfF626D57fBc3E39761e6792';
const AMOUNT = 10n ** 13n;

const tx = (from, to, functionName, args) => ({ from, to, data: { functionName, args }, value: 0n, chainId: 84532 });

describe('expectedCapsCall mirrors capsArgs', () => {
  it('bounds the borrower from above and leaves the floor open', () => {
    expect(expectedCapsCall({ side: 'borrower', loanId: 1, rateBps: 1200, latestEnd: 99 })).toEqual({
      functionName: 'setAutoExtendBorrowerCaps',
      args: { loanId: 1n, enabled: true, minRateBps: 0, maxRateBps: 1200, maxNewExpiry: 99n },
    });
  });
  it('bounds the lender from below and leaves the ceiling at the protocol maximum', () => {
    expect(expectedCapsCall({ side: 'lender', loanId: 1, rateBps: 800, latestEnd: 99 }).args).toEqual({
      loanId: 1n,
      enabled: true,
      minRateBps: 800,
      maxRateBps: MAX_INTEREST_BPS,
      maxNewExpiry: 99n,
    });
  });
  it('refuses an unknown side', () => {
    expect(() => expectedCapsCall({ side: 'keeper', loanId: 1, rateBps: 1, latestEnd: 1 })).toThrow();
  });
});

describe('capsMismatches', () => {
  const want = { side: 'borrower', rateBps: 1200, latestEnd: 99, setter: B };
  it('accepts the getter answer for exactly those limits from that setter', () => {
    expect(capsMismatches(want, { enabled: true, minRateBps: 0, maxRateBps: 1200, maxNewExpiry: 99n, setter: B.toLowerCase() })).toEqual([]);
  });
  it('names every field that differs, the setter included', () => {
    const bad = capsMismatches(want, { enabled: false, minRateBps: 0, maxRateBps: 1100, maxNewExpiry: 98n, setter: L });
    expect(bad.map((l) => l.split(' ')[0])).toEqual(['enabled', 'maxRateBps', 'maxNewExpiry', 'setter']);
  });
});

describe('the ordered plan', () => {
  const steps = () =>
    autoExtendPlanSteps({
      borrower: B,
      lender: L,
      diamond: DIAMOND,
      asset: WETH,
      loanId: 1,
      amount: AMOUNT,
      chainId: 84532,
      borrowerCaps: { rateBps: 1200, latestEnd: 99 },
      lenderCaps: { rateBps: 800, latestEnd: 88 },
    });
  /** The plan from the first deposit on: the two limits steps left out. */
  const reserveSteps = () => steps().filter((s) => !s.id.endsWith('-caps'));
  const caps = (who, fn, rate, end) =>
    tx(who, DIAMOND, fn, {
      loanId: 1n,
      enabled: true,
      minRateBps: fn.includes('Borrower') ? 0 : rate,
      maxRateBps: fn.includes('Borrower') ? rate : MAX_INTEREST_BPS,
      maxNewExpiry: end,
    });

  it('allows the whole drive in order, skipping approvals the allowance does not need', () => {
    const plan = createWritePlan(steps());
    plan.arm('borrower');
    expect(plan.offer('borrower', 'tx', caps(B, 'setAutoExtendBorrowerCaps', 1200, 99n)).ok).toBe(true);
    plan.arm('lender');
    expect(plan.offer('lender', 'tx', caps(L, 'setAutoExtendLenderCaps', 800, 88n)).ok).toBe(true);
    plan.arm('borrower');
    expect(plan.offer('borrower', 'tx', tx(B, WETH, 'approve', { spender: DIAMOND, amount: AMOUNT })).ok).toBe(true);
    expect(plan.offer('borrower', 'tx', tx(B, DIAMOND, 'fundExtendReserve', { loanId: 1n, amount: AMOUNT })).ok).toBe(true);
    expect(plan.offer('borrower', 'tx', tx(B, DIAMOND, 'withdrawExtendReserve', { account: B, loanId: 1n, amount: AMOUNT })).ok).toBe(true);
    // The second deposit with no approval (an allowance already covering it).
    expect(plan.offer('borrower', 'tx', tx(B, DIAMOND, 'fundExtendReserve', { loanId: 1n, amount: AMOUNT })).ok).toBe(true);
    expect(plan.offer('borrower', 'tx', tx(B, DIAMOND, 'withdrawExtendReserve', { account: B, loanId: 1n, amount: AMOUNT })).ok).toBe(true);
    expect(plan.complete()).toBe(true);
    expect(plan.steps().filter((s) => s.status === 'skipped').map((s) => s.id)).toEqual(['b-approve-reset', 'b-approve-reset-2', 'b-approve-set-2']);
  });

  it('refuses limits other than the ones typed, and latches', () => {
    const plan = createWritePlan(steps());
    plan.arm('borrower');
    const v = plan.offer('borrower', 'tx', caps(B, 'setAutoExtendBorrowerCaps', 1300, 99n));
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/maxRateBps/);
    expect(plan.offer('borrower', 'tx', caps(B, 'setAutoExtendBorrowerCaps', 1200, 99n)).ok).toBe(false);
  });

  it('refuses an approval above the deposit, and a deposit of another amount', () => {
    const over = createWritePlan(reserveSteps());
    over.arm('borrower');
    expect(over.offer('borrower', 'tx', tx(B, WETH, 'approve', { spender: DIAMOND, amount: AMOUNT + 1n })).ok).toBe(false);
    const other = createWritePlan(reserveSteps());
    other.arm('borrower');
    expect(other.offer('borrower', 'tx', tx(B, DIAMOND, 'fundExtendReserve', { loanId: 1n, amount: AMOUNT * 2n })).ok).toBe(false);
  });

  it('refuses a withdrawal for another account or of a different amount', () => {
    const w = steps().find((s) => s.id === 'b-withdraw');
    expect(structMismatches(w.expected, tx(B, DIAMOND, 'withdrawExtendReserve', { account: L, loanId: 1n, amount: AMOUNT }))).not.toEqual([]);
    expect(structMismatches(w.expected, tx(B, DIAMOND, 'withdrawExtendReserve', { account: B, loanId: 1n, amount: 1n }))).not.toEqual([]);
    expect(structMismatches(w.expected, tx(B, DIAMOND, 'withdrawExtendReserve', { account: B, loanId: 1n, amount: AMOUNT }))).toEqual([]);
  });

  it('refuses a reset that is not followed by its set', () => {
    const plan = createWritePlan(reserveSteps());
    plan.arm('borrower');
    expect(plan.offer('borrower', 'tx', tx(B, WETH, 'approve', { spender: DIAMOND, amount: 0n })).ok).toBe(true);
    expect(plan.offer('borrower', 'tx', tx(B, DIAMOND, 'fundExtendReserve', { loanId: 1n, amount: AMOUNT })).ok).toBe(false);
  });
});

describe('the app formatting, mirrored', () => {
  it('formats percentages and amounts as src/lib/format.ts does', () => {
    expect(formatBpsAsPercent(1200)).toBe('12%');
    expect(formatBpsAsPercent(825)).toBe('8.25%');
    expect(formatTokenAmount(0n, 18)).toBe('0');
    expect(formatTokenAmount(821917808219n, 18)).toBe('0.0000008219');
    expect(formatTokenAmount(12345n * 10n ** 14n, 18)).toBe('1.2345');
    expect(formatTokenAmountExact(10n ** 13n, 18)).toBe('0.00001');
    expect(formatTokenAmountExact(1234n * 10n ** 18n, 18)).toBe('1,234');
  });
  it('fills templates and refuses a missing value', () => {
    expect(fill('From {{min}} to {{ max }}.', { min: 'a', max: 'b' })).toBe('From a to b.');
    expect(() => fill('{{x}}', {})).toThrow(/"x" missing/);
  });
});

describe('reserveFigureMismatches', () => {
  const T = { reserved: 'Reserved: {{amount}}', otherFree: 'Other: {{amount}}', chargeNow: 'Now: {{amount}}', chargeAtEnd: 'End: {{amount}}' };
  const lines = ['Reserved: 0 WETH', 'Other: 0 WETH', 'Now: 0.0000008219 WETH', 'End: 0.000003322 WETH'];
  const ok = { reserved: [0n, 0n], otherFree: [0n, 0n], chargeNow: [821917808219n, 821990000000n], chargeAtEnd: [3321917808219n, 3321917808219n] };
  it('passes when each line matches a bracketing chain value', () => {
    expect(reserveFigureMismatches(lines, T, ok, 18, 'WETH')).toEqual([]);
  });
  it('passes a charge the page read between the two chain reads', () => {
    // The page polls on its own clock: its read can land strictly inside the
    // bracket, so its rounded figure need equal neither end.
    const inside = { ...ok, chargeNow: [821000000000n, 823000000000n] };
    expect(reserveFigureMismatches(lines, T, inside, 18, 'WETH')).toEqual([]);
  });
  it('names a line outside its bracket', () => {
    const bad = reserveFigureMismatches(lines, T, { ...ok, reserved: [10n ** 13n, 10n ** 13n] }, 18, 'WETH');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^reserved:/);
  });
  it('requires a "now" charge to be absent when its bound is null, and names one that is listed', () => {
    const noNow = lines.filter((l) => !l.startsWith('Now:'));
    expect(reserveFigureMismatches(noNow, T, { ...ok, chargeNow: null }, 18, 'WETH')).toEqual([]);
    const bad = reserveFigureMismatches(lines, T, { ...ok, chargeNow: null }, 18, 'WETH');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^chargeNow: must not be listed/);
  });
  it('names a missing line', () => {
    // not-a-source-region: drops the first ROW of a fixture array
    const bad = reserveFigureMismatches(lines.slice(1), T, ok, 18, 'WETH');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^reserved:/);
  });
});

describe('fundedRowFor', () => {
  const row = { kind: 'ExtendReserveFunded', loanId: 1, txHash: '0xAB', actor: B.toLowerCase() };
  it('finds the deposit by kind, loan, transaction and depositor', () => {
    expect(fundedRowFor([row], { loanId: 1, txHash: '0xab', holder: B })).toBe(row);
  });
  it('ignores another loan, transaction, depositor or kind', () => {
    expect(fundedRowFor([{ ...row, loanId: 2 }], { loanId: 1, txHash: '0xab', holder: B })).toBe(null);
    expect(fundedRowFor([{ ...row, txHash: '0xcd' }], { loanId: 1, txHash: '0xab', holder: B })).toBe(null);
    expect(fundedRowFor([{ ...row, actor: L }], { loanId: 1, txHash: '0xab', holder: B })).toBe(null);
    expect(fundedRowFor([{ ...row, kind: 'ExtendReserveWithdrawn' }], { loanId: 1, txHash: '0xab', holder: B })).toBe(null);
    expect(fundedRowFor(null, { loanId: 1, txHash: '0xab', holder: B })).toBe(null);
  });
});
