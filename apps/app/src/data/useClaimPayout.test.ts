/**
 * UX3-005 — the recovered-vs-lent line on a defaulted lender claim.
 * Each case is the input that distinguishes one rule from its neighbour.
 */
import { describe, expect, it } from 'vitest';
import { copy } from '../content/copy';
import { defaultRecoveryNote } from './useClaimPayout';

const fmt = (v: bigint) => `${v} WETH`;
const base = {
  hasHeld: false,
  recovered: 285n,
  sameAsset: true,
  lent: 500n,
  fmtLent: fmt,
  labels: copy.claims.row,
};

describe('defaultRecoveryNote', () => {
  // The live case: lent 0.005 WETH, recovered 0.00285 WETH, and the claim
  // never said how much was lost.
  it('states the exact shortfall for a same-asset recovery below what was lent', () => {
    expect(defaultRecoveryNote(base)).toBe(
      'That is 215 WETH less than the 500 WETH you lent, before any interest.',
    );
  });

  it('says the recovery covers what was lent when it does — and claims nothing about interest', () => {
    expect(defaultRecoveryNote({ ...base, recovered: 500n })).toBe('That covers the 500 WETH you lent.');
  });

  it('never compares across assets', () => {
    expect(defaultRecoveryNote({ ...base, sameAsset: false })).toBe(copy.claims.row.compareOtherAsset);
  });

  it('never compares an in-kind recovery as if it were cash', () => {
    expect(defaultRecoveryNote({ ...base, recovered: null })).toBe(copy.claims.row.compareInKind);
  });

  it('says held proceeds make it unknowable, even when the paid leg alone would compare', () => {
    expect(defaultRecoveryNote({ ...base, hasHeld: true })).toBe(copy.claims.row.compareUnknownHeld);
  });

  it('stays silent only while the lent asset is still loading', () => {
    expect(defaultRecoveryNote({ ...base, fmtLent: null })).toBeUndefined();
  });
});
