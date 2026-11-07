import { describe, expect, it } from 'vitest';
import { assetAmount } from './assetAmount';

const A = '0x00000000000000000000000000000000000000aa' as const;
const meta = { [A]: { symbol: 'TKN', decimals: 18 } } as never;
const format = (k: string, v?: Record<string, string>) => `${k}:${Object.values(v ?? {}).join(',')}`;

describe('assetAmount', () => {
  it('names an ERC-721 by its token id, with no quantity', () => {
    expect(assetAmount({ asset: A, assetType: 1, amount: 0n, tokenId: 7n, quantity: 1n }, meta, format)).toBe('asset.nft:7,TKN');
  });
  it('names an ERC-1155 by its token id and quantity', () => {
    expect(assetAmount({ asset: A, assetType: 2, amount: 0n, tokenId: 7n, quantity: 5n }, meta, format)).toBe('asset.nft:7,TKN × 5');
  });
});
