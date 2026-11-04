/**
 * #1235/#1236 grace-window parity — the late-fee slope and the
 * refinance payoff/approval bounds, pinned against the contract's
 * `LibVaipakam.calculateLateFee` (1% + 0.5%/whole-day, cap 5%) and
 * the #1189 rule that preclose/refinance stay valid THROUGH the
 * grace window and charge the same fee repay does.
 */
import { describe, expect, it } from 'vitest';
import {
  lateFeeAt,
  loanEndTimeOf,
  offsetCompletionBoundOf,
  originalLoanEndTimeOf,
  pauseCreditOf,
  remainingInterestSecondsOf,
  refinanceApprovalOf,
  refinancePayoffOf,
  refinanceWalletPullOf,
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
  interestRemainingDays: 0,
  readAtTimestamp: 1_000n,
  // Never paused: every deadline is the original one.
  pauseLog: [] as LoanLive['pauseLog'],
} as LoanLive;

const endTime = loanEndTimeOf(live); // 1000 + 30d

describe('lateFeeAt', () => {
  it('is zero at and before maturity', () => {
    expect(lateFeeAt(live, endTime - 1n)).toBe(0n);
    expect(lateFeeAt(live, endTime)).toBe(0n);
  });

  it('charges the 1% base the first second past maturity', () => {
    expect(lateFeeAt(live, endTime + 1n)).toBe(
      (live.principal * 100n) / 10_000n,
    );
  });

  it('steps 0.5% per whole day late', () => {
    expect(lateFeeAt(live, endTime + 2n * DAY + 5n)).toBe(
      (live.principal * 200n) / 10_000n, // 1% + 2×0.5%
    );
  });

  it('caps at 5% of principal', () => {
    expect(lateFeeAt(live, endTime + 400n * DAY)).toBe(
      (live.principal * 500n) / 10_000n,
    );
  });
});

/** Interest on `days` whole days at the fixture's rate — the same
 *  pro-rata expression the contract uses. */
const interestFor = (days: bigint) =>
  (live.principal * live.interestRateBps * days) / (365n * 10_000n);

describe('refinancePayoffOf', () => {
  it('is principal + full-term remaining interest within term (floor binds)', () => {
    expect(refinancePayoffOf(live, live.startTime + DAY)).toBe(
      live.principal + interestFor(30n),
    );
  });

  it('keeps accruing interest past maturity AND adds the late fee', () => {
    // One day + 1s past maturity: elapsedDays = 31 > the 30-day floor
    // (settlementInterest's max(elapsed, remaining)), late fee =
    // 1% + 1×0.5%.
    expect(refinancePayoffOf(live, endTime + DAY + 1n)).toBe(
      live.principal + interestFor(31n) + (live.principal * 150n) / 10_000n,
    );
  });
});

describe('refinanceWalletPullOf', () => {
  // #3042 — the new principal less its initiation fee pays the old lender
  // inside the accept, so the wallet pays only the rest of the payoff.
  const lifBps = 20;
  const net = (amount: bigint) => amount - (amount * 20n) / 10_000n;

  it('is the payoff minus the net new principal (interest + initiation fee)', () => {
    const asOf = live.startTime + DAY;
    expect(
      refinanceWalletPullOf(
        live,
        { requestAmount: live.principal, loanInitiationFeeBps: lifBps },
        asOf,
      ),
    ).toBe(interestFor(30n) + (live.principal * 20n) / 10_000n);
    expect(
      refinanceWalletPullOf(
        live,
        { requestAmount: live.principal, loanInitiationFeeBps: lifBps },
        asOf,
      ),
    ).toBe(refinancePayoffOf(live, asOf) - net(live.principal));
  });

  it('grows when the request asks for less than the old principal', () => {
    const asOf = live.startTime + DAY;
    const half = live.principal / 2n;
    expect(
      refinanceWalletPullOf(
        live,
        { requestAmount: half, loanInitiationFeeBps: lifBps },
        asOf,
      ),
    ).toBe(refinancePayoffOf(live, asOf) - net(half));
  });
});

describe('refinanceApprovalOf', () => {
  const graceSeconds = 3n * DAY; // 30-day bucket
  const payoffInTerm = live.principal + interestFor(30n);

  it('carries no fee headroom when the request expires before maturity', () => {
    expect(
      refinanceApprovalOf(live, { expiresAt: endTime - DAY, graceSeconds }),
    ).toBe(payoffInTerm);
  });

  it('covers grace interest + fee at the grace end when the request outlives it', () => {
    // Last fillable moment = endTime + 3d → 33 elapsed days of
    // interest and a 1% + 3×0.5% = 2.5% fee.
    expect(
      refinanceApprovalOf(live, {
        expiresAt: endTime + 30n * DAY,
        graceSeconds,
      }),
    ).toBe(
      live.principal + interestFor(33n) + (live.principal * 250n) / 10_000n,
    );
  });

  it('covers the fee at expiry - 1 when the offer clock binds first', () => {
    // expiresAt one second past a whole late day: last fillable is
    // expiresAt - 1 = endTime + 1d exactly → 31 elapsed days,
    // daysLate = 1 → 1.5%.
    expect(
      refinanceApprovalOf(live, { expiresAt: endTime + DAY + 1n, graceSeconds }),
    ).toBe(
      live.principal + interestFor(31n) + (live.principal * 150n) / 10_000n,
    );
  });

  it('falls back to the grace end for a no-expiry offer', () => {
    expect(
      refinanceApprovalOf(live, { expiresAt: 0n, graceSeconds }),
    ).toBe(
      live.principal + interestFor(33n) + (live.principal * 250n) / 10_000n,
    );
  });
});

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
    interestRemainingDays: 30,
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
    interestRemainingDays: 30,
    readAtTimestamp: 1_000n + 10n * DAY,
    pauseLog: [{ start: 1_000n + 5n * DAY, end: 1_000n + 7n * DAY, pausedBefore: 0n }],
  } as LoanLive;

  it('moves the due date by the paused time since the start', () => {
    expect(originalLoanEndTimeOf(paused)).toBe(1_000n + 30n * DAY);
    expect(pauseCreditOf(paused)).toBe(2n * DAY);
    expect(loanEndTimeOf(paused)).toBe(1_000n + 32n * DAY);
  });

  it('charges no late fee for paused time', () => {
    // A day past the ORIGINAL due date is still inside the moved one.
    expect(lateFeeAt(paused, 1_000n + 31n * DAY)).toBe(0n);
    expect(lateFeeAt(paused, 1_000n + 32n * DAY + 1n)).toBe(
      (paused.principal * 100n) / 10_000n,
    );
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
