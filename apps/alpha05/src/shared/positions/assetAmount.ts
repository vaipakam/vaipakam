/**
 * One leg of a loan in words, by its asset type: an ERC-20 as an amount of
 * the token, an NFT by its token id and collection, and an ERC-1155 with its
 * quantity. A loan's collateral or principal can be any of the three, so
 * every surface that names a leg (the loan page, a repayment's review) reads
 * it through this one rule, never as a token amount alone.
 */
import type { CopyAccess } from '../copy/useCopy';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { ASSET_ERC20 } from './model';

type Hex = `0x${string}`;

export interface AssetLeg {
  asset: Hex;
  assetType: number;
  /** The ERC-20 amount; unused for an NFT. */
  amount: bigint;
  tokenId: bigint;
  /** The ERC-1155 quantity; 1 or 0 for an ERC-721, which shows none. */
  quantity: bigint;
}

export function assetAmount(leg: AssetLeg, meta: TokenMetaMap | null, format: CopyAccess['format'], exact = false): string {
  if (leg.assetType === ASSET_ERC20) return tokenAmount(leg.amount, leg.asset, meta, format, exact);
  return format('asset.nft', { id: leg.tokenId.toString(), asset: assetName(leg.asset, meta) }) + (leg.quantity > 1n ? ` × ${leg.quantity.toString()}` : '');
}
