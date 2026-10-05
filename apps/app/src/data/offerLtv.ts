/**
 * #2384 — the loan-to-value an Offer Book card states, and what it says
 * when it cannot state one.
 *
 * Valuation mirrors the protocol's own: each LIQUID leg is
 * `amount × price × 1e18 / 10^feedDecimals / 10^tokenDecimals`
 * (`OracleFacet.getAssetPrice`), the same formula `OfferAcceptFacet`
 * applies and `preflights.liquidNumeraireValueLive` mirrors. It is NOT
 * read from `OracleFacet.calculateLTV(pair)`: that view drops the token
 * decimals and is wrong for mixed-decimal pairs (#2403). The 1e18 scale
 * keeps small offers from flooring to a whole-dollar value of 0, which
 * would print a confident "0%".
 *
 * What a card can say, and why each is distinct (#2404 r1):
 *  - `value`      — the ratio AT THE AMOUNTS THE CARD SHOWS (a lend offer's
 *                   full amount and the collateral that full amount needs;
 *                   a borrow request's amount and committed collateral).
 *                   It claims no bound across fills: a ranged or part-taken
 *                   offer can be filled at another size, the matcher rounds
 *                   a part-fill's collateral down, and a borrow request's
 *                   collateral is only a floor — so `ranged` marks rows where
 *                   a fill of another size can carry a different ratio, and
 *                   the card says so instead of calling the figure exact or
 *                   a ceiling.
 *  - `illiquid`   — the protocol treats a leg as illiquid (no reliable price
 *                   OR too little trading — its liquidity check covers both)
 *                   and so gives it no value; no ratio exists. The card names
 *                   both possible causes, since it cannot tell which.
 *  - `tooSmall`   — both legs are priced but one side's value rounds to
 *                   nothing at this size; a "0%" would be a fiction.
 *  - `unknown`    — a read failed (a stale feed, a provider error). Nothing
 *                   is known either way.
 *  - `loading`    — the reads have not answered.
 *  - `none`       — the row has no ratio to state: a rental, an NFT leg,
 *                   no collateral, or a sale vehicle (its collateral is
 *                   the running loan's, not the row's).
 */
import { AssetType } from '../lib/types';
import type { IndexedOffer } from './indexer';

/** Pricing facts for one asset, from one batched read. */
export type AssetPricing =
  | { kind: 'priced'; price: bigint; feedDecimals: number; tokenDecimals: number }
  | { kind: 'illiquid' }
  | { kind: 'failed' };

export type OfferLtv =
  | { kind: 'value'; bps: bigint; ranged: boolean }
  | { kind: 'illiquid' }
  | { kind: 'tooSmall' }
  | { kind: 'unknown' }
  | { kind: 'loading' }
  /** #2382 r3 — a borrow request earlier matched fills have part-used. */
  | { kind: 'partFilled' }
  | { kind: 'none' };

const ZERO = '0x0000000000000000000000000000000000000000';

/** The two ERC-20 legs whose pricing a row needs, or null when the row
 *  states no ratio (see `none` above). */
export function ltvLegs(
  offer: Pick<
    IndexedOffer,
    'assetType' | 'collateralAssetType' | 'collateralAsset' | 'lendingAsset' | 'offerType'
  > & { isSaleVehicle?: boolean; collateralAmount: string },
): { lending: string; collateral: string } | null {
  if (offer.assetType !== AssetType.ERC20) return null;
  if (offer.collateralAssetType !== AssetType.ERC20) return null;
  if (offer.isSaleVehicle) return null;
  if (offer.collateralAsset.toLowerCase() === ZERO) return null;
  if (BigInt(offer.collateralAmount || '0') === 0n) return null;
  return {
    lending: offer.lendingAsset.toLowerCase(),
    collateral: offer.collateralAsset.toLowerCase(),
  };
}

function valueOf(amount: bigint, p: Extract<AssetPricing, { kind: 'priced' }>): bigint {
  return (
    (amount * p.price * 10n ** 18n) /
    10n ** BigInt(p.feedDecimals) /
    10n ** BigInt(p.tokenDecimals)
  );
}

/**
 * The card's LTV for one offer, given the page's pricing map (asset →
 * facts; `undefined` while loading, `null` when the whole batch failed).
 */
