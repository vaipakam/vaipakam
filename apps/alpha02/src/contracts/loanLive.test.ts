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
