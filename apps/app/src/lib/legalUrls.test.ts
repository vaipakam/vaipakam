/**
 * The version-pinned Terms link (#1998). The gate records acceptance
 * against an on-chain version — the link it offers must resolve to
 * that version's frozen text, and must never mint a pinned URL for a
 * version number that names nothing.
 */
import { describe, expect, it } from 'vitest';
import { LEGAL_URLS, termsUrlForVersion } from './legalUrls';

describe('termsUrlForVersion', () => {
  it('pins the on-chain version to its frozen route', () => {
    expect(termsUrlForVersion(1)).toBe('https://vaipakam.com/terms/v1');
    expect(termsUrlForVersion(37)).toBe('https://vaipakam.com/terms/v37');
  });

  it('falls back to the current-terms URL when no real version is known', () => {
    // 0 is the hook's not-yet-read / dormant-gate value; nothing is
    // published at /terms/v0, and a fractional or negative version
    // could only come from a bug upstream.
    expect(termsUrlForVersion(0)).toBe(LEGAL_URLS.terms);
    expect(termsUrlForVersion(-3)).toBe(LEGAL_URLS.terms);
    expect(termsUrlForVersion(1.5)).toBe(LEGAL_URLS.terms);
  });
});
