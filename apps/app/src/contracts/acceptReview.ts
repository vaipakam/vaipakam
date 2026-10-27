/**
 * #2725 / #2728 — the ONE model of "the terms an accept signature binds".
 *
 * Every accept route (a direct accept, a rental, a signed-offer fill) signs
 * an `AcceptTerms` struct. Each of its fields is one of three things:
 *
 *   - `reviewed` — a term of the deal itself, copied from the offer (or the
 *     signed order, or a sale vehicle's linked loan). The review shows it, or
 *     states it as the default, and the signer refuses to sign when the
 *     canonical value differs from the reviewed one;
 *   - `acceptor` — the acceptor's own act on the review screen (consent, the
 *     Full tariff opt-in) or their identity;
 *   - `derived` — bookkeeping the signer computes and the user has no choice
 *     over (the offer key, nonce, deadline, the live risk-terms anchor, and
 *     the illiquid acknowledgements, which follow from `illiquidLegs`).
 *
 * The classification is a `Record` over every signed field, so adding a field
 * to the signed struct fails the typecheck until someone decides which kind it
 * is, and a new `reviewed` field is compared by {@link reviewedMismatches}
 * without anyone remembering to add it (the comparison iterates the table).
 * Before this module each signer compared a hand-picked subset, and the
 * lifecycle terms (interest mode aside) were signed without being shown or
 * compared.
 */
import type { Address, Hex } from 'viem';
import type { AcceptTerms } from './useAcceptTerms';
import type { SignedOrderWire } from '../lib/signedOffer';
import { copy } from '../content/copy';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

/** What kind of value each signed `AcceptTerms` field is (see the module doc). */
export type AcceptTermsFieldSource = 'reviewed' | 'acceptor' | 'derived';

export const ACCEPT_TERMS_FIELD_SOURCE = {
  acceptor: 'acceptor',
  offerCreator: 'reviewed',
  offerKey: 'derived',
  offerType: 'reviewed',
  lendingAsset: 'reviewed',
  collateralAsset: 'reviewed',
  amount: 'reviewed',
  collateralAmount: 'reviewed',
  interestRateBps: 'reviewed',
  durationDays: 'reviewed',
  tokenId: 'reviewed',
  collateralTokenId: 'reviewed',
  quantity: 'reviewed',
  collateralQuantity: 'reviewed',
  assetType: 'reviewed',
  collateralAssetType: 'reviewed',
  prepayAsset: 'reviewed',
  useFullTermInterest: 'reviewed',
  allowsPartialRepay: 'reviewed',
  allowsPrepayListing: 'reviewed',
  allowsParallelSale: 'reviewed',
  refinanceTargetLoanId: 'reviewed',
  linkedLoanId: 'reviewed',
  parallelSaleOrderHash: 'reviewed',
  periodicInterestCadence: 'reviewed',
  riskAndTermsConsent: 'acceptor',
  // Follow from `illiquidLegs` (#2728): never set for a leg the review did
  // not show as illiquid.
  acknowledgedIlliquidLendingAsset: 'derived',
  acknowledgedIlliquidCollateralAsset: 'derived',
  nonce: 'derived',
  deadline: 'derived',
  riskTermsHash: 'derived',
  acceptorFull: 'acceptor',
  acceptorMaxCStar: 'acceptor',
  acceptorAllowFullDowngrade: 'acceptor',
  // `as const` keeps each entry's literal kind (so `ReviewedKey` can select
  // on it); `satisfies` still makes the table exhaustive over the signed
  // struct and refuses a key it does not have.
} as const satisfies Record<keyof AcceptTerms, AcceptTermsFieldSource>;

type ReviewedKey = {
  [K in keyof AcceptTerms]: (typeof ACCEPT_TERMS_FIELD_SOURCE)[K] extends 'reviewed' ? K : never;
}[keyof AcceptTerms];

/** The lifecycle terms a loan carries for its whole life: how interest
 *  accrues and when it is due, and what may happen to the collateral before
 *  the loan ends. Shown on every accept review ({@link lifecycleRows}). */
