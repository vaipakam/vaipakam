/**
 * `resolveSnapshotAge` — and specifically, that the two reasons a
 * snapshot is not fresh stay apart.
 *
 * The bug this pins (review round 38 P2): the Protocol Console derived
 * its "more than a day old" banner from the negation of a freshness
 * predicate that is equally false for a FUTURE stamp. A skewed producer
 * therefore made the page assert a precise age beside a provenance line
 * reporting the age as unknown. Every case below that asserts
 * `unusable-stamp` for a forward-dated stamp is guarding against the
 * banner reappearing there.
 */
import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_ALLOWANCE_SEC, CONFIG_MAX_AGE_SEC } from './indexer';
import { resolveSnapshotAge } from './snapshotAge';

const NOW = 1_800_000_000;

describe('resolveSnapshotAge', () => {
  it('calls a recent stamp usable', () => {
    expect(resolveSnapshotAge(NOW - 60, NOW)).toBe('usable');
  });

  it('calls a stamp just under the day boundary usable', () => {
    expect(resolveSnapshotAge(NOW - (CONFIG_MAX_AGE_SEC - 1), NOW)).toBe(
      'usable',
    );
  });

  it('calls a stamp exactly at the day boundary stale', () => {
    expect(resolveSnapshotAge(NOW - CONFIG_MAX_AGE_SEC, NOW)).toBe('stale');
  });

  it('calls a much older stamp stale', () => {
    expect(resolveSnapshotAge(NOW - 30 * 24 * 3600, NOW)).toBe('stale');
  });

  // A little ahead of us is a clock difference between two honest
  // machines, not a broken producer — the console must not warn on it.
  it('tolerates a stamp inside the skew allowance', () => {
    expect(
      resolveSnapshotAge(NOW + Math.floor(CLOCK_SKEW_ALLOWANCE_SEC / 2), NOW),
    ).toBe('usable');
  });

  it('tolerates a stamp exactly at the skew allowance', () => {
    expect(resolveSnapshotAge(NOW + CLOCK_SKEW_ALLOWANCE_SEC, NOW)).toBe(
      'usable',
    );
  });

  // THE REGRESSION. Each of these was `stale` before, so each rendered
  // "This snapshot is more than a day old" about a stamp from the
  // future.
  it('calls a stamp just past the skew allowance unusable, NOT stale', () => {
    const got = resolveSnapshotAge(NOW + CLOCK_SKEW_ALLOWANCE_SEC + 1, NOW);
    expect(got).toBe('unusable-stamp');
    expect(got).not.toBe('stale');
  });

  it('calls an hour-ahead stamp unusable, NOT stale', () => {
    const got = resolveSnapshotAge(NOW + 3600, NOW);
    expect(got).toBe('unusable-stamp');
    expect(got).not.toBe('stale');
  });

  it('calls a year-ahead stamp unusable, NOT stale', () => {
    const got = resolveSnapshotAge(NOW + 365 * 24 * 3600, NOW);
    expect(got).toBe('unusable-stamp');
    expect(got).not.toBe('stale');
  });

  // Zero is the indexer's sentinel for "capture time unknown", set by
  // `markStaleBelow`. Reading it as a 1970 capture is what once printed
  // "taken 56 years ago" on this page.
  it('treats the zero sentinel as unusable rather than a 1970 capture', () => {
    expect(resolveSnapshotAge(0, NOW)).toBe('unusable-stamp');
  });

  it('treats a negative stamp as unusable', () => {
    expect(resolveSnapshotAge(-1, NOW)).toBe('unusable-stamp');
  });

  it('treats a missing stamp as unusable', () => {
    expect(resolveSnapshotAge(undefined, NOW)).toBe('unusable-stamp');
  });
});
