/**
 * The app-side loan mirrors: the seller's sale economics and the loan
 * clock. (The refinance payoff mirror and its late-fee slope were removed
 * with the approval route, #3074: the payoff comes from the contract.)
 */
import { describe, expect, it } from 'vitest';
import {
  graceEndOf,
  loanEndTimeOf,
  verifiablyPastGrace,
  offsetCompletionBoundOf,
  originalLoanEndTimeOf,
  pauseCreditOf,
  remainingInterestSecondsOf,
  SellerQuoteUnavailableError,
  sellerEconomics,
  type LoanLive,
} from './loanLive';

const DAY = 86_400n;

/** A 30-day 10% loan on 1,000e18 principal starting at t=1000. */
const live = {
  principal: 1_000n * 10n ** 18n,
  interestRateBps: 1_000n,
  startTime: 1_000n,
  durationDays: 30n,
  interestAccrualStart: 0n,
  readAtTimestamp: 1_000n,
  // Never paused: every deadline is the original one.
  pauseLog: [] as LoanLive['pauseLog'],
} as LoanLive;

/**
 * #1503 item 28 — the seller's forfeiture measures the stretch the lender has
 * NOT been paid for. These pin the mirror against
 * `EarlyWithdrawalDirectFacet` / `EarlyWithdrawalFacet`, whose forfeiture runs
 * from the paid-through mark, falling back to the interest-accrual origin only
 * for a lender who has never been paid.
 */
describe('sellerEconomics — forfeiture window (#1503 item 28)', () => {
  /** A 30-day 10% loan on 1,000e18, accrual clock starting at t=1000. */
  const saleLive = {
    principal: 1_000n * 10n ** 18n,
    interestRateBps: 1_000n,
    startTime: 1_000n,
    durationDays: 30n,
    interestAccrualStart: 1_000n,
    // The seller clock lives on the SNAPSHOT since #1801 r9 — callers cannot
    // supply their own, so the fixture carries the block it was read at.
    readAtTimestamp: 1_000n + 10n * DAY,
    pauseLog: [] as LoanLive['pauseLog'],
  } as LoanLive;

  /** Interest over `secs` at the loan's own rate, seconds-precision. */
  const accrue = (secs: bigint) =>
    (saleLive.principal * saleLive.interestRateBps * secs) /
    (365n * DAY * 10_000n);

  it('REFUSES to quote when the interest ledger read is unavailable', () => {
    // An unknown ledger has no safe substitute (#1801 r8): a Diamond without it
    // still charges the retired forfeiture, which this client does not model.
    expect(() => sellerEconomics(saleLive, saleLive.interestRateBps)).toThrow(
      SellerQuoteUnavailableError,
    );
  });

  it('charges the seller nothing at the loan own rate, and reports the claim (#1209)', () => {
    const earned = accrue(10n * DAY);
    const sale = { ...saleLive, sellerClaimOnSale: earned };
    const econ = sellerEconomics(sale, sale.interestRateBps);
    expect(econ.cost).toBe(0n);
    expect(econ.toSeller).toBe(sale.principal);
    expect(econ.shortfallBinding).toBe(false);
    expect(econ.claim).toBe(earned);
  });

  it('charges only the rate shortfall above the loan own rate', () => {
    const sale = { ...saleLive, sellerClaimOnSale: accrue(10n * DAY) };
    const econ = sellerEconomics(sale, 2_000n);
    const remaining = 20n * DAY;
    const expected =
      (sale.principal * 2_000n * remaining) / (365n * DAY * 10_000n) -
      (sale.principal * sale.interestRateBps * remaining) / (365n * DAY * 10_000n);
    expect(econ.shortfall).toBe(expected);
    expect(econ.cost).toBe(expected);
    expect(econ.toSeller).toBe(sale.principal - expected);
    expect(econ.shortfallBinding).toBe(true);
  });
});

describe('the loan clock (#2808, D2 #668 / #935)', () => {
  /** A two-day pause on day 5 of the fixture loan, long over. */
  const paused = {
    ...live,
    interestAccrualStart: 1_000n,
    readAtTimestamp: 1_000n + 10n * DAY,
    pauseLog: [{ start: 1_000n + 5n * DAY, end: 1_000n + 7n * DAY, pausedBefore: 0n }],
  } as LoanLive;

  it('moves the due date by the paused time since the start', () => {
    expect(originalLoanEndTimeOf(paused)).toBe(1_000n + 30n * DAY);
    expect(pauseCreditOf(paused)).toBe(2n * DAY);
    expect(loanEndTimeOf(paused)).toBe(1_000n + 32n * DAY);
  });

  it('counts a pause still in force up to the moment asked about', () => {
    const open = {
      ...paused,
      pauseLog: [{ start: 1_000n + 5n * DAY, end: 2n ** 64n - 1n, pausedBefore: 0n }],
    } as LoanLive;
    expect(loanEndTimeOf(open, 1_000n + 6n * DAY)).toBe(1_000n + 31n * DAY);
    expect(loanEndTimeOf(open, 1_000n + 9n * DAY)).toBe(1_000n + 34n * DAY);
  });

  it('runs the remaining interest term to the pause-moved end', () => {
    // Ten days in, two of them paused: 30 - 10 + 2 = 22 days left.
    expect(remainingInterestSecondsOf(paused, paused.readAtTimestamp)).toBe(22n * DAY);
    expect(remainingInterestSecondsOf(live, 1_000n)).toBe(30n * DAY);
  });

  it('widens the offset completion bound by the paused time', () => {
    const rate = (secs: bigint) =>
      (paused.principal * paused.interestRateBps * secs) / (365n * DAY * 10_000n);
    expect(offsetCompletionBoundOf(paused)).toBe(paused.principal + rate(32n * DAY));
    // Never paused: the committed term exactly, as before.
    expect(offsetCompletionBoundOf({ ...paused, pauseLog: [] } as LoanLive)).toBe(
      paused.principal + rate(30n * DAY),
    );
  });
});

describe('graceEndOf / verifiablyPastGrace (#3410, #3525)', () => {
  const end = 1_000n + 30n * DAY;
  const GRACE = 3n * DAY;
  it('moves a grace end inside the outage window to its end, never the due date', () => {
    const w = { downAt: end + GRACE - 10n, windowEnd: end + GRACE + 3_600n };
    const g = graceEndOf({ ...live, outage: w }, GRACE, end + GRACE);
    expect(g).toEqual({ graceEnd: end + GRACE + 3_600n, movedByOutage: true, outageKnown: true });
    expect(loanEndTimeOf({ ...live, outage: w }, end + GRACE)).toBe(end);
    // Past the unmoved end but inside the window: not past grace.
    expect(verifiablyPastGrace({ ...live, outage: w }, GRACE, end + GRACE + 60n)).toBe(false);
    expect(verifiablyPastGrace({ ...live, outage: w }, GRACE, end + GRACE + 3_601n)).toBe(true);
  });
  it('never calls the grace period over while the window is unread', () => {
    const g = graceEndOf(live, GRACE, end + GRACE + DAY);
    expect(g).toEqual({ graceEnd: end + GRACE, movedByOutage: false, outageKnown: false });
    expect(verifiablyPastGrace(live, GRACE, end + GRACE + DAY)).toBe(false);
    const none = { ...live, outage: { downAt: 0n, windowEnd: 0n } };
    expect(verifiablyPastGrace(none, GRACE, end + GRACE + 1n)).toBe(true);
    expect(verifiablyPastGrace(none, GRACE, end + GRACE)).toBe(false);
  });
});