export interface LifecycleTerms {
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  allowsParallelSale: boolean;
  periodicInterestCadence: number;
  refinanceTargetLoanId: bigint;
  linkedLoanId: bigint;
  parallelSaleOrderHash: Hex;
}

/** Which legs the review CLASSIFIED illiquid and showed as such. The signer
 *  acknowledges exactly these legs and no other (#2728), and refuses to sign
 *  when a leg it reads illiquid now was not shown as illiquid. */
export interface ReviewedIlliquidLegs {
  lending: boolean;
  collateral: boolean;
}

/** Every `reviewed` field, as the review showed it, plus the legs it showed
 *  as illiquid. Required in full by every signer, so a review cannot leave a
 *  bound term out of the comparison by omission. */
export type ReviewedAcceptTerms = Pick<AcceptTerms, ReviewedKey> & {
  illiquidLegs: ReviewedIlliquidLegs;
};

const REVIEWED_FIELDS = (
  Object.keys(ACCEPT_TERMS_FIELD_SOURCE) as (keyof AcceptTerms)[]
).filter((k): k is ReviewedKey => ACCEPT_TERMS_FIELD_SOURCE[k] === 'reviewed');

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** The reviewed fields whose signed value differs from the reviewed one.
 *  Empty means the signature binds exactly what the review showed. */
export function reviewedMismatches(
  reviewed: ReviewedAcceptTerms,
  signed: AcceptTerms,
): ReviewedKey[] {
  return REVIEWED_FIELDS.filter((k) => !sameValue(reviewed[k], signed[k]));
}

/** The illiquid acknowledgements to sign: a leg's asset when the review
 *  showed that leg as illiquid, the zero address otherwise (#2728). A leg
 *  that turns illiquid after signing then fails the contract's own check
 *  (`IlliquidAssetNotAcknowledged`) instead of passing on a blanket consent. */
export function illiquidAcknowledgements(
  legs: ReviewedIlliquidLegs,
  lendingAsset: Address,
  collateralAsset: Address,
): Pick<AcceptTerms, 'acknowledgedIlliquidLendingAsset' | 'acknowledgedIlliquidCollateralAsset'> {
  return {
    acknowledgedIlliquidLendingAsset: legs.lending ? lendingAsset : ZERO_ADDRESS,
    acknowledgedIlliquidCollateralAsset: legs.collateral ? collateralAsset : ZERO_ADDRESS,
  };
}

/** True when a leg reads illiquid now but the review did not show it as
 *  illiquid: the signature would acknowledge nothing for it, so the review
 *  has to be shown again with the warning before anything is signed. */
export function illiquidLegUnreviewed(
  legs: ReviewedIlliquidLegs,
  live: ReviewedIlliquidLegs,
): boolean {
  return (live.lending && !legs.lending) || (live.collateral && !legs.collateral);
}

/** The lifecycle terms of a canonical `getOffer` struct plus its linked loan
 *  id (`getOfferLinkedLoanId`, which `getOffer` does not carry). */
export function lifecycleFromOffer(
  o: Record<string, unknown>,
  linkedLoanId: bigint,
): LifecycleTerms {
  return {
    useFullTermInterest: Boolean(o.useFullTermInterest),
    allowsPartialRepay: Boolean(o.allowsPartialRepay),
    allowsPrepayListing: Boolean(o.allowsPrepayListing),
    allowsParallelSale: Boolean(o.allowsParallelSale),
    periodicInterestCadence: Number(o.periodicInterestCadence),
    refinanceTargetLoanId: BigInt((o.refinanceTargetLoanId as bigint | undefined) ?? 0n),
    linkedLoanId,
    parallelSaleOrderHash: ((o.parallelSaleOrderHash as Hex | undefined) ?? ZERO_HASH),
  };
}

/** The lifecycle terms a signed order materializes with. A freshly
 *  materialized offer carries no sale or offset link and no live Seaport
 *  order, so those two are their zero defaults. */
export function lifecycleFromOrder(o: SignedOrderWire): LifecycleTerms {
  return {
    useFullTermInterest: o.useFullTermInterest,
    allowsPartialRepay: o.allowsPartialRepay,
    allowsPrepayListing: o.allowsPrepayListing,
    allowsParallelSale: o.allowsParallelSale,
    periodicInterestCadence: Number(o.periodicInterestCadence),
    refinanceTargetLoanId: BigInt(o.refinanceTargetLoanId),
    linkedLoanId: 0n,
    parallelSaleOrderHash: ZERO_HASH,
  };
}

