/**
 * §5.3 honesty math for the Rate Desk chart (#1130) — the sparse-tape
 * threshold and the header's "last fill" derivation.
 */
import { describe, expect, it } from 'vitest';
import type { RateCandleBucket } from '../data/indexer';
import {
  SPARSE_FILLS_THRESHOLD,
  isSparseTape,
  newestPrint,
  totalFills,
} from './rateChart';

function bucket(partial: Partial<RateCandleBucket> & { t: number }): RateCandleBucket {
  return {
    open: 500,
    high: 550,
    low: 480,
    close: 520,
    fills: 1,
    principalTotal: '1000000000000000000',
    ...partial,
  };
}

describe('totalFills / isSparseTape', () => {
  it('sums fill counts across buckets', () => {
    expect(totalFills([])).toBe(0);
    expect(totalFills([bucket({ t: 1, fills: 3 }), bucket({ t: 2, fills: 4 })])).toBe(7);
  });

  it('is sparse strictly below the threshold', () => {
    const nine = Array.from({ length: 9 }, (_, i) => bucket({ t: i, fills: 1 }));
    expect(isSparseTape(nine)).toBe(true);
    const ten = [...nine, bucket({ t: 9, fills: 1 })];
    expect(totalFills(ten)).toBe(SPARSE_FILLS_THRESHOLD);
    expect(isSparseTape(ten)).toBe(false);
  });

  it('counts fills, not buckets — one dense bucket can exit sparse mode', () => {
    expect(isSparseTape([bucket({ t: 1, fills: 12 })])).toBe(false);
  });
});

describe('newestPrint', () => {
  const buckets = [
    bucket({ t: 1_000, close: 510 }),
    bucket({ t: 2_000, close: 525 }),
  ];

  it('returns null with no buckets and no tape', () => {
    expect(newestPrint([], null)).toBeNull();
  });

  it('uses the newest bucket close when the tape is empty', () => {
    expect(newestPrint(buckets, null)).toEqual({
      rateBps: 525,
      at: 2_000,
      source: 'bucket',
    });
  });

  it('prefers a tape fill at least as fresh as the newest bucket', () => {
    // A fill inside (or after) the newest bucket carries the exact
    // time — the 60 s-cached candle response may not include it yet.
    expect(newestPrint(buckets, { rateBps: 530, at: 2_500 })).toEqual({
      rateBps: 530,
      at: 2_500,
      source: 'tape',
    });
  });

  it('keeps the bucket close when the tape fill is older', () => {
    expect(newestPrint(buckets, { rateBps: 400, at: 1_500 })).toEqual({
      rateBps: 525,
      at: 2_000,
      source: 'bucket',
    });
  });

  it('falls back to the tape when candles are unavailable/empty', () => {
    expect(newestPrint([], { rateBps: 505, at: 900 })).toEqual({
      rateBps: 505,
      at: 900,
      source: 'tape',
    });
  });
});
