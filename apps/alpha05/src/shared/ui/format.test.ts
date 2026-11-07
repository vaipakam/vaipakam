import { describe, expect, it } from 'vitest';
import { formatAge, formatBps, formatExact, formatFigure, formatFigureText, formatScaled, formatSpan, formatUnits, formatUtc, shortAddress } from './format';

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
  it('states a moment past what a date can hold exactly, never throwing', () => {
    expect(formatUtc(10n ** 22n, 'en-GB')).toBe('Unix time 10000000000000000000000 UTC');
    expect(formatUtc(1e16, 'en-GB')).toBe('Unix time 10000000000000000 UTC');
    expect(formatUtc(1_800_000_000n, 'en-GB')).toBe(formatUtc(1_800_000_000, 'en-GB'));
  });
});

describe('formatFigure', () => {
  it('groups the whole part and leaves a short fraction exact', () => {
    expect(formatFigure(1_000n * 10n ** 18n, 18)).toEqual({ text: '1,000', cut: false });
    expect(formatFigure(1_234_567_500_000n, 6)).toEqual({ text: '1,234,567.5', cut: false });
  });
  it('keeps four places once there is a whole part, cut toward zero', () => {
    expect(formatFigure(1_000_939_726_027_397_260_273n, 18)).toEqual({ text: '1,000.9397', cut: true });
    expect(formatFigure(1_999_999_999_999_999_999n, 18)).toEqual({ text: '1.9999', cut: true });
  });
  it('keeps four significant digits below one, never reading as zero', () => {
    expect(formatFigure(958_904_109_589_041_095n, 18)).toEqual({ text: '0.9589', cut: true });
    expect(formatFigure(19_178_082_191_780_821n, 18)).toEqual({ text: '0.01917', cut: true });
    expect(formatFigure(12n, 18)).toEqual({ text: '0.000000000000000012', cut: false });
    expect(formatFigure(123_456n, 18)).toEqual({ text: '0.0000000000001234', cut: true });
  });
  it('drops trailing zeros left by the cut and handles zero and negatives', () => {
    expect(formatFigure(1_000_000_9n, 7)).toEqual({ text: '1', cut: true });
    expect(formatFigure(0n, 18)).toEqual({ text: '0', cut: false });
    expect(formatFigure(-1_500_250_000n, 6)).toEqual({ text: '-1,500.25', cut: false });
  });
  it('writes an exact figure with every digit and digit groups', () => {
    expect(formatExact(1_000_939_726_027_397_260_273n, 18)).toBe('1,000.939726027397260273');
    expect(formatExact(2_000n * 10n ** 18n, 18)).toBe('2,000');
  });
  it('marks a cut figure in a sentence', () => {
    expect(formatFigureText(958_904_109_589_041_095n, 18)).toBe('≈ 0.9589');
    expect(formatFigureText(10n ** 16n, 18)).toBe('0.01');
  });
});
