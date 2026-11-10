import { describe, expect, it } from 'vitest';
import { addressParts, classifyCandidate, looksAlike, mergeKnown, type KnownAddress } from './lookalike';

type Hex = `0x${string}`;
const MINE = '0xAbC1111111111111111111111111111111111dEf' as Hex;
const SAVED: KnownAddress = { address: '0x1230000000000000000000000000000000000456', source: 'book', label: 'Savings' };
const OWN: KnownAddress = { address: MINE, source: 'own', label: null };

describe('look-alike addresses', () => {
  it('match on the first and last three hex digits, case ignored, and never on the same address', () => {
    expect(looksAlike(SAVED.address, '0x123ffffffffffffffffffffffffffffffffff456')).toBe(true);
    expect(looksAlike(MINE, '0xabc9999999999999999999999999999999999DEF')).toBe(true);
    expect(looksAlike(SAVED.address, SAVED.address)).toBe(false);
    expect(looksAlike(SAVED.address, '0x124ffffffffffffffffffffffffffffffffff456')).toBe(false);
    expect(looksAlike(SAVED.address, '0x123ffffffffffffffffffffffffffffffffff457')).toBe(false);
  });

  it('classifies what was typed', () => {
    const known = [OWN, SAVED];
    expect(classifyCandidate('  ', known)).toEqual({ kind: 'empty' });
    expect(classifyCandidate('0x12', known)).toEqual({ kind: 'invalid' });
    expect(classifyCandidate('hello', known)).toEqual({ kind: 'invalid' });
    expect(classifyCandidate(SAVED.address.toUpperCase().replace('0X', '0x'), known).kind).toBe('known');
    const lookalike = classifyCandidate('0x123ffffffffffffffffffffffffffffffffff456', known);
    expect(lookalike).toMatchObject({ kind: 'lookalike', of: SAVED });
    // The wallet's own address is imitated as readily as a saved one.
    expect(classifyCandidate('0xabc9999999999999999999999999999999999def', known)).toMatchObject({ kind: 'lookalike', of: OWN });
    expect(classifyCandidate('0x9990000000000000000000000000000000000111', known)).toEqual({
      kind: 'new',
      address: '0x9990000000000000000000000000000000000111',
    });
  });

  it('refuses mixed capitals that do not match the checksum', () => {
    // The correct checksum of 0xabc1…def, with one letter's case flipped.
    const flipped = MINE.replace('Ab', 'AB');
    expect(classifyCandidate(flipped, [])).toEqual({ kind: 'badChecksum' });
  });

  it('keeps the first source of an address listed twice', () => {
    const both = mergeKnown([OWN], [{ ...SAVED }, { address: MINE.toLowerCase() as Hex, source: 'book', label: 'Me' }]);
    expect(both.map((k) => k.source)).toEqual(['own', 'book']);
  });

  it('splits the full address for display without dropping a character', () => {
    const p = addressParts(SAVED.address);
    expect(p.head + p.middle + p.tail).toBe(SAVED.address);
    expect(p.head).toBe('0x123');
    expect(p.tail).toBe('456');
  });
});
