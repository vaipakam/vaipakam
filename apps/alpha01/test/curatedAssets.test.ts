import { describe, expect, it } from 'vitest';
import { mergeCuratedTokens } from '../src/lib/curatedAssets';

describe('mergeCuratedTokens', () => {
  it('adds canonical Base Sepolia assets when CoinGecko list is empty', () => {
    const merged = mergeCuratedTokens(84532, []);
    const addrs = merged.map((t) => t.contractAddress);
    expect(addrs).toContain('0x4200000000000000000000000000000000000006');
    expect(addrs).toContain('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
  });

  it('prefers CoinGecko entry over canonical placeholder on collision', () => {
    const remote = [
      {
        id: 'usd-coin',
        symbol: 'USDC',
        name: 'USD Coin',
        image: null,
        marketCapRank: 6,
        contractAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      },
    ];
    const merged = mergeCuratedTokens(84532, remote);
    expect(merged.find((t) => t.symbol === 'USDC')?.marketCapRank).toBe(6);
  });
});