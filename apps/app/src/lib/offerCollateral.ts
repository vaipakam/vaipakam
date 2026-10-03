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
  /** #2378 r2 — the indexed amount is only the offer's FLOOR (a borrower
   *  offer can commit a collateral range, and the row does not carry the
   *  ceiling yet — #2382). The figure is then stated as "at least". */
  floorOnly?: boolean;
  /** #2378 r8 — a LENDER offer's collateral is the requirement at its full
   *  amount, and matching scales it to the part taken. Where the offer can
   *  be taken in part (a range, or already partly taken), the figure is
   *  stated as the full-offer requirement rather than as exact. */
  scalesWithAmount?: boolean;
  labels: {
    amountLoading: (token: string) => string;
    /** #2378 r8 — token details failed: the recorded amount is still known,
     *  so it is stated in raw base units with the failure named. */
    amountRaw: (amount: string, token: string) => string;
    atLeast: (amount: string) => string;
    forFullOffer: (amount: string) => string;
  };
}): string {
  const token = shortAddress(args.asset);
  if (args.assetType === AssetType.ERC721) return `NFT ${token} #${args.tokenId}`;
  if (args.assetType === AssetType.ERC1155) {
    const qty = BigInt(args.quantity);
    return `${qty > 1n ? `${qty} × ` : ''}NFT ${token} #${args.tokenId}`;
  }
  let text: string;
  if (args.meta) {
    text = `${formatTokenAmount(BigInt(args.amount), args.meta.decimals)} ${args.meta.symbol}`;
  } else if (args.metaFailed) {
    text = args.labels.amountRaw(BigInt(args.amount).toString(), token);
  } else {
    return args.labels.amountLoading(token);
  }
  if (args.floorOnly) return args.labels.atLeast(text);
  if (args.scalesWithAmount) return args.labels.forFullOffer(text);
  return text;
}
