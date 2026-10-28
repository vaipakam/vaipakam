import { describe, expect, it } from 'vitest';
import { encodeErrorResult, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import {
  admissionOf,
  cadenceAllowed,
  decodeCadencePreview,
  refusalOf,
  type CadenceTerms,
} from './cadenceAdmission';

const err = (errorName: string, args: readonly unknown[] = []) =>
  encodeErrorResult({ abi: DIAMOND_ABI_VIEM, errorName, args } as never) as Hex;

const WAD = 10n ** 18n;
const THRESHOLD = 10_000n * WAD;

describe('refusalOf', () => {
  it('words the switch being off', () => {
    expect(refusalOf(err('PeriodicInterestDisabled'), 1, 90)).toEqual({ kind: 'switched-off' });
  });

  it('names the leg that cannot be priced, from the error itself', () => {
    expect(refusalOf(err('CadenceNotAllowedForIlliquid', [0, 1, 1]), 1, 90)).toEqual({
      kind: 'illiquid',
      principalLiquid: true,
      collateralLiquid: false,
    });
  });

  it('tells the yearly floor from the threshold and the interval', () => {
    // A multi-year loan asking for no schedule.
    expect(refusalOf(err('CadenceNotAllowed', [0, 400n, THRESHOLD, THRESHOLD]), 0, 400)).toEqual({
      kind: 'yearly-floor',
    });
    // Below the threshold on a loan of a year or less.
    expect(refusalOf(err('CadenceNotAllowed', [1, 90n, 5n * WAD, THRESHOLD]), 1, 90)).toEqual({
      kind: 'below-threshold',
      principalNumeraire: 5n * WAD,
      threshold: THRESHOLD,
    });
    // Below the threshold on a multi-year loan: only Annual is open.
    expect(refusalOf(err('CadenceNotAllowed', [2, 400n, 5n * WAD, THRESHOLD]), 2, 400).kind).toBe(
      'below-threshold',
    );
    // Above the threshold, an interval not shorter than the loan.
    expect(refusalOf(err('CadenceNotAllowed', [2, 90n, THRESHOLD, THRESHOLD]), 2, 90)).toEqual({
      kind: 'interval',
      intervalDays: 90,
    });
  });

  it('keeps an unknown or undecodable refusal a refusal', () => {
    expect(refusalOf(err('LoanNotActive'), 1, 90)).toEqual({ kind: 'other' });
    expect(refusalOf('0xdeadbeef', 1, 90)).toEqual({ kind: 'other' });
  });

  it('reads empty revert data as unevaluated, never as admitted', () => {
    expect(refusalOf('0x', 1, 90)).toEqual({ kind: 'unevaluated' });
  });
});

const raw = (admitted: boolean[]) => ({
  periodicInterestEnabled: true,
  bothLegsQualify: true,
  annualFloorApplies: false,
  cadences: admitted.map((a, i) => ({
    cadence: i,
    admitted: a,
    refusal: a ? ('0x' as Hex) : err('CadenceNotAllowed', [i, 90n, THRESHOLD, THRESHOLD]),
  })),
});

describe('decodeCadencePreview', () => {
  it('carries the verdict for every cadence and the unit', () => {
    const p = decodeCadencePreview(raw([true, true, false, false, false]), 90, `0x${'0'.repeat(64)}`);
    expect(p.cadences.map((c) => c.admitted)).toEqual([true, true, false, false, false]);
    expect(p.cadences[0].refusal).toBeNull();
    expect(p.cadences[2].refusal).toEqual({ kind: 'interval', intervalDays: 90 });
    expect(p.numeraire).toEqual({ symbol: 'USD', isDefault: true });
  });

  it('states an unread unit as unknown', () => {
    expect(decodeCadencePreview(raw([true, false, false, false, false]), 90, null).numeraire).toBeNull();
  });
});

const terms: CadenceTerms = {
  lendingAsset: '0x0000000000000000000000000000000000000001',
  amount: 1n,
  assetType: 0,
  collateralAsset: '0x0000000000000000000000000000000000000002',
  collateralAssetType: 0,
  durationDays: 90,
};
const missingSelector = Object.assign(new Error('reverted'), {
  data: '0xa9ad62f8',
});

describe('admissionOf and cadenceAllowed', () => {
  it('is idle with no terms, and lets only "once at repayment" through', () => {
    const a = admissionOf(null, { data: undefined, error: null, isError: false });
    expect(a).toEqual({ kind: 'idle' });
    expect(cadenceAllowed(a, 0)).toBe(true);
    expect(cadenceAllowed(a, 1)).toBe(false);
  });

  it('admits exactly what the known verdict admits', () => {
    const preview = decodeCadencePreview(raw([false, true, false, false, true]), 400, null);
    const a = admissionOf(terms, { data: preview, error: null, isError: false });
    expect(cadenceAllowed(a, 0)).toBe(false);
    expect(cadenceAllowed(a, 1)).toBe(true);
    expect(cadenceAllowed(a, 2)).toBe(false);
  });

  it('drops a cached answer once a refresh fails', () => {
    const preview = decodeCadencePreview(raw([true, true, true, true, true]), 400, null);
    const a = admissionOf(terms, { data: preview, error: new Error('rpc'), isError: true });
    expect(a).toEqual({ kind: 'failed' });
    expect(cadenceAllowed(a, 1)).toBe(false);
  });

  it('reads a missing selector as unserved', () => {
    const a = admissionOf(terms, { data: undefined, error: missingSelector, isError: true });
    expect(a).toEqual({ kind: 'unserved' });
    expect(cadenceAllowed(a, 0)).toBe(true);
  });
});
