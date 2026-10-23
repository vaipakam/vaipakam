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
  bucketsStateProvenance,
  readUnplacedCount,
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
    unrecordedPrincipalFills: 0,
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
  const fill = (loanId: number, startAt: number, rateBps: number | null): TapeFillLike => ({
    loanId,
    startAt,
    rateBps,
    principal: null,
  });
  const buckets = [
    bucket({ t: 1_000, close: 510 }),
    bucket({ t: 2_000, close: 525 }),
  ];

  it('returns null with no buckets and no tape', () => {
    expect(newestPrint([], null)).toBeNull();
  });

  it('uses the newest bucket close when the tape is empty', () => {
    expect(newestPrint(buckets, null)).toEqual({
      source: 'bucket',
      rateBps: 525,
      at: 2_000,
    });
  });

  it('prefers a tape fill at least as fresh as the newest bucket', () => {
    // A fill inside (or after) the newest bucket carries the exact
    // time — the 60 s-cached candle response may not include it yet.
    expect(newestPrint(buckets, fill(7, 2_500, 530))).toEqual({
      source: 'tape',
      rateBps: 530,
      at: 2_500,
      loanId: 7,
    });
  });

  it('keeps the bucket close when the tape fill is older', () => {
    expect(newestPrint(buckets, fill(7, 1_500, 400))).toEqual({
      source: 'bucket',
      rateBps: 525,
      at: 2_000,
    });
  });

  it('falls back to the tape when candles are unavailable/empty', () => {
    expect(newestPrint([], fill(7, 900, 505))).toEqual({
      source: 'tape',
      rateBps: 505,
      at: 900,
      loanId: 7,
    });
  });

  it('reports a newer fill with no recorded rate as such, not an older close (#1142)', () => {
    expect(newestPrint(buckets, fill(42, 2_500, null))).toEqual({
      source: 'tape',
      rateBps: null,
      at: 2_500,
      loanId: 42,
    });
  });

  it('keeps the loan id of an unrecorded print so the header can name it (#1142)', () => {
    const print = newestPrint([], fill(42, 900, null));
    expect(print?.source === 'tape' ? print.loanId : null).toBe(42);
  });
});

describe('chartEmptyKind (#1139 — never-filled vs empty-in-range copy)', () => {
  const NOW = 100 * 86_400;
  const at = (daysAgo: number) => ({ startAt: NOW - daysAgo * 86_400 });
  const T = (fills: { startAt: number }[], unplacedEver = 0) => ({
    fills,
    unplaced: { count: unplacedEver },
  });

  it('range=all earns the market copy when the tape cannot disprove it', () => {
    expect(chartEmptyKind('all', undefined, 0, NOW)).toBe('market');
    expect(chartEmptyKind('all', null, 0, NOW)).toBe('market');
    expect(chartEmptyKind('all', T([]), 0, NOW)).toBe('market');
  });

  it('a tape fill inside the range means the empty series is stale: catching up, never a claim about the period', () => {
    // Candle-cache skew: the tape (and the last-fill header) already shows
    // the fill; the body must not claim "none" against its own header.
    expect(chartEmptyKind('all', T([at(200)]), 0, NOW)).toBe('catchingUp');
    expect(chartEmptyKind('7d', T([at(1)]), 0, NOW)).toBe('catchingUp');
    expect(chartEmptyKind('30d', T([at(40), at(2)]), 0, NOW)).toBe('catchingUp');
  });

  it('a tape fill older than the range proves the market filled, so only the period copy fits', () => {
    expect(chartEmptyKind('7d', T([at(8)]), 0, NOW)).toBe('range');
    expect(chartEmptyKind('30d', T([at(31), at(45)]), 0, NOW)).toBe('range');
  });

  it('a narrower range with a confirmed-empty tape is a never-filled market', () => {
    expect(chartEmptyKind('7d', T([]), 0, NOW)).toBe('market');
    expect(chartEmptyKind('30d', T([]), 0, NOW)).toBe('market');
  });

  it('a narrower range is range-scoped when the tape is unknown', () => {
    expect(chartEmptyKind('7d', null, 0, NOW)).toBe('range'); // tape unavailable
    expect(chartEmptyKind('30d', undefined, 0, NOW)).toBe('range'); // tape loading
  });
});

