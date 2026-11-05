import { describe, expect, it } from 'vitest';
import { formatAge, formatBps, formatScaled, formatSpan, formatUnits, formatUtc, shortAddress } from './format';

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

describe('formatBps', () => {
  it('is the exact percentage', () => {
    expect(formatBps(500n)).toBe('5');
    expect(formatBps(525n)).toBe('5.25');
    expect(formatBps(1n)).toBe('0.01');
  });
});

describe('formatScaled', () => {
  it('cuts to the places asked for, never rounding up, with digit groups', () => {
    expect(formatScaled(1_234_567_800_000_000_000_000n)).toBe('1,234.56');
    expect(formatScaled(1_999_999_999_999_999_999n)).toBe('1.99');
    expect(formatScaled(0n)).toBe('0.00');
    expect(formatScaled(1_500_000_000_000_000_000n, 0)).toBe('1');
  });
});

describe('formatSpan', () => {
  it('counts whole days from two days up and hours below', () => {
    expect(formatSpan(3 * 86_400 + 5)).toBe('3 days');
    expect(formatSpan(2 * 86_400)).toBe('2 days');
    expect(formatSpan(86_400 + 3_600)).toBe('25 h');
  });
});

describe('formatUtc', () => {
  it('labels the moment as UTC', () => {
    expect(formatUtc(0, 'en-GB')).toBe('1 Jan 1970, 00:00 UTC');
  });
});
