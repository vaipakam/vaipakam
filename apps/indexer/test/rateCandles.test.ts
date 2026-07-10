/**
 * Rate Desk phase 2 (#1130) — the pure candle fold behind
 * `GET /loans/rate-candles`. Pins the §7 aggregation contract:
 * bucket-boundary assignment per interval, chronological OHLC with the
 * loan_id tiebreak, BigInt principal folding past 2^53, and the
 * "candles only where fills >= 1, ascending t" output shape.
 *
 * (The SQL-side row scoping — is_sale_vehicle = 0, ERC-20 both legs,
 * market equality, range bound — is exercised against a real SQLite
 * schema by the migration-verification script; the fold under test here
 * receives already-scoped rows.)
 */
import { describe, expect, it } from 'vitest';
import {
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  foldRateCandles,
  type CandleFillRow,
} from '../src/rateCandles';

function fill(
  loanId: number,
  startAt: number,
  rateBps: number,
  principal = '1000',
): CandleFillRow {
  return {
    loan_id: loanId,
    start_at: startAt,
    interest_rate_bps: rateBps,
    principal,
  };
}

describe('enums', () => {
  it('pins the spec intervals and ranges exactly', () => {
    expect(CANDLE_INTERVALS).toEqual({ '1h': 3600, '4h': 14400, '1d': 86400 });
    expect(CANDLE_RANGES).toEqual({ '7d': 7, '30d': 30, '90d': 90, all: null });
  });

  it('rejects inherited object keys — raw query strings must not resolve Object.prototype members', () => {
    // Codex #1139 round-1 P3: `?interval=toString` on a plain object
    // literal returns Object.prototype.toString, bypassing the 400.
    // The enums are null-prototype, so every inherited name is undefined.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(CANDLE_INTERVALS[key]).toBeUndefined();
      expect(CANDLE_RANGES[key]).toBeUndefined();
      expect(Object.hasOwn(CANDLE_INTERVALS, key)).toBe(false);
      expect(Object.hasOwn(CANDLE_RANGES, key)).toBe(false);
    }
    expect(Object.getPrototypeOf(CANDLE_INTERVALS)).toBeNull();
    expect(Object.getPrototypeOf(CANDLE_RANGES)).toBeNull();
  });
});

describe('bucket boundary assignment', () => {
  it('floors start_at to the interval for 1h buckets', () => {
    // 3600..7199 all belong to t=3600; 7200 starts the next bucket.
    const buckets = foldRateCandles(
      [fill(1, 3600, 500), fill(2, 7199, 600), fill(3, 7200, 700)],
      3600,
    );
    expect(buckets.map((b) => b.t)).toEqual([3600, 7200]);
    expect(buckets[0].fills).toBe(2);
    expect(buckets[1].fills).toBe(1);
  });

  it('assigns the same fills to wider buckets under 4h and 1d intervals', () => {
    const rows = [fill(1, 3600, 500), fill(2, 7200, 600), fill(3, 90000, 700)];
    const fourH = foldRateCandles(rows, 14400);
    // 3600 and 7200 share the [0, 14400) bucket; 90000 → floor = 86400.
    expect(fourH.map((b) => [b.t, b.fills])).toEqual([
      [0, 2],
      [86400, 1],
    ]);
    const oneD = foldRateCandles(rows, 86400);
    expect(oneD.map((b) => [b.t, b.fills])).toEqual([
      [0, 2],
      [86400, 1],
    ]);
  });

  it('emits NO empty buckets between sparse fills (gaps render as gaps)', () => {
    const buckets = foldRateCandles(
      [fill(1, 0, 500), fill(2, 10 * 86400, 600)],
      86400,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.t)).toEqual([0, 10 * 86400]);
  });
});

describe('OHLC ordering', () => {
  it('open = chronologically first, close = last, high/low = extremes', () => {
    const buckets = foldRateCandles(
      [
        fill(1, 100, 520),
        fill(2, 200, 480), // low
        fill(3, 300, 610), // high
        fill(4, 400, 550),
      ],
      3600,
    );
    expect(buckets).toEqual([
      {
        t: 0,
        open: 520,
        high: 610,
        low: 480,
        close: 550,
        fills: 4,
        principalTotal: '4000',
      },
    ]);
  });

  it('breaks same-second ties by loan_id (on-chain execution order)', () => {
    // Same start_at; loan 7 executed before loan 9 → open=7's rate,
    // close=9's rate, regardless of input array order.
    const buckets = foldRateCandles([fill(9, 500, 700), fill(7, 500, 400)], 3600);
    expect(buckets[0].open).toBe(400);
    expect(buckets[0].close).toBe(700);
  });

  it('does not depend on caller-side row ordering (defensive sort)', () => {
    const shuffled = [fill(3, 900, 300), fill(1, 100, 100), fill(2, 500, 200)];
    const buckets = foldRateCandles(shuffled, 3600);
    expect(buckets[0].open).toBe(100);
    expect(buckets[0].close).toBe(300);
  });

  it('sorts buckets ascending by t even when rows arrive newest-first', () => {
    const buckets = foldRateCandles(
      [fill(2, 7200, 600), fill(1, 0, 500)],
      3600,
    );
    expect(buckets.map((b) => b.t)).toEqual([0, 7200]);
  });
});

describe('principal folding (BigInt, never Number)', () => {
  it('sums values past 2^53 without losing low-end digits', () => {
    // 2^53 = 9007199254740992 — adding 1 to it is a float no-op. Two
    // 18-dec wei-scale principals whose exact sum a float would corrupt:
    const a = '9007199254740993'; // 2^53 + 1
    const b = '9007199254740995'; // 2^53 + 3
    const buckets = foldRateCandles(
      [fill(1, 0, 500, a), fill(2, 1, 500, b)],
      3600,
    );
    expect(buckets[0].principalTotal).toBe('18014398509481988'); // exact
    // And a full 18-dec pair for good measure (1e24 + 1 wei).
    const big = foldRateCandles(
      [
        fill(1, 0, 500, '1000000000000000000000000'),
        fill(2, 1, 500, '1'),
      ],
      3600,
    );
    expect(big[0].principalTotal).toBe('1000000000000000000000001');
  });

  it('emits principalTotal as a decimal string (JSON-safe)', () => {
    const buckets = foldRateCandles([fill(1, 0, 500, '42')], 3600);
    expect(typeof buckets[0].principalTotal).toBe('string');
    expect(buckets[0].principalTotal).toBe('42');
  });

  it('skips a malformed-principal row entirely (fills stays consistent with the fold)', () => {
    const buckets = foldRateCandles(
      [fill(1, 0, 500, '100'), fill(2, 1, 900, 'not-a-number')],
      3600,
    );
    expect(buckets[0].fills).toBe(1);
    expect(buckets[0].principalTotal).toBe('100');
    expect(buckets[0].close).toBe(500); // the bad row's rate never lands
  });

  it('treats an empty principal as zero (stub-era rows)', () => {
    const buckets = foldRateCandles([fill(1, 0, 500, '')], 3600);
    expect(buckets[0].fills).toBe(1);
    expect(buckets[0].principalTotal).toBe('0');
  });
});

describe('empty input', () => {
  it('folds no rows to no buckets', () => {
    expect(foldRateCandles([], 3600)).toEqual([]);
  });
});
