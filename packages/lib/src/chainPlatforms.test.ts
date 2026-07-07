import { describe, it, expect } from 'vitest';
import {
  COINGECKO_PLATFORMS,
  platformForChain,
  isTestnet,
} from './chainPlatforms';

describe('platformForChain', () => {
  it('maps every known mainnet chainId to its CoinGecko platform slug', () => {
    expect(platformForChain(1)).toBe('ethereum');
    expect(platformForChain(10)).toBe('optimistic-ethereum');
    expect(platformForChain(56)).toBe('binance-smart-chain');
    expect(platformForChain(137)).toBe('polygon-pos');
    expect(platformForChain(8453)).toBe('base');
    expect(platformForChain(42161)).toBe('arbitrum-one');
  });

  it('returns null for an unmapped chainId (e.g. a testnet)', () => {
    // Base Sepolia — deliberately unmapped; CoinGecko does not index testnets.
    expect(platformForChain(84532)).toBeNull();
    expect(platformForChain(11155111)).toBeNull();
  });

  it('returns null for null / undefined / zero (no chain connected)', () => {
    expect(platformForChain(null)).toBeNull();
    expect(platformForChain(undefined)).toBeNull();
    // 0 is falsy — treated as "no chain", not looked up.
    expect(platformForChain(0)).toBeNull();
  });

  it('stays in sync with the exported COINGECKO_PLATFORMS table', () => {
    for (const [id, slug] of Object.entries(COINGECKO_PLATFORMS)) {
      expect(platformForChain(Number(id))).toBe(slug);
    }
  });
});

describe('isTestnet', () => {
  it('reports false for a mapped mainnet chainId', () => {
    expect(isTestnet(1)).toBe(false);
    expect(isTestnet(8453)).toBe(false);
    expect(isTestnet(42161)).toBe(false);
  });

  it('reports true for an unmapped chainId (testnet or unknown)', () => {
    expect(isTestnet(84532)).toBe(true); // Base Sepolia
    expect(isTestnet(11155111)).toBe(true); // Sepolia
    expect(isTestnet(999999)).toBe(true); // unknown chain
  });

  it('reports false when no chain is connected (null / undefined / zero)', () => {
    // A missing chain is "no discovery", not "testnet" — the caller must not
    // treat a disconnected wallet as though it were on a testnet.
    expect(isTestnet(null)).toBe(false);
    expect(isTestnet(undefined)).toBe(false);
    expect(isTestnet(0)).toBe(false);
  });

  it('is the exact complement of platformForChain for real chainIds', () => {
    for (const id of [1, 10, 56, 137, 8453, 42161, 84532, 11155111]) {
      expect(isTestnet(id)).toBe(platformForChain(id) === null);
    }
  });
});
