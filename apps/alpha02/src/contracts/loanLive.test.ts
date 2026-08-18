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
  refinanceApprovalOf,
  refinancePayoffOf,
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
  } as LoanLive;

  const now = 1_000n + 10n * DAY; // ten days in
  /** Interest over `secs` at the loan's own rate, seconds-precision. */
  const accrue = (secs: bigint) =>
    (saleLive.principal * saleLive.interestRateBps * secs) /
    (365n * DAY * 10_000n);

  it('REFUSES to quote when the window read is unavailable', () => {
    // This asserted the opposite until #1801 r8, and the correction is the point.
    // The old fallback quoted from the accrual origin on the reasoning that it is
    // the conservative answer. It is not always: a valid mark can PRECEDE the
    // origin (the preclose path re-origins the accrual clock without clearing an
    // older mark), so the contract could charge from the earlier mark while this
    // quoted only from the later clock — understating the seller's cost on a
    // transient RPC failure. An unknown window has no safe substitute.
    expect(() => sellerEconomics(saleLive, saleLive.interestRateBps, now)).toThrow(
      SellerQuoteUnavailableError,
    );
  });

  it('forfeits the whole elapsed stretch when the window IS the accrual origin', () => {
    // The contract resolves "this lender has never been paid" to the accrual
    // origin itself, so that arrives as a real value rather than as an absence.
    const fresh = { ...saleLive, lenderForfeitFrom: saleLive.interestAccrualStart };
    expect(sellerEconomics(fresh, fresh.interestRateBps, now).accrued).toBe(
      accrue(10n * DAY),
    );
  });

  it('forfeits only the unpaid stretch the contract resolved', () => {
    const paid = { ...saleLive, lenderForfeitFrom: now - 6n * DAY };
    expect(sellerEconomics(paid, paid.interestRateBps, now).accrued).toBe(
      accrue(6n * DAY),
    );
  });

  it('forfeits nothing when the lender is paid through now', () => {
    const paid = { ...saleLive, lenderForfeitFrom: now };
    const econ = sellerEconomics(paid, paid.interestRateBps, now);
    expect(econ.accrued).toBe(0n);
    // A window model cannot over-subtract, so this is a completable sale that
    // returns the whole principal — not a blocked one.
    expect(econ.toSeller).toBe(paid.principal);
  });

  it('keeps the window open across an accrual-clock reset that paid nobody', () => {
    // What a FROZEN partial repayment leaves behind: the borrower's obligation
    // clock restarts, but the lender's share was parked in `heldForLender`
    // rather than delivered — and that balance migrates to the BUYER on a sale.
    // An earlier revision took the later of the two marks, which let the reset
    // act as the credit and closed the window over interest the seller never
    // received. What this pins on the CLIENT is narrower and is the point of the
    // #1801 rename: the client does not weigh the two clocks at all. It uses the
    // window the contract resolved and ignores `interestAccrualStart`, so a
    // change to the contract's rule cannot leave a stale copy here.
    const reset = {
      ...saleLive,
      lenderForfeitFrom: now - 6n * DAY,
      interestAccrualStart: now - 4n * DAY,
    };
    expect(sellerEconomics(reset, reset.interestRateBps, now).accrued).toBe(
      accrue(6n * DAY),
    );
  });

  it('honours a mark that predates the accrual origin', () => {
    // Same property from the other side: a resolved window earlier than the
    // obligation clock is used as given. The contract decides whether such a
    // window is still honourable — since #1801 it refuses one whose principal
    // has moved or whose delivery a freeze broke — and the client's job is only
    // to not second-guess the answer.
    const stale = { ...saleLive, lenderForfeitFrom: now - 20n * DAY };
    expect(sellerEconomics(stale, stale.interestRateBps, now).accrued).toBe(
      accrue(20n * DAY),
    );
  });

  it('measures the loan term from the accrual clock, not the window', () => {
    // The remaining-term half must NOT move with the mark — it measures the
    // loan's own progress, which the mark says nothing about. A rate ABOVE the
    // loan's makes the shortfall the binding cost, exposing that half.
    const bare = sellerEconomics(
      { ...saleLive, lenderForfeitFrom: saleLive.interestAccrualStart },
      2_000n,
      now,
    );
    const paid = sellerEconomics(
      { ...saleLive, lenderForfeitFrom: now - 6n * DAY },
      2_000n,
      now,
    );
    expect(paid.shortfall).toBe(bare.shortfall);
    expect(paid.shortfallBinding).toBe(true);
  });
});
