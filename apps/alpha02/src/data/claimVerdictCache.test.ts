/**
 * RPC read-diet PR C (§4.2.3) — the claim-verdict memo's contract,
 * pinned. The memo's ONLY safe behaviours are: miss on first sight,
 * hit on an identical key, forget everything on a bump (ownership
 * flip / own receipt), and reset rather than grow past the cap. A
 * regression on any of these either re-spends the Claims fan-out
 * (cost) or serves a stale ownerOf-derived verdict (correctness).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _claimVerdictSizeForTests,
  bumpClaimVerdictEpoch,
  claimVerdictGet,
  claimVerdictPut,
} from './claimVerdictCache';

describe('claimVerdictCache', () => {
  beforeEach(() => bumpClaimVerdictEpoch());

  it('misses on first sight, hits on the same key — including null verdicts', () => {
    expect(claimVerdictGet('k1').hit).toBe(false);
    claimVerdictPut('k1', { loanId: 7 });
    expect(claimVerdictGet('k1')).toEqual({ hit: true, value: { loanId: 7 } });
    // `null` is a real verdict (confirmed not-claimable) and must be a
    // HIT — a `value == null` probe would wrongly re-spend its reads.
    claimVerdictPut('k2', null);
    expect(claimVerdictGet('k2')).toEqual({ hit: true, value: null });
  });

  it('forgets everything on a bump', () => {
    claimVerdictPut('k1', null);
    claimVerdictPut('k2', { loanId: 1 });
    bumpClaimVerdictEpoch();
    expect(claimVerdictGet('k1').hit).toBe(false);
    expect(claimVerdictGet('k2').hit).toBe(false);
    expect(_claimVerdictSizeForTests()).toBe(0);
  });

  it('resets instead of growing past the cap', () => {
    for (let i = 0; i < 2000; i++) claimVerdictPut(`k${i}`, null);
    expect(_claimVerdictSizeForTests()).toBe(2000);
    claimVerdictPut('overflow', null);
    // The whole map reset, then took the new entry — bounded memory,
    // and the next run simply re-probes (the pre-memo behaviour).
    expect(_claimVerdictSizeForTests()).toBe(1);
    expect(claimVerdictGet('overflow').hit).toBe(true);
    expect(claimVerdictGet('k0').hit).toBe(false);
  });
});
