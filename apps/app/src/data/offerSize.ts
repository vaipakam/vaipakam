/**
 * #3242 — an Offer Book row's SIZE in the numeraire (US dollars at the
 * protocol's oracle), for the book's minimum-size filter and its default
 * "largest first" ranking. Tiny offers are what crowd a book; ranking by
 * size puts the market's real depth first without hiding anything.
 *
 * What is sized, and why:
 *  - a lend offer: what is still on offer (`amountMax − amountFilled`), the
 *    most a borrower can take from it now;
 *  - a borrow request: the amount it asks for (`amount`).
 * Valued with the same formula as the card's loan-to-value
 * (`amount × price × 1e18 / 10^feedDecimals / 10^tokenDecimals`), from the
 * same batched pricing facts (`useAssetPricing`).
 *
 * What a row's size can be, and what each means for the filter:
 *  - `value`    — a priced, liquid lending asset: compared with the minimum.
 *  - `unpriced` — the protocol gives the asset no value (illiquid, no
 *                 reliable price) or the price read failed. The size is
 *                 UNKNOWN, so the row is never hidden by the filter — it is
 *                 kept, ranked after every sized row, and the page says why.
 *  - `loading`  — the pricing has not answered; kept, ranked as unknown.
 *  - `none`     — the row has no ERC-20 amount to size: an NFT rental, an
 *                 NFT loan, or a sale vehicle (it sells a running loan, not
 *                 an amount). Kept, ranked after every sized row.
 * The filter only ever hides a row whose size it measured and found below
 * the minimum: it states what it knows and never treats an unknown as small.
 */
import { AssetType } from '../lib/types';
import type { AssetPricing } from './offerLtv';
import type { IndexedOffer } from './indexer';

export type OfferSize =
  | { kind: 'value'; value: bigint }
  | { kind: 'unpriced' }
  | { kind: 'loading' }
  | { kind: 'none' };

/** The minimum-size choices, in whole numeraire units (0 = any size). */
export const MIN_SIZE_CHOICES = [0, 10, 100, 1_000, 10_000] as const;
export type MinSizeChoice = (typeof MIN_SIZE_CHOICES)[number];

type SizedOffer = Pick<
  IndexedOffer,
  'offerType' | 'assetType' | 'lendingAsset' | 'amount' | 'amountMax'
> & { amountFilled?: string; isSaleVehicle?: boolean };

/** The ERC-20 amount a row is sized by, in base units, or null when the
 *  row has none (see `none` above). */
export function offerSizeAmount(offer: SizedOffer): bigint | null {
  if (offer.assetType !== AssetType.ERC20) return null;
  if (offer.isSaleVehicle) return null;
  if (offer.offerType === 0) {
    const max = BigInt(offer.amountMax || '0');
    const filled = BigInt(offer.amountFilled || '0');
    return max > filled ? max - filled : 0n;
  }
  return BigInt(offer.amount || '0');
}

/** The lending asset whose price a row's size needs, or null. */
export function offerSizeAsset(offer: SizedOffer): string | null {
  return offerSizeAmount(offer) === null ? null : offer.lendingAsset.toLowerCase();
}

/** A row's size, given the pricing map (`undefined` while loading, `null`
 *  when the whole batch failed). */
export function offerSize(
  offer: SizedOffer,
  pricing: ReadonlyMap<string, AssetPricing> | null | undefined,
): OfferSize {
  const amount = offerSizeAmount(offer);
  if (amount === null) return { kind: 'none' };
  if (pricing === undefined) return { kind: 'loading' };
  if (pricing === null) return { kind: 'unpriced' };
  const p = pricing.get(offer.lendingAsset.toLowerCase());
  if (!p) return { kind: 'loading' };
  if (p.kind !== 'priced') return { kind: 'unpriced' };
  return {
    kind: 'value',
    value:
      (amount * p.price * 10n ** 18n) /
      10n ** BigInt(p.feedDecimals) /
      10n ** BigInt(p.tokenDecimals),
  };
}

/** Whether the minimum-size filter keeps a row. Only a MEASURED size below
 *  the minimum is hidden; an unknown size is never read as small. */
export function keepsAtMinSize(size: OfferSize, minUnits: MinSizeChoice): boolean {
  if (minUnits === 0) return true;
  if (size.kind !== 'value') return true;
  return size.value >= BigInt(minUnits) * 10n ** 18n;
}

/** "Largest first": sized rows by value, descending; every row without a
 *  measured size after them. Returns 0 for a tie so a stable sort keeps the
 *  book's own (newest-first) order inside each group. */
export function compareBySizeDesc(a: OfferSize, b: OfferSize): number {
  const av = a.kind === 'value' ? a.value : null;
  const bv = b.kind === 'value' ? b.value : null;
  if (av !== null && bv !== null) return av === bv ? 0 : av > bv ? -1 : 1;
  if (av !== null) return -1;
  if (bv !== null) return 1;
  return 0;
}
