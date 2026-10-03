/** #2378 r1 — the Offer Book names what an offer's collateral is, never
 *  just a contract address. */
import { describe, expect, it } from 'vitest';
import { offerCollateralText } from './offerCollateral';

const asset = '0x00000000000000000000000000000000000000ab';
const labels = {
  amountLoading: (t: string) => `${t} (amount loading…)`,
  amountUnreadable: (t: string) => `${t} (amount couldn’t be read)`,
};
const base = { asset, amount: '0', tokenId: '0', quantity: '0', meta: undefined, metaFailed: false, labels };

describe('offerCollateralText', () => {
  it('names an ERC-721 by token id', () => {
    expect(offerCollateralText({ ...base, assetType: 1, tokenId: '7' })).toMatch(/^NFT .+ #7$/);
  });
  it('names an ERC-1155 by token id and quantity', () => {
    expect(offerCollateralText({ ...base, assetType: 2, tokenId: '7', quantity: '3' })).toMatch(/^3 × NFT .+ #7$/);
    expect(offerCollateralText({ ...base, assetType: 2, tokenId: '7', quantity: '1' })).toMatch(/^NFT .+ #7$/);
  });
  it('states an ERC-20 amount when its details loaded', () => {
    expect(
      offerCollateralText({ ...base, assetType: 0, amount: '150000000000000000000', meta: { decimals: 18, symbol: 'tLIQ' } }),
    ).toBe('150 tLIQ');
  });
  it('says an ERC-20 amount is loading, or could not be read — never a bare address', () => {
    const loading = offerCollateralText({ ...base, assetType: 0, amount: '5' });
    const failed = offerCollateralText({ ...base, assetType: 0, amount: '5', metaFailed: true });
    expect(loading).toContain('amount loading');
    expect(failed).toContain('couldn’t be read');
  });
});