export function offerLtv(
  offer: Parameters<typeof ltvLegs>[0] &
    Pick<IndexedOffer, 'amount' | 'amountMax'> & {
      amountFilled?: string;
      collateralAmountMax?: string | null;
      collateralAmountFilled?: string | null;
    },
  pricing: ReadonlyMap<string, AssetPricing> | null | undefined,
): OfferLtv {
  const legs = ltvLegs(offer);
  if (!legs) return { kind: 'none' };
  // #2382 r3 — a part-used borrow request has no single pair of amounts a
  // further fill would carry: its principal and collateral both vary per
  // fill, and the card shows the remaining COMMITMENT, not a fill. A ratio
  // against the original floor would be labelled "at the amounts shown" while
  // matching neither. Stated, not computed. (A part-filled LEND offer stays a
  // ratio at its full size, qualified as ranged, as before.)
  if (
    offer.offerType === 1 &&
    (BigInt(offer.amountFilled || '0') > 0n || BigInt(offer.collateralAmountFilled || '0') > 0n)
  ) {
    return { kind: 'partFilled' };
  }
  if (pricing === undefined) return { kind: 'loading' };
  if (pricing === null) return { kind: 'unknown' };
  const lend = pricing.get(legs.lending);
  const coll = pricing.get(legs.collateral);
  if (!lend || !coll) return { kind: 'loading' };
  // An illiquid leg settles the question whatever the other read did:
  // the protocol values it at 0, so no ratio exists.
  if (lend.kind === 'illiquid' || coll.kind === 'illiquid') return { kind: 'illiquid' };
  if (lend.kind === 'failed' || coll.kind === 'failed') return { kind: 'unknown' };
  const isLender = offer.offerType === 0;
  const amount = BigInt(offer.amount || '0');
  const amountMax = BigInt(offer.amountMax || '0');
  // The amount the card's title shows: a lend offer's full size, a borrow
  // request's requested amount.
  const borrowed = isLender ? amountMax : amount;
  const borrowedValue = valueOf(borrowed, lend);
  const collateralValue = valueOf(BigInt(offer.collateralAmount), coll);
  // Either side rounding to nothing would print a fictional 0% (or divide
  // by zero) — say the size is too small to work out instead.
  if (borrowedValue === 0n || collateralValue === 0n) return { kind: 'tooSmall' };
  // A fill of another size can carry another ratio when the lend offer is
  // a range or already part-taken (the matcher scales and rounds down the
  // collateral), and for EVERY borrow request — whatever its collateral
  // range (#2382 r1). A direct funding locks exactly the floor, but any
  // request can also be filled by the matcher: a single-value request then
  // locks only the lender's pro-rated requirement and refunds the rest
  // (LibOfferMatch's single-value branch), so the loan can carry LESS
  // collateral than shown; a ranged one can lock up to its ceiling. Knowing
  // the ceiling narrows the range, never the uncertainty.
  const ranged =
    !isLender || amountMax > amount || BigInt(offer.amountFilled || '0') > 0n;
  return { kind: 'value', bps: (borrowedValue * 10_000n) / collateralValue, ranged };
}

/** One batched read per asset: liquidity verdict, oracle price, token
 *  decimals — in that order, three slots per asset. */
export function pricingPlan(
  diamond: `0x${string}`,
  assets: readonly string[],
  abis: { diamond: unknown; erc20: unknown },
): { asset: string; contracts: unknown[] }[] {
  return assets.map((asset) => ({
    asset,
    contracts: [
      { address: diamond, abi: abis.diamond, functionName: 'checkLiquidity', args: [asset] },
      { address: diamond, abi: abis.diamond, functionName: 'getAssetPrice', args: [asset] },
      { address: asset, abi: abis.erc20, functionName: 'decimals' },
    ],
  }));
}

type Slot = { status: 'success'; result: unknown } | { status: 'failure'; error?: unknown };

/** Map the multicall slots back to per-asset facts. A failed liquidity
 *  read is `failed`, never `illiquid`: an unanswered question is not a
 *  "no". Liquidity status 0 is the protocol's LIQUID. */
export function pricingFacts(
  plan: readonly { asset: string }[],
  slots: readonly Slot[],
  liquidStatus: number,
): Map<string, AssetPricing> {
  const out = new Map<string, AssetPricing>();
  plan.forEach(({ asset }, i) => {
    const [liq, price, dec] = slots.slice(i * 3, i * 3 + 3);
    if (!liq || liq.status !== 'success') {
      out.set(asset, { kind: 'failed' });
      return;
    }
    if (Number(liq.result) !== liquidStatus) {
      out.set(asset, { kind: 'illiquid' });
      return;
    }
    if (!price || price.status !== 'success' || !dec || dec.status !== 'success') {
      out.set(asset, { kind: 'failed' });
      return;
    }
    const [p, feedDecimals] = price.result as readonly [bigint, number];
    out.set(asset, {
      kind: 'priced',
      price: p,
      feedDecimals: Number(feedDecimals),
      tokenDecimals: Number(dec.result),
    });
  });
  return out;
}
