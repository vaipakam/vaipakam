/**
 * RPC read-diet PR C (§4.2.3) — the claim-verdict memo's contract,
 * pinned. The memo's ONLY safe behaviours are: miss on first sight,
 * hit on an identical key, forget everything on a bump (ownership
 * flip / own receipt / rail drop), discard writes captured before a
 * bump (the in-flight race), expire entries past the TTL, and reset
 * rather than grow past the cap. A regression on any of these either
 * re-spends the Claims fan-out (cost) or serves a stale
 * ownerOf-derived verdict (correctness).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _claimVerdictSizeForTests,
  bumpClaimVerdictEpoch,
  claimVerdictEpoch,
  claimVerdictGet,
  claimVerdictPut,
} from './claimVerdictCache';

describe('claimVerdictCache', () => {
  beforeEach(() => bumpClaimVerdictEpoch());
  afterEach(() => vi.useRealTimers());

  it('misses on first sight, hits on the same key — including null verdicts', () => {
    const e = claimVerdictEpoch();
    expect(claimVerdictGet('k1').hit).toBe(false);
    claimVerdictPut('k1', { loanId: 7 }, e);
    expect(claimVerdictGet('k1')).toEqual({ hit: true, value: { loanId: 7 } });
    // `null` is a real verdict (confirmed not-claimable) and must be a
    // HIT — a `value == null` probe would wrongly re-spend its reads.
    claimVerdictPut('k2', null, e);
    expect(claimVerdictGet('k2')).toEqual({ hit: true, value: null });
  });

  it('forgets everything on a bump', () => {
    const e = claimVerdictEpoch();
    claimVerdictPut('k1', null, e);
    claimVerdictPut('k2', { loanId: 1 }, e);
    bumpClaimVerdictEpoch();
    expect(claimVerdictGet('k1').hit).toBe(false);
    expect(claimVerdictGet('k2').hit).toBe(false);
    expect(_claimVerdictSizeForTests()).toBe(0);
  });

  it('discards a write whose pass started before a bump (in-flight race)', () => {
    // Codex #1232 r1: a verification in flight when ownership.changed
    // arrives must not re-seed the cleared map with pre-bump state.
    const stale = claimVerdictEpoch();
    bumpClaimVerdictEpoch();
    claimVerdictPut('k1', { loanId: 7 }, stale);
    expect(claimVerdictGet('k1').hit).toBe(false);
    expect(_claimVerdictSizeForTests()).toBe(0);
  });

  it('expires entries past the TTL', () => {
    vi.useFakeTimers();
    const e = claimVerdictEpoch();
    claimVerdictPut('k1', null, e);
    vi.advanceTimersByTime(14 * 60_000);
    expect(claimVerdictGet('k1').hit).toBe(true);
    vi.advanceTimersByTime(2 * 60_000); // 16 min total > 15 min TTL
    expect(claimVerdictGet('k1').hit).toBe(false);
  });

  it('resets instead of growing past the cap', () => {
    const e = claimVerdictEpoch();
    for (let i = 0; i < 2000; i++) claimVerdictPut(`k${i}`, null, e);
    expect(_claimVerdictSizeForTests()).toBe(2000);
    claimVerdictPut('overflow', null, e);
    // The whole map reset, then took the new entry — bounded memory,
    // and the next run simply re-probes (the pre-memo behaviour).
    expect(_claimVerdictSizeForTests()).toBe(1);
    expect(claimVerdictGet('overflow').hit).toBe(true);
    expect(claimVerdictGet('k0').hit).toBe(false);
  });
});
