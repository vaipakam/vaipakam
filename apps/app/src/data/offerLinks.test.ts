import { describe, expect, it } from 'vitest';
import { AssetType } from '../lib/types';
import { isRentalListing, offerAcceptPath } from './offerLinks';

const base = { offerId: 9, chainId: 84532 };

describe('offerAcceptPath', () => {
  it('borrows against a lending offer and lends into a borrow request', () => {
    expect(offerAcceptPath({ ...base, offerType: 0, assetType: AssetType.ERC20 })).toBe(
      '/borrow?offer=9&chain=84532',
    );
    expect(offerAcceptPath({ ...base, offerType: 1, assetType: AssetType.ERC20 })).toBe(
      '/lend?offer=9&chain=84532',
    );
  });

  it('rents an NFT listing', () => {
    expect(offerAcceptPath({ ...base, offerType: 0, assetType: AssetType.ERC721 })).toBe(
      '/rent?offer=9&chain=84532',
    );
    expect(isRentalListing({ offerType: 0, assetType: AssetType.ERC1155 })).toBe(true);
    expect(isRentalListing({ offerType: 1, assetType: AssetType.ERC721 })).toBe(false);
  });
});
