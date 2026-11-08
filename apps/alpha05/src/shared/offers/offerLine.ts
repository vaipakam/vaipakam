/**
 * One offer in words, the same on every page that lists the wallet's offers
 * (Home's open offers, the Offers page): its side, what it lends or asks
 * for (a range when it has one), its rate and its duration. A rental carries
 * no rate: its amount is the daily fee, in the prepay asset.
 */
import type { CopyAccess } from '../copy/useCopy';
import { ASSET_ERC20, OFFER_TYPE_LENDER } from '../positions/model';
import { assetAmount } from '../positions/assetAmount';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps } from '../ui/format';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** The fields an offer's line reads. */
export interface OfferLineFields {
  id: bigint;
  offerType: number;
  assetType: number;
  lendingAsset: Hex;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  durationDays: bigint;
  tokenId: bigint;
  /** An ERC-1155 rental's unit count (1 or 0 for an ERC-721). */
  quantity: bigint;
  prepayAsset: Hex;
}

/** An amount of the offer's lending asset in words, or the NFT it names
 *  (with its unit count for an ERC-1155), through the one leg rule. */
export function offerAmount(o: OfferLineFields, v: bigint, meta: TokenMetaMap | null, format: Copy['format']): string {
  return assetAmount({ asset: o.lendingAsset, assetType: o.assetType, amount: v, tokenId: o.tokenId, quantity: o.quantity }, meta, format);
}

export function offerLine(o: OfferLineFields, meta: TokenMetaMap | null, copy: Copy): string {
  const { text, format } = copy;
  const id = o.id.toString();
  const lend = o.offerType === OFFER_TYPE_LENDER;
  const amountOf = (v: bigint) => offerAmount(o, v, meta, format);
  if (o.assetType !== ASSET_ERC20) {
    return format(lend ? 'home.offerRentOut' : 'home.offerRent', {
      id,
      asset: amountOf(o.amount),
      fee: tokenAmount(o.amount, o.prepayAsset, meta, format),
      days: o.durationDays.toString(),
    });
  }
  const rate =
    o.interestRateBpsMax > o.interestRateBps ? format('home.rateRange', { min: formatBps(o.interestRateBps), max: formatBps(o.interestRateBpsMax) }) : formatBps(o.interestRateBps);
  const common = { id, rate, days: o.durationDays.toString() };
  if (o.amountMax > o.amount) {
    return format('home.offerRange', { ...common, side: text(lend ? 'home.offerSideLend' : 'home.offerSideBorrow'), min: amountOf(o.amount), max: amountOf(o.amountMax) });
  }
  return format(lend ? 'home.offerLend' : 'home.offerBorrow', { ...common, amount: amountOf(o.amountMax > 0n ? o.amountMax : o.amount) });
}
