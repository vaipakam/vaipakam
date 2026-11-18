import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, fingerprint, termsFrom, termsUrl, type TermsPosture } from './terms';

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
