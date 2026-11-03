import { describe, expect, it } from 'vitest';
import { ASSET_KIND } from '../data/protectedAccount';
import { assetLabel, isAssetKind, MAX_UINT256, tokenIdOf } from './recoverAsset';
import { EMPTY_RECOVER_PREFILL, parseRecoverPrefill, recoverHref } from './recoverPrefill';

const NFT = '0x1111111111111111111111111111111111111111';

describe('recoverHref / parseRecoverPrefill (#3096)', () => {
  it('round-trips every kind', () => {
    for (const [kind, id] of [
      [ASSET_KIND.ERC20, 0n],
      [ASSET_KIND.ERC721, 42n],
      [ASSET_KIND.ERC1155, MAX_UINT256],
    ] as const) {
      const href = recoverHref(kind, NFT, id);
      expect(href.startsWith('/recover?')).toBe(true);
      expect(parseRecoverPrefill(href.slice('/recover'.length))).toEqual({
        kind,
        asset: NFT,
        tokenId: kind === ASSET_KIND.ERC20 ? '' : id.toString(),
      });
    }
  });

  it('carries no token id for an ERC-20', () => {
    expect(recoverHref(ASSET_KIND.ERC20, NFT, 7n)).toBe(`/recover?kind=0&asset=${NFT}`);
  });

  it('reads a bare arrival as the blank form', () => {
    expect(parseRecoverPrefill('')).toEqual(EMPTY_RECOVER_PREFILL);
  });

  it('reads anything malformed as the blank form, never a partial one', () => {
    for (const search of [
      `?kind=3&asset=${NFT}&tokenId=1`, // unknown kind
      `?kind=1&asset=0x123&tokenId=1`, // not an address
      `?kind=1&asset=${NFT}`, // NFT without a token id
      `?kind=1&asset=${NFT}&tokenId=-1`,
      `?kind=1&asset=${NFT}&tokenId=1.5`,
      `?kind=2&asset=${NFT}&tokenId=${(MAX_UINT256 + 1n).toString()}`,
      `?kind=0&asset=${NFT}&tokenId=1`, // ERC-20 with a token id
      `?asset=${NFT}`, // no kind
    ]) {
      expect(parseRecoverPrefill(search)).toEqual(EMPTY_RECOVER_PREFILL);
    }
  });

  it('never carries a declared source or an amount', () => {
    const p = parseRecoverPrefill(`?kind=1&asset=${NFT}&tokenId=1&source=${NFT}&amount=5`);
    expect(Object.keys(p).sort()).toEqual(['asset', 'kind', 'tokenId']);
  });
});

describe('recoverAsset (#3096)', () => {
  it('accepts exactly the three kinds', () => {
    expect([0, 1, 2].every(isAssetKind)).toBe(true);
    expect([3, -1, '1', null, undefined].some(isAssetKind)).toBe(false);
  });

  it('forces an ERC-20 token id to zero, like the contract', () => {
    expect(tokenIdOf(ASSET_KIND.ERC20, '')).toBe(0n);
    expect(tokenIdOf(ASSET_KIND.ERC20, '99')).toBe(0n);
  });

  it('takes an NFT token id only as a uint256', () => {
    expect(tokenIdOf(ASSET_KIND.ERC721, '0')).toBe(0n);
    expect(tokenIdOf(ASSET_KIND.ERC1155, MAX_UINT256.toString())).toBe(MAX_UINT256);
    expect(tokenIdOf(ASSET_KIND.ERC721, '')).toBeNull();
    expect(tokenIdOf(ASSET_KIND.ERC721, '1e3')).toBeNull();
    expect(tokenIdOf(ASSET_KIND.ERC1155, (MAX_UINT256 + 1n).toString())).toBeNull();
  });

  it('names an NFT by collection and token id', () => {
    expect(assetLabel(ASSET_KIND.ERC20, 'USDC', 0n)).toBe('USDC');
    expect(assetLabel(ASSET_KIND.ERC721, 'vRENT', 5n)).toBe('vRENT #5');
  });
});
