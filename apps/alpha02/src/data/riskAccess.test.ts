/**
 * #671/#728 risk access — the pure state classification, pinned.
 * These predicates carry the trust rules the defi original earned
 * through review (Codex #734/#738 there): a held-but-not-effective
 * tier is called STALE vs COOLING only from trustworthy on-chain
 * reads, and a failed read must degrade to 'unknown' — never flip the
 * comparison via a coerced zero.
 */
import { describe, expect, it } from 'vitest';
import { chainNowOf, classifyHeldTier, strictLingerActive } from './riskAccess';

const base = {
  effectiveTier: 0,
  rawTier: 0,
  tierAnchorKnown: true,
  termsVersionKnown: true,
  tierAnchorVersion: 1n,
  termsVersion: 1n,
};

describe('classifyHeldTier', () => {
  it('raw == effective is effective (the normal state)', () => {
    expect(classifyHeldTier(base)).toBe('effective');
    expect(
      classifyHeldTier({ ...base, effectiveTier: 2, rawTier: 2 }),
    ).toBe('effective');
  });

  it('held above effective with a fresh anchor is COOLING (informational — re-submitting restarts the cooldown)', () => {
    expect(
      classifyHeldTier({ ...base, rawTier: 1, tierAnchorVersion: 1n, termsVersion: 1n }),
    ).toBe('cooling');
  });

  it('held above effective with an outdated anchor is STALE (offers the in-place re-affirm)', () => {
    expect(
      classifyHeldTier({ ...base, rawTier: 2, tierAnchorVersion: 1n, termsVersion: 2n }),
    ).toBe('stale');
  });

  it('an unknown anchor OR terms read degrades to UNKNOWN — a coerced 0 must not flip the comparison', () => {
    // Anchor read failed → coerced 0n would fake "stale" (0 < 1).
    expect(
      classifyHeldTier({ ...base, rawTier: 1, tierAnchorKnown: false, tierAnchorVersion: 0n }),
    ).toBe('unknown');
    // Terms read failed → coerced 0n would fake "cooling" (1 < 0 false).
    expect(
      classifyHeldTier({ ...base, rawTier: 1, termsVersionKnown: false, termsVersion: 0n }),
    ).toBe('unknown');
  });

  it('an effective tier ABOVE raw (lowering settled) still reads effective', () => {
    // Lowering is immediate on-chain; raw < effective is transient
    // RPC skew at worst and must not render a held-tier note.
    expect(
      classifyHeldTier({ ...base, effectiveTier: 2, rawTier: 1 }),
    ).toBe('effective');
  });
});

describe('strictLingerActive', () => {
  const NOW = 1_800_000_000;

  it('linger in the future with the flag OFF is active', () => {
    expect(
      strictLingerActive(
        { strictMode: false, strictModeUntilKnown: true, strictModeUntil: BigInt(NOW + 60) },
        NOW,
      ),
    ).toBe(true);
  });

  it('elapsed linger, flag ON, or an UNKNOWN read are all inactive (unknown renders its own "couldn\'t check" note instead)', () => {
    expect(
      strictLingerActive(
        { strictMode: false, strictModeUntilKnown: true, strictModeUntil: BigInt(NOW - 1) },
        NOW,
      ),
    ).toBe(false);
    expect(
      strictLingerActive(
        { strictMode: true, strictModeUntilKnown: true, strictModeUntil: BigInt(NOW + 60) },
        NOW,
      ),
    ).toBe(false);
    expect(
      strictLingerActive(
        { strictMode: false, strictModeUntilKnown: false, strictModeUntil: 0n },
        NOW,
      ),
    ).toBe(false);
  });
});

describe('chainNowOf (chain-time anchor — Codex #1517 r3)', () => {
  it('advances the pinned block timestamp by device-measured elapsed time, ignoring absolute clock skew', () => {
    // Device clock 1h AHEAD of chain time at fetch: absolute skew must
    // not leak — only elapsed-since-fetch does.
    const s = { chainNowSec: 1_000n, fetchedAtMs: 5_000_000 };
    expect(chainNowOf(s, 5_000_000)).toBe(1_000); // at fetch = block time
    expect(chainNowOf(s, 5_030_000)).toBe(1_030); // +30s later
  });

  it('a device clock that jumps BACKWARD never rewinds chain time', () => {
    const s = { chainNowSec: 1_000n, fetchedAtMs: 5_000_000 };
    expect(chainNowOf(s, 4_000_000)).toBe(1_000);
  });
});
