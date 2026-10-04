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
 * What a card can say, and why each is distinct:
 *  - `value`      — both legs priced; `bound: 'atMost'` for a borrow
 *                   request, whose collateral is a FLOOR (more collateral
 *                   only lowers the ratio), `'exact'` for a lend offer,
 *                   whose collateral requirement scales with the amount
 *                   taken so the ratio holds for any fill.
 *  - `unpriced`   — a leg is illiquid (valued at 0 by the protocol, so no
 *                   ratio exists) or its value comes to nothing.
 *  - `unknown`    — a read failed (a stale feed, a provider error). Not
 *                   "can't be priced": nothing is known either way.
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
  | { kind: 'value'; bps: bigint; bound: 'exact' | 'atMost' }
  | { kind: 'unpriced' }
  | { kind: 'unknown' }
  | { kind: 'loading' }
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
  offer: Parameters<typeof ltvLegs>[0] & Pick<IndexedOffer, 'amount' | 'amountMax'>,
  pricing: ReadonlyMap<string, AssetPricing> | null | undefined,
): OfferLtv {
  const legs = ltvLegs(offer);
  if (!legs) return { kind: 'none' };
  if (pricing === undefined) return { kind: 'loading' };
  if (pricing === null) return { kind: 'unknown' };
  const lend = pricing.get(legs.lending);
  const coll = pricing.get(legs.collateral);
  if (!lend || !coll) return { kind: 'loading' };
  // An illiquid leg settles the question whatever the other read did:
  // the protocol values it at 0, so no ratio exists.
  if (lend.kind === 'illiquid' || coll.kind === 'illiquid') return { kind: 'unpriced' };
  if (lend.kind === 'failed' || coll.kind === 'failed') return { kind: 'unknown' };
  const isLender = offer.offerType === 0;
  const borrowed = BigInt((isLender ? offer.amountMax : offer.amount) || '0');
  const collateralValue = valueOf(BigInt(offer.collateralAmount), coll);
  if (collateralValue === 0n) return { kind: 'unpriced' };
  return {
    kind: 'value',
    bps: (valueOf(borrowed, lend) * 10_000n) / collateralValue,
    bound: isLender ? 'exact' : 'atMost',
  };
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
