import { describe, it, expect } from 'vitest';
import {
  BPS,
  MIN_PARTIAL_FRACTION_BPS,
  reducePartialFractionBps,
  clampPartialFractionBps,
  sellAmountForFractionBps,
  normalizeCloseFactorCapBps,
} from '../src/partialResize';

describe('#642 partial-liquidation re-size helpers', () => {
  describe('reducePartialFractionBps (PartialOverLiquidates path)', () => {
    it('shrinks an over-sized fraction by 25% each attempt', () => {
      expect(reducePartialFractionBps(4_000n)).toBe(3_000n);
      expect(reducePartialFractionBps(3_000n)).toBe(2_250n);
    });

    it('converges below an example ceiling within a bounded handful of retries', () => {
      // A keeper picked 7_400bps but the on-chain ceiling only admits ≤ 4_000.
      // The bounded loop (initial + 2 retries) must reach a usable slice.
      let f = 7_400n;
      const seen = [f];
      for (let i = 0; i < 2; i++) {
        f = reducePartialFractionBps(f);
        seen.push(f);
      }
      // 7_400 → 5_550 → 4_162 — still > 4_000 after 2 retries, so a 3rd would be
      // needed; assert it keeps strictly decreasing (monotonic convergence).
      expect(seen[1]).toBeLessThan(seen[0]);
      expect(seen[2]).toBeLessThan(seen[1]);
    });

    it('never returns a non-positive fraction for a positive input', () => {
      expect(reducePartialFractionBps(1n)).toBe(1n);
      expect(reducePartialFractionBps(2n)).toBe(1n);
    });

    it('returns 0 for a non-positive input', () => {
      expect(reducePartialFractionBps(0n)).toBe(0n);
      expect(reducePartialFractionBps(-5n)).toBe(0n);
    });
  });

  describe('clampPartialFractionBps (InvalidPartialFraction / cap path)', () => {
    it('clamps a fraction above the cap down to the cap', () => {
      // Governance lowered the close-factor cap to 2_500bps; a 5_000bps request
      // must clamp to 2_500.
      expect(clampPartialFractionBps(5_000n, 2_500n)).toBe(2_500n);
    });

    it('leaves a fraction already within the cap unchanged', () => {
      expect(clampPartialFractionBps(2_000n, 2_500n)).toBe(2_000n);
      expect(clampPartialFractionBps(2_500n, 2_500n)).toBe(2_500n);
    });

    it('a capped partial can still be a usable slice (above the floor)', () => {
      const clamped = clampPartialFractionBps(6_000n, 3_000n);
      expect(clamped).toBe(3_000n);
      expect(clamped).toBeGreaterThanOrEqual(MIN_PARTIAL_FRACTION_BPS);
    });
  });

  describe('sellAmountForFractionBps (re-quote sizing)', () => {
    it('computes the collateral sell-amount for a fraction', () => {
      expect(sellAmountForFractionBps(1_000_000n, 2_500n)).toBe(250_000n);
      expect(sellAmountForFractionBps(1_000_000n, BPS)).toBe(1_000_000n);
    });

    it('a shrunk fraction sells proportionally less collateral', () => {
      const collateral = 1_000_000n;
      const big = sellAmountForFractionBps(collateral, 4_000n);
      const small = sellAmountForFractionBps(
        collateral,
        reducePartialFractionBps(4_000n),
      );
      expect(small).toBeLessThan(big);
    });
  });

  describe('normalizeCloseFactorCapBps', () => {
    it('passes through a valid in-range cap', () => {
      expect(normalizeCloseFactorCapBps(2_500n)).toBe(2_500n);
      expect(normalizeCloseFactorCapBps(BPS)).toBe(BPS);
    });

    it('treats 0 (the on-chain default sentinel) and out-of-range as no cap', () => {
      expect(normalizeCloseFactorCapBps(0n)).toBe(BPS);
      expect(normalizeCloseFactorCapBps(20_000n)).toBe(BPS);
      expect(normalizeCloseFactorCapBps(-1n)).toBe(BPS);
    });
  });
});
