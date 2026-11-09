import { describe, expect, it } from 'vitest';
import { SUPPORTED_CHAINS } from './chains';
import { hasPublicQueue } from './publicQueue';

describe('hasPublicQueue', () => {
  it('names Ethereum, BNB Chain, BNB Testnet, Polygon and Polygon Amoy, and no rollup', () => {
    expect(hasPublicQueue(1)).toBe(true);
    expect(hasPublicQueue(56)).toBe(true);
    expect(hasPublicQueue(97)).toBe(true);
    expect(hasPublicQueue(137)).toBe(true);
    expect(hasPublicQueue(80002)).toBe(true);
    for (const id of [8453, 42161, 10, 84532, 421614]) expect(hasPublicQueue(id)).toBe(false);
  });

  it('decides every network the app serves', () => {
    const decided = new Set([1, 56, 97, 8453, 42161, 10, 84532, 421614]);
    for (const c of SUPPORTED_CHAINS) expect(decided.has(c.chainId)).toBe(true);
  });
});
