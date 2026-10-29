/**
 * #1849 — the lender's instant-sale candidates, derived ONCE.
 *
 * A lender can sell the position straight into a standing lending
 * ("buy") offer through `sellLoanViaBuyOffer`. Two surfaces need to
 * know which offers qualify: the sale tool (`EarlyExitFlow`), which
 * lists them, and the Layer-1 exit chooser (`LenderExitOptionsCard`),
 * which says whether the "sell now" row has anything behind it. Before
 * this module the tool derived the list and the chooser was told
 * `'unknown'` in both modes, so with zero matches the chooser still
 * offered a jump to a tool that already knew it was empty.
 *
 * The derivation lives here and nowhere else. The page computes it
 * once and hands the SAME list to both surfaces, so they cannot
 * disagree, and a second copy of the facet's admission rules (the
 * defect class the chooser was built to remove) never exists.
 *
 * Three answers, kept apart on purpose:
 *   - `undefined` — the offer read has not answered yet (loading);
 *   - `null`      — no list can be stated: the offer read failed, or the
 *                   seller's window could not be read, so no candidate
 *                   can be priced;
 *   - an array    — the compatible offers, best payout first. `[]` means
 *                   the market really has none, never "we could not tell".
 */
import { AssetType } from '../lib/types';
import {
  loanEndTimeOf,
  sellerEconomics,
  type LoanLive,
} from '../contracts/loanLive';
import type { IndexedLoan, IndexedOffer } from './indexer';
import type { InstantSellCandidates } from './lenderExitRows';

export interface InstantSellInput {
  /** `useActiveOffers().data`: undefined = loading, null = unavailable. */
  offers: IndexedOffer[] | null | undefined;
  /** The offer read's latest fetch failed (its query threw). Without this
   *  a thrown first walk leaves `offers` undefined forever, and both
   *  surfaces would wait on an answer that is not coming; and a failed
   *  refetch leaves the last success in `offers`, which must not be
   *  published as the current market. Either way: `null`. */
  offersFailed: boolean;
  /** The connected wallet, or undefined when none is connected. */
  address: string | undefined;
  row: Pick<IndexedLoan, 'lendingAsset' | 'collateralAsset'>;
  live: LoanLive;
  /** Chain time of the live read — offer expiry and the remaining term
   *  are chain-time questions. Pricing reads the snapshot's own clock
   *  (`sellerEconomics`), not this one. */
  chainNow: bigint;
}

/**
 * The facet's admission rules, applied client-side so a doomed candidate
 * never reaches a wallet prompt. Every excluded shape reverts on-chain
 * (`InvalidSaleOffer` and its siblings); the submit path still
 * re-verifies the chosen offer live, because the indexer trails the chain.
 */
export function instantSellCandidatesOf(
  input: InstantSellInput,
): IndexedOffer[] | null | undefined {
  const { offers, offersFailed, address, row, live, chainNow } = input;
  // No interest ledger, no quote. Every rule below needs one, and a priced-looking
  // list that cannot be priced is worse than saying so (Codex #1801 r11
  // P2): `null`, because `[]` would claim the market is empty.
  if (live.sellerClaimOnSale === undefined) return null;
  // A failed walk states no market, even with an earlier answer cached:
  // TanStack keeps the last success beside `isError`, and an empty book
  // from before the failure is not a reason to say no offer matches now
  // (Codex #3046 r1).
  if (offersFailed) return null;
  if (offers === undefined) return undefined;
  if (offers === null) return null;
  if (!address) return [];
  const me = address.toLowerCase();
  // #1923 — the loan's live remaining exposure to its EFFECTIVE maturity
  // (the pause credit included, #668 / #935), in seconds. A direct sale is
  // refused at/after maturity, and an offer's authored duration must COVER
  // it (a ceiling on the buyer's lock, not the loan's term).
  const remainingExposureSecs = loanEndTimeOf(live, chainNow) - chainNow;
  return offers
    .filter((o) => {
      if (o.offerType !== 0 || o.assetType !== AssetType.ERC20) return false;
      // Single-value, unfilled (amountMax 0 collapses to amount).
      const amount = BigInt(o.amount);
      const effMax = BigInt(o.amountMax) === 0n ? amount : BigInt(o.amountMax);
      if (effMax !== amount || BigInt(o.amountFilled) !== 0n) return false;
      // Asset-quadruple continuity with the loan.
      if (
        o.lendingAsset.toLowerCase() !== row.lendingAsset.toLowerCase() ||
        o.collateralAsset.toLowerCase() !== row.collateralAsset.toLowerCase() ||
        o.collateralAssetType !== live.collateralAssetType ||
        o.prepayAsset.toLowerCase() !== live.prepayAsset.toLowerCase()
      ) {
        return false;
      }
      // #1923 — coverage + exact size. Nothing is sellable past maturity,
      // a shorter authored duration over-exposes the buyer and is refused,
      // and the amount must equal the principal EXACTLY (the offer is
      // consumed whole; an over-funded one is refused, not refunded).
      if (remainingExposureSecs <= 0n) return false;
      if (BigInt(o.durationDays) * 86_400n < remainingExposureSecs) return false;
      if (BigInt(o.collateralAmount) > live.collateralAmount) return false;
      if (amount !== live.principal) return false;
      // Expired offers are refused at accept.
      if (o.expiresAt && BigInt(o.expiresAt) <= chainNow) return false;
      // Buying out your own position is a no-op with fees.
      if (o.creator.toLowerCase() === me) return false;
      // RateShortfallTooHigh guard.
      const econ = sellerEconomics(live, BigInt(o.interestRateBps));
      return econ.cost <= live.principal;
    })
    .sort(
      // Best payout first = lowest buy-offer rate first: the accrued part
      // is identical across candidates, only the shortfall varies, and it
      // rises with the rate.
      (a, b) => a.interestRateBps - b.interestRateBps,
    );
}

/**
 * The chooser's reading of the list. `'unknown'` when the list cannot be
 * stated (it makes no claim and leaves the row to the tool, which says
 * why); `'checking'` only while a read that CAN answer is in flight.
 */
export function instantSellVerdict(
  candidates: IndexedOffer[] | null | undefined,
): InstantSellCandidates {
  if (candidates === undefined) return 'checking';
  if (candidates === null) return 'unknown';
  return candidates.length === 0 ? 'none' : 'some';
}
