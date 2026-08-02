/**
 * The retained-reserve derivation (#1525 / #1349 M5).
 *
 * `platformRetained = bucket − outstandingRecycled − keeperBudget`, floored
 * at zero — ratified in TokenomicsTechSpec and plan §M5. Both the keeper
 * term and the floor were arrived at by review rather than by design, so
 * both are pinned here.
 */
import { describe, expect, it } from 'vitest';

import { retainedFrom } from '../src/recycleRoutes';

const T = (n: bigint) => n * 10n ** 18n;

describe('retainedFrom', () => {
  it('nets BOTH the outstanding commitments and the keeper budget', () => {
    // The keeper term is why the two-term derivation from `getRecycleBucket`
    // alone is wrong: once the register runs, each day's margin is earmarked
    // into `recycleKeeperBudget` from INSIDE the bucket, so the bucket does
    // not move and a reserve computed without it overstates.
    expect(retainedFrom(T(100n), T(30n), T(20n))).toBe(T(50n));
  });

  it('overstates by exactly the keeper budget if that term is dropped', () => {
    // Stated as its own case because the wrong answer is plausible: it is
    // the right shape, the right magnitude, and only ever too generous.
    const withKeeper = retainedFrom(T(100n), T(30n), T(20n));
    const withoutKeeper = retainedFrom(T(100n), T(30n), 0n);
    expect(withoutKeeper - withKeeper).toBe(T(20n));
  });

  it('floors at zero rather than reporting a negative reserve', () => {
    // The subtraction genuinely goes negative in the breached state #1460
    // describes. A negative reserve on a public page reads as a display
    // bug rather than as the shortfall it is; the balance published beside
    // it is what makes that state visible instead.
    expect(retainedFrom(T(10n), T(30n), T(5n))).toBe(0n);
  });

  it('returns zero exactly at the boundary, not a rounding artefact', () => {
    expect(retainedFrom(T(50n), T(30n), T(20n))).toBe(0n);
  });

  it('is exact at wei scale — no float path', () => {
    expect(retainedFrom(10n ** 30n + 3n, 1n, 1n)).toBe(10n ** 30n + 1n);
  });
});
