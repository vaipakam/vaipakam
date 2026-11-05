import { describe, expect, it } from 'vitest';
import { formatAge, formatUnits, shortAddress } from './format';

describe('formatAge', () => {
  it('states seconds, minutes, then hours with the remaining minutes', () => {
    expect(formatAge(12)).toBe('12 s');
    expect(formatAge(240)).toBe('4 min');
    expect(formatAge(7_500)).toBe('2 h 5 min');
    expect(formatAge(7_200)).toBe('2 h');
    expect(formatAge(-5)).toBe('0 s');
  });
});

describe('formatUnits', () => {
  it('renders the exact figure, never rounded', () => {
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(1_234_567n, 6)).toBe('1.234567');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatUnits(-500_000n, 6)).toBe('-0.5');
    expect(formatUnits(0n, 18)).toBe('0');
  });
});

describe('shortAddress', () => {
  it('keeps the first six and last four characters', () => {
    expect(shortAddress('0x63816B149266C9dBFB7683dfd02D851915238049')).toBe('0x6381…8049');
  });
});
