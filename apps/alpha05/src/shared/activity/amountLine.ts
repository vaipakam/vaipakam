import type { CopyAccess } from '../copy/useCopy';
import { ASSET_ERC20 } from '../positions/model';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { ActivityEvent } from './activity';

/** `AssetType.ERC1155`: a token id held in a number of copies. */
const ASSET_ERC1155 = 2;

/** What the event moved, as the index recorded it, or a statement that it
 *  recorded none. Never rebuilt from the event's raw arguments. */
export function amountLine(e: ActivityEvent, meta: TokenMetaMap | null, { text, format }: CopyAccess): string {
  if (e.asset !== null && e.assetType === ASSET_ERC20 && e.amount !== null) {
    const shown = tokenAmount(e.amount, e.asset, meta, format);
    return e.amountMax !== null && e.amountMax !== e.amount ? `${shown} – ${tokenAmount(e.amountMax, e.asset, meta, format)}` : shown;
  }
  if (e.asset !== null && e.assetType === ASSET_ERC20 && e.amountMax !== null) return format('activity.upTo', { amount: tokenAmount(e.amountMax, e.asset, meta, format) });
  if (e.asset !== null && e.tokenId !== null) {
    const nft = format('asset.nft', { id: e.tokenId.toString(), asset: assetName(e.asset, meta) });
    if (e.assetType === ASSET_ERC1155) {
      // A multi-copy token: a quantity the index did not record is said, never
      // read as one copy.
      return e.quantity === null ? format('activity.copiesUnknown', { nft }) : `${nft} × ${e.quantity.toString()}`;
    }
    return nft;
  }
  return text('activity.noAmount');
}
