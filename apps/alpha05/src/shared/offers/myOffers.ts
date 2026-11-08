/**
 * OFF-46 — the wallet's own offers, in every state the protocol reports:
 * every offer it ever created (the protocol's per-creator index, which keeps
 * a cancelled id) together with every offer whose position token it holds
 * now, read in one bulk call with the protocol's own state for each.
 *
 * A cancelled offer that never filled has its record cleared at the cancel,
 * so the protocol still calls it cancelled but no longer holds its terms;
 * the list says so instead of inventing them. An offer cancelled after a
 * partial fill keeps its record (and reads as filled). Rebuilding a cleared
 * offer's terms from its cancel event is not done here.
 */
import { type Abi, type PublicClient } from 'viem';
import { MetricsDashboardFacetABI, MetricsFacetABI } from '@vaipakam/contracts/abis';
import { inBatches, walkInventory } from '../positions/reads';
import { readPagedList } from '../vault/holdings';
import { OFFER_STATES, type OfferState } from './reads';

type Hex = `0x${string}`;

const DASHBOARD = MetricsDashboardFacetABI as Abi;
const METRICS = MetricsFacetABI as Abi;

/** One offer's terms as the dashboard view returns them. */
export interface OfferTerms {
  id: bigint;
  offerType: number;
  accepted: boolean;
  createdAt: bigint;
  expiresAt: bigint;
  lendingAsset: Hex;
  assetType: number;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  durationDays: bigint;
  tokenId: bigint;
  amountFilled: bigint;
  collateralAsset: Hex;
  collateralAssetType: number;
  collateralAmount: bigint;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
  creator: Hex;
  quantity: bigint;
  positionTokenId: bigint;
  prepayAsset: Hex;
  fillMode: number;
  state: number;
}

export interface MyOffer {
  id: bigint;
  state: OfferState | 'unknown';
  /** Null when the protocol no longer holds the terms (cleared at cancel). */
  terms: OfferTerms | null;
  /** The wallet created it. */
  created: boolean;
  /** The wallet holds its position token now. */
  held: boolean;
}

export interface MyOffers {
  rows: MyOffer[];
  /** Both indexes were read to their end. */
  complete: boolean;
}

export function offerState(code: number): OfferState | 'unknown' {
  return OFFER_STATES[code] ?? 'unknown';
}

/** The wallet's offers, newest first. */
export async function readMyOffers(client: PublicClient, diamond: Hex, account: Hex): Promise<MyOffers> {
  const [created, held] = await Promise.all([
    readPagedList<bigint>(
      (offset, limit) =>
        client.readContract({ address: diamond, abi: METRICS, functionName: 'getUserOffersPaginated', args: [account, offset, limit] }) as Promise<
          readonly [readonly bigint[], bigint]
        >,
    ),
    walkInventory(client, diamond, account, 'getUserPositionOffersPaginated'),
  ]);
  const createdSet = new Set(created.assets.map((id) => id.toString()));
  const heldSet = new Set(held.rows.map((r) => r.id.toString()));
  const ids = [...new Set([...createdSet, ...heldSet])].map((id) => BigInt(id)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  // The view answers position for position, so each row is matched to the
  // id it was asked for, not to the id it reports (a cleared record reports 0).
  const views = await inBatches(ids, async (chunk) => {
    const out = (await client.readContract({ address: diamond, abi: DASHBOARD, functionName: 'getOffersWithState', args: [chunk] })) as readonly OfferTerms[];
    if (out.length !== chunk.length) throw new Error('offer view answered a different number of offers');
    return out;
  });
  const rows = ids.map((id, i): MyOffer => {
    const v = views[i]!;
    return {
      id,
      state: offerState(Number(v.state)),
      terms: v.id === id ? v : null,
      created: createdSet.has(id.toString()),
      held: heldSet.has(id.toString()),
    };
  });
  return { rows, complete: created.complete && held.complete };
}

/** The filter chips the list offers, in order. */
export const OFFER_FILTERS = ['open', 'accepted', 'expired', 'cancelled', 'all'] as const;
export type OfferFilter = (typeof OFFER_FILTERS)[number];

/** Whether a row shows under a chip. A lender-sale offer consumed by its
 *  sale counts as filled. */
export function inFilter(o: MyOffer, f: OfferFilter): boolean {
  if (f === 'all') return true;
  if (f === 'accepted') return o.state === 'accepted' || o.state === 'sale-consumed';
  return o.state === f;
}

export function filterCounts(rows: readonly MyOffer[]): Record<OfferFilter, number> {
  return Object.fromEntries(OFFER_FILTERS.map((f) => [f, rows.filter((r) => inFilter(r, f)).length])) as Record<OfferFilter, number>;
}
