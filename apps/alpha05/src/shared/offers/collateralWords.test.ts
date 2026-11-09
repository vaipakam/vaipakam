import { describe, expect, it } from 'vitest';
import type { CopyAccess } from '../copy/useCopy';
import { collateralWords, type CollateralTerms } from './collateralWords';
import { TLIQ } from './testOffer';

const format = ((k: string, v: Record<string, string>) => `${k}:${JSON.stringify(v)}`) as unknown as CopyAccess['format'];
const base: CollateralTerms = { collateralAssetType: 0, collateralAsset: TLIQ, collateralAmount: 100n, collateralAmountMax: 100n, collateralTokenId: 0n, collateralQuantity: 0n };

describe('collateralWords', () => {
  it('reads one amount as that amount', () => {
    expect(collateralWords(base, null, format)).not.toContain('offerBook.collateral');
  });
  it('reads a ranged request as floor to ceiling', () => {
    expect(collateralWords({ ...base, collateralAmountMax: 300n }, null, format)).toMatch(/^offerBook\.collateralRange:/);
  });
  it('says only the floor is known when the ceiling is unread', () => {
    expect(collateralWords({ ...base, collateralAmountMax: null }, null, format)).toMatch(/^offerBook\.collateralFloor:/);
  });
  it('counts an ERC-1155’s units', () => {
    expect(collateralWords({ ...base, collateralAssetType: 2, collateralTokenId: 7n, collateralQuantity: 5n }, null, format)).toMatch(/ × 5$/);
  });
  it('names an NFT by its id', () => {
    expect(collateralWords({ ...base, collateralAssetType: 1, collateralTokenId: 7n }, null, format)).toMatch(/^asset\.nft:.*"7"/);
  });
});

describe('offerLine', () => {
  it('counts an ERC-1155 rental’s units', async () => {
    const { offerLine } = await import('./offerLine');
    const text = ((k: string) => k) as unknown as CopyAccess['text'];
    const line = offerLine(
      {
        id: 3n,
        offerType: 0,
        assetType: 2,
        lendingAsset: TLIQ,
        amount: 10n,
        amountMax: 10n,
        interestRateBps: 0n,
        interestRateBpsMax: 0n,
        durationDays: 7n,
        tokenId: 9n,
        quantity: 4n,
        prepayAsset: TLIQ,
      },
      null,
      { text, format },
    );
    expect(line).toContain(' × 4');
  });
});
