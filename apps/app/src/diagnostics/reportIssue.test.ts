/**
 * The report redaction contract (#2024).
 *
 * `reportIssue.ts` states it in its own header — "wallet address is
 * SHORTENED to 0x1234…abcd — the full address never leaves the device via a
 * report" — and the published Privacy Policy repeats it to users. Until this
 * file existed, nothing tested it: `redactText` and `redactCap` had no unit
 * coverage at all, which is how a percent-encoded address passed the scrubber
 * unnoticed.
 *
 * The cases below are written against the CONTRACT rather than the
 * implementation: what must never survive into a report, and what must
 * survive intact. A redactor that mangles a transaction hash is a different
 * defect from one that leaks an address, and both would be regressions.
 */
import { describe, expect, it } from 'vitest';
import { redactAddress, redactCap, redactText } from './reportIssue';

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const SHORT = '0x1234…5678';

/** Percent-encode every character, the strongest form of the #2024 case. */
const pctAll = (s: string): string =>
  [...s].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');

describe('redactText — plain addresses', () => {
  it('shortens an address anywhere in the text', () => {
    expect(redactText(`crash at ${ADDR} while loading`)).toBe(
      `crash at ${SHORT} while loading`,
    );
  });

  it('shortens an uppercase 0X prefix too', () => {
    expect(redactText(ADDR.replace('0x', '0X'))).toBe('0X1234…5678');
  });

  it('shortens every occurrence, not just the first', () => {
    expect(redactText(`${ADDR} and ${ADDR}`)).toBe(`${SHORT} and ${SHORT}`);
  });

  it('leaves a 32-byte transaction hash intact', () => {
    // The negative lookahead exists for this: support needs hashes whole,
    // and a mangled prefix would neither redact nor preserve anything.
    const hash = `0x${'a'.repeat(64)}`;
    expect(redactText(hash)).toBe(hash);
  });

  it('leaves ordinary text alone', () => {
    expect(redactText('no addresses here, 0x12 is too short')).toBe(
      'no addresses here, 0x12 is too short',
    );
  });
});

describe('redactText — percent-encoded addresses (#2024)', () => {
  it('shortens a fully percent-encoded address', () => {
    const out = redactText(`/offers?wallet=${pctAll(ADDR)}`);
    expect(out).toBe(`/offers?wallet=${SHORT}`);
  });

  it('shortens a partially encoded address', () => {
    // Only the `0x` escaped — enough to defeat a literal-only matcher.
    const partial = `%30%78${ADDR.slice(2)}`;
    expect(redactText(`?w=${partial}`)).toBe(`?w=${SHORT}`);
  });

  it('leaves the surrounding text spelled exactly as it was', () => {
    // The decode is for SEARCHING only. A reader still needs the rest of
    // the URL as it actually appeared, escapes included.
    const out = redactText(`/a%20b?wallet=${pctAll(ADDR)}&next=%2Fhome`);
    expect(out).toBe(`/a%20b?wallet=${SHORT}&next=%2Fhome`);
  });

  it('handles an encoded and a plain address in one string', () => {
    const out = redactText(`plain ${ADDR} encoded ${pctAll(ADDR)}`);
    expect(out).toBe(`plain ${SHORT} encoded ${SHORT}`);
  });

  it('does not decode a percent-encoded transaction hash into a false match', () => {
    const hash = `0x${'b'.repeat(64)}`;
    expect(redactText(pctAll(hash))).toBe(pctAll(hash));
  });
});

describe('redactText — malformed input must never throw', () => {
  // `decodeURIComponent` rejects all of these. A diagnostics helper that
  // throws becomes a crash source in the crash reporter, which is the one
  // place it must not.
  for (const bad of ['%', '%z', '%zz', '%2', 'a%', '%%%', '100%', '%e0%a4%a']) {
    it(`survives ${JSON.stringify(bad)}`, () => {
      expect(() => redactText(bad)).not.toThrow();
      expect(redactText(bad)).toBe(bad);
    });
  }

  it('still finds an address alongside a malformed escape', () => {
    expect(redactText(`%zz ${pctAll(ADDR)}`)).toBe(`%zz ${SHORT}`);
  });
});

describe('redactCap', () => {
  it('redacts before capping, so truncation cannot strand a partial address', () => {
    // Capping first would cut the address mid-run and leave hex the
    // whole-text scrubber no longer recognises.
    const out = redactCap(`${ADDR} tail`, 12);
    expect(out).not.toContain(ADDR);
    expect(out.startsWith('0x1234…')).toBe(true);
  });

  it('redacts an encoded address before capping too', () => {
    const out = redactCap(pctAll(ADDR), 40);
    expect(out).not.toContain('%30');
    expect(out).toContain('0x1234…5678');
  });
});

describe('redactAddress', () => {
  it('shortens a connected address', () => {
    expect(redactAddress(ADDR)).toBe(SHORT);
  });

  it('says so when there is no wallet', () => {
    expect(redactAddress(undefined)).toBe('not connected');
  });
});
