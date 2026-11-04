import { describe, expect, it } from 'vitest';
import { formatRequestCode } from './requestCode';

describe('formatRequestCode', () => {
  it('renders 30 bits as six base32 characters, high bits first', () => {
    expect(formatRequestCode(0)).toBe('AAAAAA');
    expect(formatRequestCode((1 << 30) - 1)).toBe('777777');
    expect(formatRequestCode(1)).toBe('AAAAAB');
    expect(formatRequestCode(32)).toBe('AAAABA');
    expect(formatRequestCode(1n << 25n)).toBe('BAAAAA');
  });

  it('accepts a bigint and a number alike', () => {
    expect(formatRequestCode(123456789n)).toBe(formatRequestCode(123456789));
  });

  it('refuses anything that is not a 30-bit integer', () => {
    expect(formatRequestCode(-1)).toBeNull();
    expect(formatRequestCode(1 << 30)).toBeNull();
    expect(formatRequestCode(1.5)).toBeNull();
    expect(formatRequestCode(Number.NaN)).toBeNull();
    expect(formatRequestCode(1n << 30n)).toBeNull();
  });
});