describe('unplaced loans (#1142 — counted, never placed under a guessed tenor)', () => {
  const NOW = 100 * 86_400;
  const T = (fills: { startAt: number }[], unplacedEver = 0) => ({
    fills,
    unplaced: { count: unplacedEver },
  });

  it('an empty series on a pair with unplaced loans claims neither "never filled" nor "none in this period"', () => {
    expect(chartEmptyKind('all', T([]), 2, NOW)).toBe('unplaced');
    expect(chartEmptyKind('7d', null, 1, NOW)).toBe('unplaced');
    expect(chartEmptyKind('30d', T([{ startAt: NOW - 40 * 86_400 }]), 3, NOW)).toBe('unplaced');
  });

  it('a confirmed-empty tape whose pair has unplaced loans OUTSIDE the range is not a never-filled market', () => {
    // The candle count (in range) is zero; the tape's all-time one is not.
    expect(chartEmptyKind('7d', T([], 2), 0, NOW)).toBe('unplaced');
  });

  it('a tape-proven fill in the range outranks the unplaced copy (Codex #2689 r5)', () => {
    expect(chartEmptyKind('30d', T([{ startAt: NOW - 86_400 }], 3), 3, NOW)).toBe('catchingUp');
  });

  it('reads the count and whether the server stopped counting', () => {
    expect(readUnplacedCount({ count: 4, capped: false })).toEqual({ count: 4, capped: false });
    expect(readUnplacedCount({ count: 0, capped: false })).toEqual({ count: 0, capped: false });
    expect(readUnplacedCount({ count: 1000, capped: true })).toEqual({ count: 1000, capped: true });
  });

  it('fails closed on an absent or malformed disclosure, so the hook reports the chart unavailable', () => {
    // Absent is NOT "none": a response that does not say what it left out
    // cannot be shown as complete.
    expect(readUnplacedCount(undefined)).toBeNull();
    expect(readUnplacedCount(null)).toBeNull();
    expect(readUnplacedCount(4)).toBeNull();
    expect(readUnplacedCount({ count: -1, capped: false })).toBeNull();
    expect(readUnplacedCount({ count: 1.5, capped: false })).toBeNull();
    expect(readUnplacedCount({ count: '2', capped: false })).toBeNull();
    expect(readUnplacedCount({ count: 2 })).toBeNull();
    expect(readUnplacedCount([{ t: 0, fills: 1 }])).toBeNull();
  });

  it('accepts buckets only when each states its unrecorded amounts', () => {
    const b = (fills: unknown, u: unknown) => ({ t: 0, fills, unrecordedPrincipalFills: u });
    expect(bucketsStateProvenance([])).toBe(true);
    expect(bucketsStateProvenance([b(3, 0), b(2, 2)])).toBe(true);
    expect(bucketsStateProvenance([b(3, 0), { t: 0, fills: 1 }])).toBe(false);
    expect(bucketsStateProvenance([b(2, 3)])).toBe(false);
    expect(bucketsStateProvenance([b(2, -1)])).toBe(false);
    expect(bucketsStateProvenance([b(2, '0')])).toBe(false);
    expect(bucketsStateProvenance([null])).toBe(false);
  });
});

describe('sparse-mode per-fill markers from the tape (#1139)', () => {
  const H = INTERVAL_SECONDS['1h'];

  function tapeFill(
    loanId: number,
    startAt: number,
    rateBps: number | null = 500,
    principal: string | null = '1000',
  ): TapeFillLike {
    return { loanId, startAt, rateBps, principal };
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
        { t: 100, rateBps: 500, fills: 1, principalTotal: '10', unrecordedPrincipalFills: 0 },
        { t: 200, rateBps: 600, fills: 1, principalTotal: '20', unrecordedPrincipalFills: 0 },
        { t: H + 5, rateBps: 700, fills: 1, principalTotal: '30', unrecordedPrincipalFills: 0 },
      ]);
    });

    it('collapses only same-SECOND fills, keeping the ×N count and loan-id order', () => {
      const buckets = [bucket({ t: 0, fills: 2 })];
      const tape = [tapeFill(9, 100, 700, '5'), tapeFill(7, 100, 400, '3')];
      expect(fillPointsFromTape(buckets, tape, H)).toEqual([
        // Loan 7 executed first → loan 9's rate is the last print.
        { t: 100, rateBps: 700, fills: 2, principalTotal: '8', unrecordedPrincipalFills: 0 },
      ]);
    });

    it('drops tape rows outside the emitted buckets from the points', () => {
      const buckets = [bucket({ t: 0, fills: 1 })];
      const tape = [tapeFill(1, 100, 500, '10'), tapeFill(2, 5 * H, 900, '99')];
      expect(fillPointsFromTape(buckets, tape, H)).toEqual([
        { t: 100, rateBps: 500, fills: 1, principalTotal: '10', unrecordedPrincipalFills: 0 },
      ]);
    });

    it('returns null (bucket fallback) without coverage, empty buckets, or a bad principal', () => {
      const buckets = [bucket({ t: 0, fills: 2 })];
      expect(fillPointsFromTape(buckets, [tapeFill(1, 100)], H)).toBeNull();
      expect(fillPointsFromTape([], [tapeFill(1, 100)], H)).toBeNull();
      const bad = [tapeFill(1, 100), tapeFill(2, 200, 500, 'not-a-number')];
      expect(fillPointsFromTape(buckets, bad, H)).toBeNull();
    });

    it('returns null (bucket fallback) when a covered fill has no confirmed rate (#1142)', () => {
      const buckets = [bucket({ t: 0, fills: 2 })];
      expect(fillPointsFromTape(buckets, [tapeFill(1, 100), tapeFill(2, 200, null)], H)).toBeNull();
    });

    it('keeps a fill whose amount alone is unrecorded as its own marker, counting the amount (Codex #2689 r5)', () => {
      const buckets = [bucket({ t: 0, fills: 3 })];
      const tape = [
        tapeFill(3, 200, 650, null),
        tapeFill(2, 100, 600, null),
        tapeFill(1, 100, 500, '10'),
      ];
      expect(fillPointsFromTape(buckets, tape, H)).toEqual([
        { t: 100, rateBps: 600, fills: 2, principalTotal: '10', unrecordedPrincipalFills: 1 },
        { t: 200, rateBps: 650, fills: 1, principalTotal: '0', unrecordedPrincipalFills: 1 },
      ]);
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
