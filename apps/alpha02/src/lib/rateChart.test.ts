/**
 * §5.3 honesty math for the Rate Desk chart (#1130) — the sparse-tape
 * threshold and the header's "last fill" derivation.
 */
import { describe, expect, it } from 'vitest';
import type { RateCandleBucket } from '../data/indexer';
import {
  INTERVAL_SECONDS,
  SPARSE_FILLS_THRESHOLD,
  WHITESPACE_SLOT_CAP,
  chartEmptyKind,
  fillPointsFromTape,
  isSparseTape,
  newestPrint,
  tapeCoversSparseFills,
  totalFills,
  whitespaceBucketTimes,
  type TapeFillLike,
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

describe('chartEmptyKind (#1139 — never-filled vs empty-in-range copy)', () => {
  it('range=all earns the market copy when the tape cannot disprove it', () => {
    expect(chartEmptyKind('all', undefined)).toBe('market');
    expect(chartEmptyKind('all', null)).toBe('market');
    expect(chartEmptyKind('all', [])).toBe('market');
  });

  it('a tape-proven fill NEVER earns the market copy — even at range=all (round-4: 60 s candle-cache skew after a first fill)', () => {
    // The candle response is still empty (60 s cache) but the tape —
    // and hence the last-fill header — already shows the fill; the
    // body must not claim "no fills yet" against its own header.
    expect(chartEmptyKind('all', [{}])).toBe('range');
    expect(chartEmptyKind('7d', [{}])).toBe('range');
    expect(chartEmptyKind('30d', [{}, {}])).toBe('range');
  });

  it('a narrower range with a confirmed-empty tape is a never-filled market', () => {
    expect(chartEmptyKind('7d', [])).toBe('market');
    expect(chartEmptyKind('30d', [])).toBe('market');
  });

  it('a narrower range is range-scoped when the tape is unknown', () => {
    expect(chartEmptyKind('7d', null)).toBe('range'); // tape unavailable
    expect(chartEmptyKind('30d', undefined)).toBe('range'); // tape loading
  });
});

describe('sparse-mode per-fill markers from the tape (#1139)', () => {
  const H = INTERVAL_SECONDS['1h'];

  function tapeFill(
    loanId: number,
    startAt: number,
    rateBps = 500,
    principal = '1000',
  ): TapeFillLike {
    return { loanId, startAt, interestRateBps: rateBps, principal };
  }

  it('mirrors the worker interval enum', () => {
    expect(INTERVAL_SECONDS).toEqual({ '1h': 3600, '4h': 14400, '1d': 86400 });
  });

  describe('tapeCoversSparseFills', () => {
    it('covers when the in-bucket tape count equals the buckets fill total', () => {
      const buckets = [bucket({ t: 0, fills: 2 }), bucket({ t: H, fills: 1 })];
      const tape = [tapeFill(1, 100), tapeFill(2, 200), tapeFill(3, H + 5)];
      expect(tapeCoversSparseFills(buckets, tape, H)).toBe(true);
    });

    it('ignores tape rows outside the emitted buckets (older fills, cache-fresh fills)', () => {
      const buckets = [bucket({ t: H, fills: 1 })];
      // One in-bucket row + an older fill + a fill in a bucket the
      // candle response has not emitted yet (60 s cache skew).
      const tape = [tapeFill(1, H + 5), tapeFill(2, 10), tapeFill(3, 3 * H)];
      expect(tapeCoversSparseFills(buckets, tape, H)).toBe(true);
    });

    it('fails closed on a truncated tape (fewer rows than folded fills)', () => {
      const buckets = [bucket({ t: 0, fills: 3 })];
      expect(tapeCoversSparseFills(buckets, [tapeFill(1, 100)], H)).toBe(false);
    });

    it('fails closed on scope drift (more in-bucket rows than folded fills)', () => {
      const buckets = [bucket({ t: 0, fills: 1 })];
      const tape = [tapeFill(1, 100), tapeFill(2, 200)];
      expect(tapeCoversSparseFills(buckets, tape, H)).toBe(false);
    });
  });

  describe('fillPointsFromTape', () => {
    it('emits one point per fill at its exact time, chronological', () => {
      const buckets = [bucket({ t: 0, fills: 2 }), bucket({ t: H, fills: 1 })];
      // Newest-first input (the tape order) — output must sort.
      const tape = [
        tapeFill(3, H + 5, 700, '30'),
        tapeFill(2, 200, 600, '20'),
        tapeFill(1, 100, 500, '10'),
      ];
      expect(fillPointsFromTape(buckets, tape, H)).toEqual([
        { t: 100, rateBps: 500, fills: 1, principalTotal: '10' },
        { t: 200, rateBps: 600, fills: 1, principalTotal: '20' },
        { t: H + 5, rateBps: 700, fills: 1, principalTotal: '30' },
      ]);
    });

    it('collapses only same-SECOND fills, keeping the ×N count and loan-id order', () => {
      const buckets = [bucket({ t: 0, fills: 2 })];
      const tape = [tapeFill(9, 100, 700, '5'), tapeFill(7, 100, 400, '3')];
      expect(fillPointsFromTape(buckets, tape, H)).toEqual([
        // Loan 7 executed first → loan 9's rate is the last print.
        { t: 100, rateBps: 700, fills: 2, principalTotal: '8' },
      ]);
    });

    it('drops tape rows outside the emitted buckets from the points', () => {
      const buckets = [bucket({ t: 0, fills: 1 })];
      const tape = [tapeFill(1, 100, 500, '10'), tapeFill(2, 5 * H, 900, '99')];
      expect(fillPointsFromTape(buckets, tape, H)).toEqual([
        { t: 100, rateBps: 500, fills: 1, principalTotal: '10' },
      ]);
    });

    it('returns null (bucket fallback) without coverage, empty buckets, or a bad principal', () => {
      const buckets = [bucket({ t: 0, fills: 2 })];
      expect(fillPointsFromTape(buckets, [tapeFill(1, 100)], H)).toBeNull();
      expect(fillPointsFromTape([], [tapeFill(1, 100)], H)).toBeNull();
      const bad = [tapeFill(1, 100), tapeFill(2, 200, 500, 'not-a-number')];
      expect(fillPointsFromTape(buckets, bad, H)).toBeNull();
    });

    it('folds principals as BigInt past 2^53', () => {
      const buckets = [bucket({ t: 0, fills: 2 })];
      const tape = [
        tapeFill(1, 100, 500, '9007199254740993'), // 2^53 + 1
        tapeFill(2, 100, 500, '9007199254740995'), // 2^53 + 3
      ];
      expect(fillPointsFromTape(buckets, tape, H)![0].principalTotal).toBe(
        '18014398509481988',
      );
    });
  });
});

describe('whitespaceBucketTimes (#1139 round-3 — §5.3 rule 1, gaps stay gaps)', () => {
  const H = INTERVAL_SECONDS['1h'];

  it('returns [] with no occupied slots, one slot, or adjacent slots', () => {
    expect(whitespaceBucketTimes([], H)).toEqual([]);
    expect(whitespaceBucketTimes([5 * H], H)).toEqual([]);
    expect(whitespaceBucketTimes([0, H], H)).toEqual([]);
  });

  it('enumerates every empty grid slot strictly between the endpoints', () => {
    expect(whitespaceBucketTimes([0, 4 * H], H)).toEqual([H, 2 * H, 3 * H]);
    // A filled middle bucket is never emitted as whitespace.
    expect(whitespaceBucketTimes([0, 2 * H, 4 * H], H)).toEqual([H, 3 * H]);
  });

  it('folds exact fill times onto the grid and dedupes same-bucket fills', () => {
    // Two fills in bucket 0, one in bucket 2H — only bucket H is empty,
    // and no whitespace time can collide with a fill time (an occupied
    // slot is excluded by construction).
    expect(whitespaceBucketTimes([100, 200, 2 * H + 5], H)).toEqual([H]);
  });

  it('is order-insensitive', () => {
    expect(whitespaceBucketTimes([3 * H, 0], H)).toEqual([H, 2 * H]);
  });

  it('caps defensively: an extreme span yields no whitespace at all', () => {
    // Exactly at the cap → still generated…
    const atCap = whitespaceBucketTimes([0, (WHITESPACE_SLOT_CAP + 1) * H], H);
    expect(atCap).toHaveLength(WHITESPACE_SLOT_CAP);
    expect(atCap[0]).toBe(H);
    expect(atCap[atCap.length - 1]).toBe(WHITESPACE_SLOT_CAP * H);
    // …one slot beyond → skipped entirely (points render adjacent, the
    // pre-whitespace behaviour — no price is fabricated either way).
    expect(
      whitespaceBucketTimes([0, (WHITESPACE_SLOT_CAP + 2) * H], H),
    ).toEqual([]);
  });

  it('guards a non-positive interval', () => {
    expect(whitespaceBucketTimes([0, 100], 0)).toEqual([]);
  });
});
