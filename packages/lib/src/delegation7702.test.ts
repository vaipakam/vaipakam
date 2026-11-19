import { describe, expect, it } from 'vitest';
import { delegationKey, readDelegation } from './delegation7702';

describe('readDelegation (#3434)', () => {
  it('reads no code, a designator and other code apart', () => {
    expect(readDelegation(undefined)).toEqual({ kind: 'none' });
    expect(readDelegation('0x')).toEqual({ kind: 'none' });
    const d = readDelegation('0xef010000000000000000000000000000000000000000ab');
    expect(d).toEqual({ kind: 'delegated', delegate: '0x00000000000000000000000000000000000000AB' });
    expect(delegationKey(d)).toBe('0x00000000000000000000000000000000000000ab');
    // A designator with trailing bytes is not one; it is contract code.
    expect(readDelegation('0xef010000000000000000000000000000000000000000ab00')).toEqual({ kind: 'contract' });
    expect(readDelegation('0x6080604052')).toEqual({ kind: 'contract' });
    expect(delegationKey({ kind: 'none' })).toBe('');
  });
});
