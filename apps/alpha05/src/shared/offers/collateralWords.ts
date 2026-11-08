import type { CopyAccess } from '../copy/useCopy';
import { ASSET_ERC20 } from '../positions/model';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';

type Hex = `0x${string}`;

/** The collateral side of an offer, as far as a reader knows it. */
export interface CollateralTerms {
  collateralAssetType: number;
  collateralAsset: Hex;
  /** The amount, or a borrower request's floor. */
  collateralAmount: bigint;
  /** A borrower request's ceiling (equal to the floor for one amount);
   *  null when the source has not read it. */
  collateralAmountMax: bigint | null;
  collateralTokenId: bigint;
}

/**
 * The collateral an offer asks for or pledges, in words. A borrower request
 * may pledge a range, so a ranged one reads "floor to ceiling", and one whose
 * ceiling the source has not read says the floor is all that is known: the
 * floor alone would read as the whole commitment (RB-OFFER-BOOK).
 */
export function collateralWords(t: CollateralTerms, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  if (t.collateralAssetType !== ASSET_ERC20) return format('asset.nft', { id: t.collateralTokenId.toString(), asset: assetName(t.collateralAsset, meta) });
  const min = tokenAmount(t.collateralAmount, t.collateralAsset, meta, format);
  if (t.collateralAmountMax === null) return format('offerBook.collateralFloor', { min });
  if (t.collateralAmountMax > t.collateralAmount) return format('offerBook.collateralRange', { min, max: tokenAmount(t.collateralAmountMax, t.collateralAsset, meta, format) });
  return min;
}
