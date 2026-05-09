import { describe, it, expect } from 'vitest';
import { SUPPORTED_CHAINS, DEFAULT_CHAIN } from '../../src/contracts/config';

describe('chain config', () => {
  it('defaults to sepolia', () => {
    expect(DEFAULT_CHAIN).toBe(SUPPORTED_CHAINS.sepolia);
    expect(DEFAULT_CHAIN.chainId).toBe(11155111);
    expect(DEFAULT_CHAIN.diamondAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
