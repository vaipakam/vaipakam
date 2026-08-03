/**
 * The retained-reserve derivation (#1525 / #1349 M5).
 *
 * `platformRetained = bucket − outstandingRecycled − keeperBudget`, floored
 * at zero — ratified in TokenomicsTechSpec and plan §M5. Both the keeper
 * term and the floor were arrived at by review rather than by design, so
 * both are pinned here.
 */
import { describe, expect, it } from 'vitest';

import {
  retainedFrom,
  snapshotMaxAgeMs,
  storedPayloadIsComplete,
} from '../src/recycleRoutes';

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

describe('storedPayloadIsComplete', () => {
  const good = {
    vpfiBalance: '100', bucket: '40', unearmarked: '60',
    outstandingRecycled: '10', paidOutRecycled: '2', keeperBudget: '5',
    platformRetained: '25', releasedRemitStranded: '0',
  };

  it('accepts a complete payload', () => {
    expect(storedPayloadIsComplete(good)).toBe(true);
  });

  it('rejects syntactically valid but empty JSON', () => {
    // `{}` parses fine and would previously have been spread into the
    // response with `unavailableReason: null`, so any consumer honouring
    // the all-or-nothing contract would publish an empty block believing
    // it complete. The frontend gate protects the dashboard and nothing
    // else; the contract has to hold where it is stated.
    expect(storedPayloadIsComplete({})).toBe(false);
    expect(storedPayloadIsComplete(null)).toBe(false);
    expect(storedPayloadIsComplete('nope')).toBe(false);
  });

  it('rejects a payload missing ANY single member', () => {
    for (const k of Object.keys(good)) {
      const partial: Record<string, string> = { ...good };
      delete partial[k];
      expect(storedPayloadIsComplete(partial), `missing ${k}`).toBe(false);
    }
  });

  it('rejects wrong types and non-decimal strings', () => {
    expect(storedPayloadIsComplete({ ...good, bucket: 40 })).toBe(false);
    expect(storedPayloadIsComplete({ ...good, bucket: '4,0' })).toBe(false);
    expect(storedPayloadIsComplete({ ...good, bucket: '' })).toBe(false);
    expect(storedPayloadIsComplete({ ...good, bucket: '-1' })).toBe(false);
  });
});

describe('snapshotMaxAgeMs', () => {
  const MIN = 30 * 60_000;

  it('never drops below the floor', () => {
    expect(snapshotMaxAgeMs(1, 1, 1, 1)).toBe(MIN);
  });

  it('uses the STORED rotation when the current set is transiently smaller', () => {
    // A Secrets Store blip shrinks the readable chain set. Computing from
    // it alone would expire a healthy snapshot during an unrelated
    // failure.
    const stored = snapshotMaxAgeMs(11, 5, 1, 5);
    expect(stored).toBe(11 * 5 * 2 * 60_000);
  });

  it('uses the CURRENT rotation when config change makes the next refresh slower', () => {
    // Switching legacy(1min) -> DO(5min), or adding chains, leaves old
    // rows carrying the shorter cadence until their turn comes round —
    // and their expiry would fire before that turn arrives.
    const current = snapshotMaxAgeMs(7, 1, 7, 5);
    expect(current).toBe(7 * 5 * 2 * 60_000);
    // The stored-only answer would have been well short of the real
    // 35-minute rotation.
    expect(7 * 1 * 2 * 60_000).toBeLessThan(7 * 5 * 60_000);
  });

  it('takes the larger of the two, not the newer', () => {
    // Neither input is authoritative on its own: the row knows what
    // produced it, the environment knows what will refresh it next.
    expect(snapshotMaxAgeMs(11, 5, 3, 1)).toBe(snapshotMaxAgeMs(3, 1, 11, 5));
  });
});
