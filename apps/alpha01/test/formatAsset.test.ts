import { ASSET_TYPE_ERC721, ASSET_TYPE_ERC1155 } from '@vaipakam/defi-client';
import { describe, expect, it } from 'vitest';
import {
  formatHumanAssetAmount,
  formatIndexedAmount,
  formatNftLabel,
  formatRawAssetAmount,
  formatRawTokenAmount,
} from '../src/lib/formatAsset';

describe('formatAsset', () => {
  it('formats human amounts with symbol', () => {
    expect(formatHumanAssetAmount('0.1', { address: '0x1', symbol: 'mWETH', decimals: 18, chainId: 84532 }, '0x1')).toBe(
      '0.1 mWETH',
    );
    expect(formatHumanAssetAmount('100', { address: '0x2', symbol: 'mUSDC', decimals: 6, chainId: 84532 }, '0x2')).toBe(
      '100 mUSDC',
    );
  });

  it('formats raw on-chain amounts with decimals', () => {
    expect(formatRawTokenAmount('1000000', 6)).toBe('1');
    expect(
      formatRawAssetAmount('1000000000000000000', { address: '0x1', symbol: 'mWETH', decimals: 18, chainId: 84532 }, '0x1'),
    ).toBe('1 mWETH');
  });

  it('does not assume 18 decimals when metadata is unresolved', () => {
    expect(formatIndexedAmount('1000000', null, '0x2', 0, '0')).toBe('1000000');
    expect(formatRawAssetAmount('1000000', null, '0x2')).toBe('1000000');
  });

  it('formats ERC721 collateral by token id, not wei decimals', () => {
    expect(formatNftLabel(ASSET_TYPE_ERC721, '1', '110')).toBe('NFT #110');
    expect(
      formatIndexedAmount('1', { address: '0xabc', symbol: 'rNFT', decimals: 18, chainId: 84532 }, '0xabc', ASSET_TYPE_ERC721, '110'),
    ).toBe('NFT #110');
    expect(
      formatRawAssetAmount('1', { address: '0xabc', symbol: 'rNFT', decimals: 18, chainId: 84532 }, '0xabc', ASSET_TYPE_ERC721, '110'),
    ).toBe('NFT #110 rNFT');
  });

  it('formats ERC1155 collateral with quantity', () => {
    expect(formatNftLabel(ASSET_TYPE_ERC1155, '5', '42')).toBe('5 × NFT #42');
  });
});