/** Every reviewed term of a signed order, as the fill confirm shows it and
 *  the signed-fill signer binds it. Role-correct endpoints as
 *  `OfferAcceptFacet._bindTermsToOffer` resolves them against the
 *  materialized offer: an ERC-20 lender order binds `amountMax` /
 *  `interestRateBps`, an ERC-20 borrower order `amount` /
 *  `interestRateBpsMax`, an NFT order `amount` / `interestRateBps`. The
 *  confirm card has no surface for the in-kind default disclosure, so no leg
 *  is shown as illiquid and the signer refuses an illiquid pair outright. */
export function reviewedTermsFromOrder(o: SignedOrderWire): ReviewedAcceptTerms {
  const isERC20 = Number(o.assetType) === 0;
  const isLender = Number(o.offerType) === 0;
  return {
    offerCreator: o.signer as Address,
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset as Address,
    collateralAsset: o.collateralAsset as Address,
    amount: isERC20 && isLender ? BigInt(o.amountMax) : BigInt(o.amount),
    collateralAmount: BigInt(o.collateralAmount),
    interestRateBps:
      isERC20 && !isLender ? BigInt(o.interestRateBpsMax) : BigInt(o.interestRateBps),
    durationDays: BigInt(o.durationDays),
    tokenId: BigInt(o.tokenId),
    collateralTokenId: BigInt(o.collateralTokenId),
    quantity: BigInt(o.quantity),
    collateralQuantity: BigInt(o.collateralQuantity),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    prepayAsset: o.prepayAsset as Address,
    ...lifecycleFromOrder(o),
    illiquidLegs: { lending: false, collateral: false },
  };
}

/** `LibVaipakam.PeriodicInterestCadence` as review text. An ordinal this app
 *  does not know reads as unknown, never as a known schedule. */
function cadenceText(cadence: number): string {
  const t = copy.acceptTerms;
  switch (cadence) {
    case 0:
      return t.cadenceNone;
    case 1:
      return t.cadenceMonthly;
    case 2:
      return t.cadenceQuarterly;
    case 3:
      return t.cadenceSemiAnnual;
    case 4:
      return t.cadenceAnnual;
    default:
      return t.cadenceUnknown;
  }
}

/** One row of the lifecycle-terms list a review shows. */
export interface LifecycleRow {
  label: string;
  value: string;
}

/** The lifecycle terms as review rows: every one of them, default or not, so
 *  the reader sees what the signature binds rather than inferring it from a
 *  row's absence. */
export function lifecycleRows(l: LifecycleTerms): LifecycleRow[] {
  const t = copy.acceptTerms;
  const rows: LifecycleRow[] = [
    {
      label: t.interestLabel,
      value: l.useFullTermInterest ? t.interestFullTerm : t.interestProRata,
    },
    { label: t.scheduleLabel, value: cadenceText(l.periodicInterestCadence) },
    {
      label: t.partialRepayLabel,
      value: l.allowsPartialRepay ? t.partialRepayAllowed : t.partialRepayNotAllowed,
    },
    {
      label: t.prepayListingLabel,
      value: l.allowsPrepayListing ? t.prepayListingAllowed : t.prepayListingNotAllowed,
    },
    {
      label: t.parallelSaleLabel,
      value: l.allowsParallelSale ? t.parallelSaleAllowed : t.parallelSaleNotAllowed,
    },
  ];
  if (l.parallelSaleOrderHash !== ZERO_HASH) {
    rows.push({ label: t.liveListingLabel, value: t.liveListing });
  }
  if (l.refinanceTargetLoanId !== 0n) {
    rows.push({ label: t.refinanceLabel, value: t.refinanceOf(l.refinanceTargetLoanId.toString()) });
  }
  if (l.linkedLoanId !== 0n) {
    rows.push({ label: t.linkedLabel, value: t.linkedTo(l.linkedLoanId.toString()) });
  }
  return rows;
}
