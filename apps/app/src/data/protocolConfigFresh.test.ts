/**
 * `protocolConfigFresh` — and specifically, that a timestamp from the
 * FUTURE is not the freshest possible reading.
 *
 * The guard used to be a bare `now - updatedAt < 24 * 3600`. A negative
 * age satisfies that trivially, so a clock-skewed or corrupted stamp was
 * not merely tolerated — it was certified as current, and the protocol
 * console's stale banner stayed off. The two pages that render an age
 * had the matching defect (`Math.max(0, …)` printing "0s ago"), so both
 * surfaces agreed with each other and both were wrong.
 *
 * `docs/FunctionalSpecs/Alpha02ConnectedApp.md` states that an unknown
 * age is never presented as a fresh one. This is the guard half of that
 * rule; the pages read the same allowance so the two cannot drift into
 * disagreeing about whether a stamp is usable, which is how one surface
 * ends up calling a reading fresh while the other calls it unknown.
 */
import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_ALLOWANCE_SEC, protocolConfigFresh } from './indexer';

const now = () => Date.now() / 1000;

describe('protocolConfigFresh', () => {
  it('accepts a recent snapshot', () => {
    expect(protocolConfigFresh(now() - 60)).toBe(true);
  });

  it('rejects one older than the refresh rail should ever allow', () => {
    expect(protocolConfigFresh(now() - 25 * 3600)).toBe(false);
  });

  it('tolerates ordinary clock skew rather than calling it broken', () => {
    // Machines differ by seconds. Inside the allowance a stamp slightly
    // ahead of us is still a usable reading, and refusing it would make
    // the console fall back to chain reads over a rounding difference.
    expect(protocolConfigFresh(now() + CLOCK_SKEW_ALLOWANCE_SEC / 2)).toBe(true);
  });

  it('rejects a stamp far enough ahead to be uninterpretable', () => {
    // The regression this exists for: under the old `< 24h` guard this
    // returned TRUE — the most current reading possible — for a stamp
    // that cannot be right.
    expect(protocolConfigFresh(now() + 3600)).toBe(false);
  });

  it('rejects a wildly future stamp', () => {
    expect(protocolConfigFresh(now() + 365 * 24 * 3600)).toBe(false);
  });

  it('rejects the zero sentinel the indexer writes for a stale row', () => {
    // `markStaleBelow` zeroes `updated_at` deliberately; that is decades
    // in the past, so it must not read as fresh either.
    expect(protocolConfigFresh(0)).toBe(false);
  });
});
