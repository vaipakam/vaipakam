import { describe, it, expect } from 'vitest';
import {
  platformForChain,
  isTestnet,
  COINGECKO_PLATFORMS,
} from '../../src/lib/chainPlatforms';

describe('platformForChain', () => {
  it('returns the mapped platform for known mainnets', () => {
    expect(platformForChain(1)).toBe('ethereum');
    expect(platformForChain(8453)).toBe('base');
    expect(platformForChain(137)).toBe('polygon-pos');
    expect(platformForChain(42161)).toBe('arbitrum-one');
    expect(platformForChain(56)).toBe('binance-smart-chain');
    expect(platformForChain(10)).toBe('optimistic-ethereum');
  });

  it('returns null for unknown / testnet chainIds', () => {
    expect(platformForChain(11155111)).toBeNull(); // Sepolia
    expect(platformForChain(84532)).toBeNull(); // Base Sepolia
    expect(platformForChain(999_999)).toBeNull();
  });

  it('returns null for null / undefined / 0', () => {
    expect(platformForChain(null)).toBeNull();
    expect(platformForChain(undefined)).toBeNull();
    expect(platformForChain(0)).toBeNull();
  });
});

describe('isTestnet', () => {
  it('reports every known mainnet as non-testnet', () => {
    for (const cid of Object.keys(COINGECKO_PLATFORMS).map(Number)) {
      expect(isTestnet(cid)).toBe(false);
    }
  });

  it('treats unmapped chainIds as testnets', () => {
    expect(isTestnet(11155111)).toBe(true); // Sepolia
    expect(isTestnet(31337)).toBe(true); // anvil
  });

  it('returns false for null / undefined / 0 (no chain, not a testnet either)', () => {
    expect(isTestnet(null)).toBe(false);
    expect(isTestnet(undefined)).toBe(false);
    expect(isTestnet(0)).toBe(false);
  });
});
