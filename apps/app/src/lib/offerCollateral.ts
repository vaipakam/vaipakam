/**
 * #2378 r1 — what an offer's collateral IS, in words, for the Offer Book
 * card. The card used to fall back to a bare contract address whenever the
 * ERC-20 token details were missing — which is ALWAYS the case for NFT
 * collateral (an ERC-721/1155 has no `decimals()`), and also the case when
 * an ERC-20's details simply failed to load. Either way the lender lost the
 * one figure the card exists to show.
 */
import { AssetType } from './types';
import { formatTokenAmount, shortAddress } from './format';

export function offerCollateralText(args: {
  assetType: number;
  asset: string;
  amount: string | bigint;
  tokenId: string | bigint;
  quantity: string | bigint;
  /** ERC-20 token details, when they loaded. */
  meta: { decimals: number; symbol: string } | undefined;
  /** The token-details read failed (as opposed to still loading). */
  metaFailed: boolean;
  labels: { amountLoading: (token: string) => string; amountUnreadable: (token: string) => string };
}): string {
  const token = shortAddress(args.asset);
  if (args.assetType === AssetType.ERC721) return `NFT ${token} #${args.tokenId}`;
  if (args.assetType === AssetType.ERC1155) {
    const qty = BigInt(args.quantity);
    return `${qty > 1n ? `${qty} × ` : ''}NFT ${token} #${args.tokenId}`;
  }
  if (args.meta) return `${formatTokenAmount(BigInt(args.amount), args.meta.decimals)} ${args.meta.symbol}`;
  return args.metaFailed ? args.labels.amountUnreadable(token) : args.labels.amountLoading(token);
}
