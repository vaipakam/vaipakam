import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, fingerprint, termsFrom, termsUrl } from './terms';

const HASH = `0x${'ab'.repeat(32)}` as const;

describe('termsFrom', () => {
  it('gates nothing when no version is in force', () => {
    expect(termsFrom(0, HASH, false, null)).toEqual({ kind: 'none' });
    expect(termsFrom(0, HASH, true, null)).toEqual({ kind: 'none' });
  });
  it('reports the current pair as accepted', () => {
    expect(termsFrom(2, HASH, true, { version: 2, acceptedAt: 10 })).toEqual({ kind: 'accepted', version: 2, hash: HASH });
  });
  it('asks again when a newer version is in force, naming the earlier acceptance', () => {
    expect(termsFrom(3, HASH, false, { version: 2, acceptedAt: 10 })).toEqual({ kind: 'needed', version: 3, hash: HASH, previous: { version: 2, acceptedAt: 10 } });
  });
  it('asks a wallet that never accepted', () => {
    expect(termsFrom(1, HASH, false, null)).toEqual({ kind: 'needed', version: 1, hash: HASH, previous: null });
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
