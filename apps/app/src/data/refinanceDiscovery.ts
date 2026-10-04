/**
 * #2391 — find a loan's refinance request ON CHAIN, wherever it was made.
 *
 * Until now the loan page learned of a request only from a device-local
 * marker, so one posted on another device or through another tool was
 * invisible, and partial repayment, preclose and taking back collateral
 * could strand it. The chain already has what is needed:
 *
 *  - a refinance request is fillable only when its creator is the loan's
 *    CURRENT borrower-position holder (`RefinanceFacet` checks
 *    `offer.creator == ownerOf(borrowerTokenId)`), so the holder's own
 *    offers are the complete search space;
 *  - `MetricsFacet.getUserOffersByStatePaginated` filters a wallet's
 *    offers by lifecycle state on chain and reports how many matched, so
 *    completeness is KNOWN rather than assumed;
 *  - each offer's `getOfferDetails` record carries `refinanceTargetLoanId`.
 *
 * No indexer column and no migration (which would carry the #1149
 * deploy-ordering hazard). Open requests come first (they drive the
 * interlocks); an expired one is still returned so the borrower can cancel
 * it and unwind its approval. More matches than one page holds, or any
 * failed read, is `unknown` — the interlocks then fail closed.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';

/** `LibMetricsTypes.OfferState` — Open and Expired are the two a live
 *  request can be in. */
export const OFFER_STATE_OPEN = 0;
export const OFFER_STATE_EXPIRED = 4;

/** Offers per state the scan reads. A holder with more open (or expired)
 *  offers than this gets `unknown`, never a partial "none". */
export const DISCOVERY_PAGE = 100;

export type RefinanceDiscovery =
  | { kind: 'found'; offerId: string; open: boolean }
  | { kind: 'none' }
  | { kind: 'unknown' };

export interface OfferFacts {
  id: bigint;
  creator: string;
  accepted: boolean;
  refinanceTargetLoanId: bigint;
}

/** The newest request among `offers` that targets `loanId` and was made by
 *  `holder` — the only creator the contract will settle. */
export function pickRequest(
  loanId: bigint,
  holder: string,
  offers: readonly OfferFacts[],
): bigint | null {
  const h = holder.toLowerCase();
  let best: bigint | null = null;
  for (const o of offers) {
    if (o.accepted) continue;
    if (o.creator.toLowerCase() !== h) continue;
    if (o.refinanceTargetLoanId !== loanId) continue;
    if (best === null || o.id > best) best = o.id;
  }
  return best;
}

/** Combine the two state scans. Either scan being incomplete or failed
 *  makes the answer unknown — an open request could be hiding in it. */
export function combineScans(
  loanId: bigint,
  holder: string,
  open: { offers: readonly OfferFacts[]; complete: boolean } | null,
  expired: { offers: readonly OfferFacts[]; complete: boolean } | null,
): RefinanceDiscovery {
  if (!open || !open.complete) return { kind: 'unknown' };
  const live = pickRequest(loanId, holder, open.offers);
  if (live !== null) return { kind: 'found', offerId: live.toString(), open: true };
  if (!expired || !expired.complete) return { kind: 'unknown' };
  const stale = pickRequest(loanId, holder, expired.offers);
  if (stale !== null) return { kind: 'found', offerId: stale.toString(), open: false };
  return { kind: 'none' };
}

async function scanState(
  client: PublicClient,
  diamond: `0x${string}`,
  holder: `0x${string}`,
  state: number,
): Promise<{ offers: OfferFacts[]; complete: boolean } | null> {
  try {
    const [ids, matched] = (await client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getUserOffersByStatePaginated',
      args: [holder, state, 0n, BigInt(DISCOVERY_PAGE)],
    })) as readonly [readonly bigint[], bigint];
    if (ids.length === 0) return { offers: [], complete: matched === 0n };
    const details = await client.multicall({
      allowFailure: false,
      contracts: ids.map((id) => ({
        address: diamond,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOfferDetails',
        args: [id],
      })) as never,
    });
    const offers = (details as unknown as {
      creator: string;
      accepted: boolean;
      refinanceTargetLoanId: bigint;
    }[]).map((d, i) => ({
      id: ids[i]!,
      creator: d.creator,
      accepted: d.accepted,
      refinanceTargetLoanId: d.refinanceTargetLoanId,
    }));
    return { offers, complete: matched <= BigInt(ids.length) };
  } catch {
    return null;
  }
}

/** Live discovery — used by the polling hook and re-run just before a
 *  wallet opens on a surface the request would be stranded by. */
export async function discoverRefinanceRequest(opts: {
  client: PublicClient;
  diamond: `0x${string}`;
  loanId: bigint;
  holder: `0x${string}`;
}): Promise<RefinanceDiscovery> {
  const [open, expired] = await Promise.all([
    scanState(opts.client, opts.diamond, opts.holder, OFFER_STATE_OPEN),
    scanState(opts.client, opts.diamond, opts.holder, OFFER_STATE_EXPIRED),
  ]);
  return combineScans(opts.loanId, opts.holder, open, expired);
}
