import { describe, it, expect } from 'vitest';
import {
  BPS,
  MIN_PARTIAL_FRACTION_BPS,
  reducePartialFractionBps,
  clampPartialFractionBps,
  sellAmountForFractionBps,
  normalizeCloseFactorCapBps,
  MAX_PARTIAL_FRACTION_BPS,
  runPartialAttempts,
  type PartialAttemptDeps,
} from '../src/partialResize';

describe('#642 partial-liquidation re-size helpers', () => {
  describe('reducePartialFractionBps (PartialOverLiquidates path)', () => {
    it('shrinks an over-sized fraction by 25% each attempt', () => {
      expect(reducePartialFractionBps(4_000n)).toBe(3_000n);
      expect(reducePartialFractionBps(3_000n)).toBe(2_250n);
    });

    it('shrinks strictly, so a run of re-sizes always reaches the floor', () => {
      let f = BPS;
      let steps = 0;
      while (f >= MIN_PARTIAL_FRACTION_BPS) {
        const next = reducePartialFractionBps(f);
        expect(next).toBeLessThan(f);
        f = next;
        steps++;
      }
      // From the largest legal size: eleven sizes at or above the floor (ten
      // shrinks between them), then the floor stops it.
      expect(steps).toBe(11);
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

  describe('runPartialAttempts (#2733)', () => {
    type Q = { calls: readonly unknown[] };
    const route: Q = { calls: [{}] };
    const revert = (name: string) => new Error(`execution reverted: ${name}(1, 2)`);

    /** A Diamond whose partial band is `[restoreBps, ceilingBps]`: a slice
     *  below it is refused as too small to restore HF, one above it as
     *  over-liquidating. */
    const deps = (over: Partial<PartialAttemptDeps<Q>> & { restoreBps?: bigint; ceilingBps?: bigint } = {}) => {
      const sent: bigint[] = [];
      const restore = over.restoreBps ?? 0n;
      const ceiling = over.ceilingBps ?? BPS;
      const d: PartialAttemptDeps<Q> = {
        submit: async (f) => {
          sent.push(f);
          if (f > ceiling) throw revert('PartialOverLiquidates');
          if (f < restore) throw revert('PartialMustRestoreHF');
          return '0xabc';
        },
        reQuote: async () => route,
        readCloseFactorCapBps: async () => BPS,
        isFatal: () => false,
        log: () => {},
        ...over,
      };
      return { d, sent };
    };

    it('tries every size it computes: 7,400 under a 4,000 ceiling lands at 3,121', async () => {
      const { d, sent } = deps({ ceilingBps: 4_000n });
      const out = await runPartialAttempts(7_400n, route, d);
      expect(sent).toEqual([7_400n, 5_550n, 4_162n, 3_121n]);
      expect(out).toMatchObject({ kind: 'submitted', fractionBps: 3_121n, attempt: 3 });
    });

    it('a shrink that overshoots the band is bisected back into it, not skipped', async () => {
      const { d, sent } = deps({ restoreBps: 3_500n, ceilingBps: 4_000n });
      const out = await runPartialAttempts(7_400n, route, d);
      // 3,121 is too small; the midpoint of (3,121, 4,162) is in the band.
      expect(sent).toEqual([7_400n, 5_550n, 4_162n, 3_121n, 3_641n]);
      expect(out).toMatchObject({ kind: 'submitted', fractionBps: 3_641n });
    });

    it('a first estimate below the band grows into it, not skipped', async () => {
      const { d, sent } = deps({ restoreBps: 5_000n, ceilingBps: 6_000n });
      const out = await runPartialAttempts(3_000n, route, d);
      expect(sent).toEqual([3_000n, 4_000n, 5_334n]);
      expect(out).toMatchObject({ kind: 'submitted', fractionBps: 5_334n });
    });

    it('escalates when no whole bps size passes, after narrowing the bracket to nothing', async () => {
      // Too small below 4,001, over-liquidating above 4,000: an empty band.
      const { d, sent } = deps({ restoreBps: 4_001n, ceilingBps: 4_000n });
      const out = await runPartialAttempts(7_400n, route, d);
      expect(out).toEqual({ kind: 'escalate' });
      expect(sent).toContain(4_000n);
      expect(sent).toContain(4_001n);
      expect(sent.length).toBeLessThan(30);
      expect(new Set(sent).size).toBe(sent.length);
    });

    it('escalates when growing would leave the partial band', async () => {
      const { d, sent } = deps({ restoreBps: 9_000n });
      const out = await runPartialAttempts(5_000n, route, d);
      expect(out).toEqual({ kind: 'escalate' });
      expect(sent.every((f) => f < MAX_PARTIAL_FRACTION_BPS)).toBe(true);
    });

    it('escalates only once the next size would be under the floor', async () => {
      // A ceiling no slice can meet: every size down to the floor is tried.
      const { d, sent } = deps({ ceilingBps: 0n });
      const out = await runPartialAttempts(7_400n, route, d);
      expect(out).toEqual({ kind: 'escalate' });
      expect(sent.at(-1)).toBeGreaterThanOrEqual(MIN_PARTIAL_FRACTION_BPS);
      expect(reducePartialFractionBps(sent.at(-1)!)).toBeLessThan(MIN_PARTIAL_FRACTION_BPS);
      for (let i = 1; i < sent.length; i++) expect(sent[i]).toBeLessThan(sent[i - 1]);
    });

    it('clamps to the close-factor cap, and escalates when the capped slice cannot restore HF', async () => {
      const sent: bigint[] = [];
      const out = await runPartialAttempts(6_000n, route, {
        ...deps().d,
        submit: async (f) => {
          sent.push(f);
          throw revert(f > 3_000n ? 'InvalidPartialFraction' : 'PartialMustRestoreHF');
        },
        readCloseFactorCapBps: async () => 3_000n,
      });
      expect(sent).toEqual([6_000n, 3_000n]);
      expect(out).toEqual({ kind: 'escalate' });
    });

    it('skips, not escalates, when a re-quote finds no route or a refusal is unclassified', async () => {
      const noRoute = await runPartialAttempts(7_400n, route, { ...deps({ ceilingBps: 0n }).d, reQuote: async () => null });
      expect(noRoute).toEqual({ kind: 'skip' });
      const unknown = await runPartialAttempts(5_000n, route, {
        ...deps().d,
        submit: async () => {
          throw revert('PartialSwapAllFailed');
        },
      });
      expect(unknown).toEqual({ kind: 'skip' });
    });

    it('escalates on a refusal that says a partial is the wrong tool', async () => {
      const out = await runPartialAttempts(5_000n, route, {
        ...deps().d,
        submit: async () => {
          throw revert('PartialAfterMaturity');
        },
      });
      expect(out).toEqual({ kind: 'escalate' });
    });

    it('rethrows a fatal error (the run deadline) unclassified', async () => {
      const fatal = new Error('past run deadline');
      await expect(
        runPartialAttempts(5_000n, route, {
          ...deps().d,
          submit: async () => {
            throw fatal;
          },
          isFatal: (e) => e === fatal,
        }),
      ).rejects.toBe(fatal);
    });
  });
});
