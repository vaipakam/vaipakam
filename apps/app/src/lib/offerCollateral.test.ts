/** #2378 r1 — the Offer Book names what an offer's collateral is, never
 *  just a contract address. */
import { describe, expect, it } from 'vitest';
import { offerCollateralText } from './offerCollateral';

const asset = '0x00000000000000000000000000000000000000ab';
const labels = {
  amountLoading: (t: string) => `${t} (amount loading…)`,
  amountRaw: (a: string, t: string) => `${a} base units of ${t} (token details couldn’t be read)`,
  atLeast: (a: string) => `at least ${a}`,
  forFullOffer: (a: string) => `${a} for the full offer (proportionally less for part of it)`,
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
  it('states a borrower offer floor as "at least" (#2378 r2)', () => {
    expect(
      offerCollateralText({
        ...base,
        assetType: 0,
        amount: '150000000000000000000',
        meta: { decimals: 18, symbol: 'tLIQ' },
        floorOnly: true,
      }),
    ).toBe('at least 150 tLIQ');
  });
  it('says an ERC-20 amount is loading — never a bare address', () => {
    expect(offerCollateralText({ ...base, assetType: 0, amount: '5' })).toContain('amount loading');
  });
  it('keeps the recorded amount, in raw base units, when token details fail (#2378 r8)', () => {
    const failed = offerCollateralText({ ...base, assetType: 0, amount: '5000', metaFailed: true });
    expect(failed).toMatch(/^5000 base units of .+ \(token details couldn’t be read\)$/);
  });
  it('states a part-takeable lender offer as the full-offer requirement (#2378 r8)', () => {
    const meta = { decimals: 18, symbol: 'tLIQ' };
    const amount = '150000000000000000000';
    expect(offerCollateralText({ ...base, assetType: 0, amount, meta, scalesWithAmount: true })).toBe(
      '150 tLIQ for the full offer (proportionally less for part of it)',
    );
    // An offer that can only be taken whole states the figure as exact.
    expect(offerCollateralText({ ...base, assetType: 0, amount, meta, scalesWithAmount: false })).toBe('150 tLIQ');
  });
});
