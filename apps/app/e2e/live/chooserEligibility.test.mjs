import { describe, expect, it } from 'vitest';

import {
  EXCLUSION_WORDS,
  chooserExclusion,
  defaultGraceSeconds,
  graceSecondsFromBuckets,
  setAsideByDerivedGate,
} from './chooserEligibility.mjs';
import { earlyRepayChooserExclusion } from '../../src/data/earlyRepayChooser.ts';
import {
  defaultGraceSeconds as appDefaultGraceSeconds,
  graceSecondsFromBuckets as appGraceSecondsFromBuckets,
} from '../../src/lib/grace.ts';

/**
 * The drive's mirror against the app's own rules (#1557). Exhaustive over
 * the chooser's facts, so a clause the page gains and the drive lacks
 * cannot pass.
 */
const FACTS = [
  'viewerIsBorrower',
  'active',
  'rental',
  'offsetPending',
  'graceVerifiablyOver',
  'closedThisSession',
];

describe('the drive mirrors the chooser render rule (#1557)', () => {
  const combos = [];
  for (let mask = 0; mask < 1 << FACTS.length; mask++) {
    combos.push(Object.fromEntries(FACTS.map((k, i) => [k, Boolean(mask & (1 << i))])));
  }

  it(`agrees with the app on all ${1 << FACTS.length} combinations`, () => {
    for (const f of combos) {
      expect(chooserExclusion(f), JSON.stringify(f)).toBe(earlyRepayChooserExclusion(f));
    }
  });

  it('has words for every reason either side can name', () => {
    for (const f of combos) {
      const reason = earlyRepayChooserExclusion(f);
      if (reason !== null) expect(EXCLUSION_WORDS[reason], reason).toBeTypeOf('string');
    }
  });

  it('renders exactly once among the combinations', () => {
    expect(combos.filter((f) => chooserExclusion(f) === null)).toHaveLength(1);
  });
});

describe('the drive mirrors the grace bucket walk (#1557)', () => {
  const b = (maxDurationDays, graceSeconds) => ({
    maxDurationDays: BigInt(maxDurationDays),
    graceSeconds: BigInt(graceSeconds),
  });
  const SETS = {
    // Base Sepolia today: the zero-bucket default schedule.
    empty: [],
    catchAllOnly: [b(0, 7_200)],
    tiered: [b(7, 3_600), b(30, 86_400), b(0, 172_800)],
    // No catch-all and nothing matches: the contract takes the LAST entry.
    malformed: [b(7, 3_600), b(30, 86_400)],
    catchAllFirst: [b(0, 600), b(30, 86_400)],
  };
  const DAYS = [0, 1, 6, 7, 8, 29, 30, 31, 89, 90, 179, 180, 364, 365, 366, 1_000];

  for (const [name, set] of Object.entries(SETS)) {
    it(`agrees with the app on the ${name} set`, () => {
      for (const d of DAYS) {
        expect(graceSecondsFromBuckets(set, BigInt(d)), `${name} @ ${d}d`).toBe(
          appGraceSecondsFromBuckets(set, d),
        );
      }
    });
  }

  it('agrees on the default schedule at every boundary', () => {
    for (const d of DAYS) {
      expect(defaultGraceSeconds(BigInt(d)), `${d}d`).toBe(appDefaultGraceSeconds(d));
    }
  });

  it('never reads an empty set as zero grace', () => {
    for (const d of DAYS) expect(graceSecondsFromBuckets([], d) > 0n).toBe(true);
  });
});

describe('setAsideByDerivedGate (#1557, direction 2)', () => {
  const SHOWN = {
    viewerIsBorrower: true,
    active: true,
    rental: false,
    offsetPending: false,
    graceVerifiablyOver: false,
    closedThisSession: false,
  };
  const loan = (id, over) => ({ id, facts: { ...SHOWN, ...over } });

  it('names only loans whose sole obstacle is a gate the drive derived', () => {
    const loans = [
      loan(1, { graceVerifiablyOver: true }),
      loan(2, { offsetPending: true }),
      loan(3, { rental: true, graceVerifiablyOver: true }),
      loan(4, { active: false }),
      loan(5, { viewerIsBorrower: false }),
      loan(6, {}),
    ];
    expect(setAsideByDerivedGate(loans, (l) => l.facts).map((l) => l.id)).toEqual([1, 2]);
  });

  it('is empty when nothing was set aside by a derived gate', () => {
    expect(setAsideByDerivedGate([loan(1, { rental: true })], (l) => l.facts)).toEqual([]);
  });
});
