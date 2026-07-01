import { describe, it, expect } from 'vitest';
import { SUPPORTED_CHAINS, DEFAULT_CHAIN } from '../../src/contracts/config';

describe('chain config', () => {
  it('defaults to base-sepolia (canonical testnet; Sepolia retired from the active set)', () => {
    // With the active-chains export narrowed to the Phase-1 testnet set
    // (Base Sepolia 84532 + Arb Sepolia 421614), Sepolia (11155111) is no longer
    // a deployed chain, so the default resolver falls through to the first
    // deployed testnet by priority — Base Sepolia. (#853)
    expect(DEFAULT_CHAIN).toBe(SUPPORTED_CHAINS.baseSepolia);
    expect(DEFAULT_CHAIN.chainId).toBe(84532);
    expect(DEFAULT_CHAIN.diamondAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
