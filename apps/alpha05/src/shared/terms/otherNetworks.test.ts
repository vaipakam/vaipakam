import { describe, expect, it } from 'vitest';
import { listedForNotice, networkTerms } from './otherNetworks';
import { termsFrom, type TermsPosture } from './terms';

const HASH = `0x${'ab'.repeat(32)}` as const;
const H2 = `0x${'cd'.repeat(32)}` as const;
const ann = { version: 3, hash: H2, effectiveAt: 100, minVersion: 3, newVersion: true };
const posture = (p: Partial<TermsPosture>): TermsPosture => ({ latest: 2, latestHash: HASH, minimum: 1, announced: ann, accepted: [2], ...p });

describe('networkTerms and listedForNotice', () => {
  it('lists a current network with an uncovered change and something that would stop', () => {
    const n = networkTerms(termsFrom(posture({}), true, null), 1, 0, true);
    expect(n).toMatchObject({ current: true, due: { version: 3 } });
    expect(listedForNotice(n)).toBe(true);
  });
  it('does not list a network where the wallet has nothing found', () => {
    expect(listedForNotice(networkTerms(termsFrom(posture({}), true, null), 0, 0, true))).toBe(false);
  });
  it('does not list a network where the change is already accepted', () => {
    expect(listedForNotice(networkTerms(termsFrom(posture({ accepted: [2, 3] }), true, null), 2, 1, true))).toBe(false);
  });
  it('does not list a network where the wallet is not current: it is asked at its next use there', () => {
    const n = networkTerms(termsFrom(posture({ accepted: [] }), false, null), 1, 1, true);
    expect(n.current).toBe(false);
    expect(listedForNotice(n)).toBe(false);
  });
  it('a network with no Terms in force is never listed', () => {
    expect(listedForNotice(networkTerms(termsFrom(posture({ latest: 0 }), true, null), 3, 3, true))).toBe(false);
  });
});
