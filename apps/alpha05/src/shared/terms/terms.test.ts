import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, countingVersion, fingerprint, termsFrom, updateTerms, termsUrl, type TermsPosture } from './terms';

const HASH = `0x${'ab'.repeat(32)}` as const;

const H2 = `0x${'cd'.repeat(32)}` as const;
const posture = (p: Partial<TermsPosture>): TermsPosture => ({ latest: 2, latestHash: HASH, minimum: 1, announced: null, accepted: [], ...p });

describe('termsFrom', () => {
  it('gates nothing when no version is in force', () => {
    expect(termsFrom(posture({ latest: 0 }), true, null)).toEqual({ kind: 'none' });
  });
  it('follows the protocol verdict and asks for the latest version', () => {
    const t = termsFrom(posture({ accepted: [] }), false, null);
    expect(t).toMatchObject({ kind: 'needed', version: 2, hash: HASH, previous: null, alsoAnnounced: null });
  });
  it('keeps a wallet current on an older counted version after a small change, without asking', () => {
    const t = termsFrom(posture({ accepted: [1] }), true, { version: 1, acceptedAt: 10 });
    expect(t).toMatchObject({ kind: 'accepted', version: 2, latestAccepted: false, due: null });
  });
  it('names a material change a current wallet has not covered, with its version', () => {
    const announced = { version: 3, hash: H2, effectiveAt: 1_000, minVersion: 3, newVersion: true };
    const t = termsFrom(posture({ accepted: [2], announced }), true, null);
    expect(t).toMatchObject({ kind: 'accepted', latestAccepted: true, due: announced });
    expect(termsFrom(posture({ accepted: [2, 3], announced }), true, null)).toMatchObject({ due: null });
  });
  it('a raise of the minimum to the latest is due for a wallet on an older version only', () => {
    const announced = { version: 2, hash: HASH, effectiveAt: 1_000, minVersion: 2, newVersion: false };
    expect(termsFrom(posture({ accepted: [1], announced }), true, null)).toMatchObject({ due: announced });
    expect(termsFrom(posture({ accepted: [2], announced }), true, null)).toMatchObject({ due: null });
  });
  it('a wallet joining during a notice accepts the announced new version in the same step', () => {
    const announced = { version: 3, hash: H2, effectiveAt: 1_000, minVersion: 3, newVersion: true };
    expect(termsFrom(posture({ announced }), false, null)).toMatchObject({ kind: 'needed', version: 2, alsoAnnounced: announced });
  });
});

describe('updateTerms', () => {
  const ann = (p: Partial<NonNullable<TermsPosture['announced']>>) => ({ version: 3, hash: H2, effectiveAt: 100, minVersion: 3, newVersion: true, ...p });
  const accepted = (p: Partial<TermsPosture>) => {
    const t = termsFrom(posture(p), true, null);
    if (t.kind !== 'accepted') throw new Error('not current');
    return t;
  };
  it('offers nothing to a wallet on the latest version with nothing announced', () => {
    expect(updateTerms(accepted({ accepted: [2] }))).toBeNull();
  });
  it('offers the latest after a small change, optionally', () => {
    expect(updateTerms(accepted({ accepted: [1] }))).toMatchObject({ version: 2, alsoAnnounced: null });
  });
  it('offers the announced version alone when the latest is already accepted', () => {
    expect(updateTerms(accepted({ accepted: [2], announced: ann({}) }))).toMatchObject({ version: 3, hash: H2, alsoAnnounced: null });
  });
  it('offers the latest with the announced version when neither is accepted', () => {
    expect(updateTerms(accepted({ accepted: [1], announced: ann({}) }))).toMatchObject({ version: 2, alsoAnnounced: { version: 3 } });
  });
  it('a raised minimum asks for the latest', () => {
    expect(updateTerms(accepted({ accepted: [1], announced: ann({ version: 2, hash: HASH, minVersion: 2, newVersion: false }) }))).toMatchObject({
      version: 2,
      alsoAnnounced: null,
    });
  });
});

describe('countingVersion', () => {
  it('is the newest accepted version between the minimum and the latest', () => {
    expect(countingVersion(posture({ latest: 4, minimum: 2, accepted: [1, 3] }))).toBe(3);
    expect(countingVersion(posture({ latest: 4, minimum: 2, accepted: [1] }))).toBe(0);
  });
});

describe('Terms links and fingerprint', () => {
  it('links the version-pinned page and the privacy notice', () => {
    expect(termsUrl(4)).toBe('https://vaipakam.com/terms/v4');
    expect(PRIVACY_URL).toBe('https://vaipakam.com/privacy');
  });
  it('shows the whole hash, grouped', () => {
    const f = fingerprint(HASH);
    expect(f.replace(/[\s]/g, '')).toBe(HASH);
    expect(f.split(' ')).toHaveLength(9);
  });
});
