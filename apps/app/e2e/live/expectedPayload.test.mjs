/**
 * #2422 r2 — the signing gate's structural comparator. The live drive that
 * uses it signs on a funded wallet and its happy path cannot exercise the
 * refusals, so the refusals are pinned here.
 */
import { describe, expect, it } from 'vitest';

import { is, optional, structMismatches } from './expectedPayload.mjs';

describe('structMismatches — closed in both directions', () => {
  it('accepts an exact match across encodings', () => {
    expect(
      structMismatches(
        { amount: 5n, rate: 1200, who: '0xAbC0000000000000000000000000000000000001', full: false },
        { amount: '5', rate: 1200n, who: '0xabc0000000000000000000000000000000000001', full: false },
      ),
    ).toEqual([]);
    expect(structMismatches({ q: 20n }, { q: '0x14' })).toEqual([]);
  });

  it('refuses a field the expected object does not name', () => {
    // The whole point: a field nobody listed is refused, not ignored.
    expect(structMismatches({ a: 1n }, { a: 1n, acceptorFull: true })).toEqual([
      'acceptorFull: unexpected field true',
    ]);
  });

  it('refuses a missing field unless it is optional', () => {
    expect(structMismatches({ a: 1n, b: 2n }, { a: 1n })).toEqual(['b: missing (want 2n)']);
    expect(structMismatches({ a: 1n, gas: optional(is('any', () => true)) }, { a: 1n })).toEqual([]);
  });

  it('checks an optional field when it IS present', () => {
    expect(structMismatches({ value: optional(0n) }, { value: '0x1' })).toEqual([
      'value: "0x1" (want 0)',
    ]);
  });

  it('recurses into nested structs and names the path', () => {
    expect(
      structMismatches(
        { args: { terms: { acceptorFull: false, acceptorMaxCStar: 0n } } },
        { args: { terms: { acceptorFull: true, acceptorMaxCStar: 7n } } },
      ),
    ).toEqual(['args.terms.acceptorFull: true (want false)', 'args.terms.acceptorMaxCStar: 7n (want 0)']);
  });

  it('is strict about booleans and non-hex strings', () => {
    expect(structMismatches({ ok: true }, { ok: 1 })).toEqual(['ok: 1 (want true)']);
    expect(structMismatches({ name: 'AcceptTerms' }, { name: 'acceptterms' })).toHaveLength(1);
  });

  it('compares arrays by length and element', () => {
    expect(structMismatches([1n, 2n], [1n])).toEqual(['(root): 1 elements (want 2)']);
    expect(structMismatches([{ n: 'a' }], [{ n: 'b' }])).toEqual(['[0].n: "b" (want "a")']);
  });

  it('applies a matcher and prints its rule on failure', () => {
    const cap = is('≤ 10', (v) => BigInt(v) <= 10n);
    expect(structMismatches({ amount: cap }, { amount: 9n })).toEqual([]);
    expect(structMismatches({ amount: cap }, { amount: 11n })).toEqual(['amount: 11n (want ≤ 10)']);
    // A matcher that throws is a mismatch, never a pass.
    expect(structMismatches({ x: is('bigint', (v) => BigInt(v) > 0n) }, { x: 'nope' })).toHaveLength(1);
  });

  it('refuses a non-integer where an integer is expected', () => {
    expect(structMismatches({ n: 1n }, { n: '1.5' })).toEqual(['n: "1.5" (want 1)']);
    expect(structMismatches({ n: 1n }, { n: null })).toHaveLength(1);
  });
});
