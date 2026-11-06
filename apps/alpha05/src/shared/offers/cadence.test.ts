import { describe, expect, it } from 'vitest';
import { encodeErrorResult, type Abi } from 'viem';
import { cadenceOpen, cadenceRefusal, cadenceRefusalText, classifyCadenceError, periodGraceLookupDays, periodInterest, type CadenceAdmission } from './cadence';
import { OFFER_PREVIEW } from './reads';

const E18 = 10n ** 18n;
const err = (errorName: string, args?: readonly unknown[]) => encodeErrorResult({ abi: OFFER_PREVIEW as Abi, errorName, args } as never);

const copy = {
  text: (k: string) => k,
  format: (k: string, v: Readonly<Record<string, string>>) =>
    `${k}:${Object.entries(v)
      .map(([a, b]) => `${a}=${b}`)
      .join(',')}`,
};

describe('a cadence refusal, from the protocol error', () => {
  it('names the switch, an unpriced leg and the multi-year floor', () => {
    expect(cadenceRefusal(err('PeriodicInterestDisabled'))).toEqual({ kind: 'switch-off' });
    expect(cadenceRefusal(err('CadenceNotAllowedForIlliquid', [0, 1, 1]))).toEqual({ kind: 'unpriced' });
    expect(cadenceRefusal(err('CadenceNotAllowed', [0, 400n, 5n * E18, 1000n * E18]))).toEqual({ kind: 'needs-annual' });
  });
  it('names both figures when the principal is under the threshold', () => {
    expect(cadenceRefusal(err('CadenceNotAllowed', [1, 60n, 5n * E18, 1000n * E18]))).toEqual({ kind: 'below-threshold', principal: 5n * E18, threshold: 1000n * E18 });
  });
  it('reads the period rule when the principal is not the reason', () => {
    expect(cadenceRefusal(err('CadenceNotAllowed', [2, 60n, 5000n * E18, 1000n * E18]))).toEqual({ kind: 'period-too-long', periodDays: 90, durationDays: 60 });
    // A multi-year loan below the threshold may still pay every year, so
    // the yearly refusal there is never the threshold.
    expect(classifyCadenceError('CadenceNotAllowed', [4, 400n, 1n, 1000n * E18])).toEqual({ kind: 'period-too-long', periodDays: 365, durationDays: 400 });
  });
  it('never reads empty or foreign data as an admission or as a known reason', () => {
    expect(cadenceRefusal('0x')).toEqual({ kind: 'unknown', code: 'no data' });
    expect(cadenceRefusal('0xdeadbeef')).toEqual({ kind: 'unknown', code: '0xdeadbeef' });
    expect(classifyCadenceError('ProtocolPaused', [])).toBeNull();
    expect(classifyCadenceError('CadenceNotAllowed', null)).toEqual({ kind: 'unknown', code: 'CadenceNotAllowed' });
  });
});

describe('the schedules offered', () => {
  const admission: CadenceAdmission = {
    enabled: true,
    verdicts: [
      { cadence: 0, admitted: true, refusal: null },
      { cadence: 1, admitted: true, refusal: null },
      { cadence: 2, admitted: false, refusal: { kind: 'period-too-long', periodDays: 90, durationDays: 60 } },
    ],
  };
  it('offers only interest at repayment while the admission is unknown', () => {
    expect(cadenceOpen(null, 0)).toBe(true);
    expect(cadenceOpen(null, 1)).toBe(false);
  });
  it('offers what the protocol admits, and nothing it does not list', () => {
    expect(cadenceOpen(admission, 1)).toBe(true);
    expect(cadenceOpen(admission, 2)).toBe(false);
    expect(cadenceOpen(admission, 4)).toBe(false);
  });
  it('states each reason with its figures', () => {
    expect(cadenceRefusalText({ kind: 'below-threshold', principal: 1234n * E18, threshold: 100_000n * E18 }, 'USD', copy)).toBe(
      'cadence.offThreshold:principal=1,234.00,threshold=100,000.00,unit=USD',
    );
    expect(cadenceRefusalText({ kind: 'period-too-long', periodDays: 90, durationDays: 60 }, 'USD', copy)).toBe('cadence.offPeriod:period=90,days=60');
    expect(cadenceRefusalText({ kind: 'switch-off' }, 'USD', copy)).toBe('cadence.offSwitch');
  });
});

describe('the figures a schedule carries', () => {
  it('computes one period as the protocol expects it, rounded down', () => {
    expect(periodInterest(365n * E18, 1000n, 1)).toBe((365n * E18 * 1000n * 30n) / (10_000n * 365n));
    expect(periodInterest(10n * E18, 600n, 0)).toBe(0n);
  });
  it('looks the period grace up by the period less a day', () => {
    expect([0, 1, 2, 3, 4].map((c) => periodGraceLookupDays(c as 0 | 1 | 2 | 3 | 4))).toEqual([0, 29, 89, 179, 364]);
  });
});
