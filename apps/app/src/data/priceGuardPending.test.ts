import { describe, expect, it } from 'vitest';
import { parsePriceGuardPending, sourceName, wordAsSetting } from './priceGuardPending';

const w = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as `0x${string}`;
const GUARD = '0x00000000000000000000000000000000000000aa';

describe('the price guard pending list (#3453)', () => {
  it('reads a well-formed list, naming each kind by this build', () => {
    const v = parsePriceGuardPending({
      guard: GUARD,
      listedFromBlock: 100,
      sinceDeploy: false,
      changes: [
        { kind: 2, kindName: 'Spoofed', subject: w(0), value: w(0xfeed), executableAt: 5, proposedBlock: 101, knobKey: 'ethNumeraireFeed' },
      ],
    });
    expect(v?.changes[0].kindName).toBe('EthNumeraireFeed');
    expect(v?.changes[0].knobKey).toBe('ethNumeraireFeed');
    expect(v?.listedFromBlock).toBe(100);
  });

  it('refuses a list it cannot read instead of showing it as empty', () => {
    expect(parsePriceGuardPending(undefined)).toBeUndefined();
    expect(parsePriceGuardPending({ guard: GUARD, listedFromBlock: 1, sinceDeploy: true })).toBeUndefined();
    expect(
      parsePriceGuardPending({
        guard: GUARD,
        listedFromBlock: 1,
        sinceDeploy: true,
        changes: [{ kind: 2, subject: 'x', value: w(1), executableAt: 1, proposedBlock: 1 }],
      }),
    ).toBeUndefined();
  });

  it('writes a word the way the setting reads it', () => {
    expect(wordAsSetting(w(0xfeed), 'address')).toBe(`0x${'0'.repeat(36)}feed`);
    expect(wordAsSetting(w(300), 'seconds')).toBe('300');
    expect(wordAsSetting(w(7), 'bytes32')).toBe(w(7));
    expect(sourceName(w(1))).toBe('Api3');
    expect(sourceName(w(9))).toBe(w(9));
  });
});
