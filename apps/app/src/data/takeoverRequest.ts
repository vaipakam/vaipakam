/**
 * #3845 — a request to take over a named loan's debt
 * (`OfferCreateFacet.createTakeoverOffer`, #3844).
 *
 * Someone who is not a party to a loan posts a borrow request for THAT
 * loan. It stays off the offer book: no lender can fill it, and only the
 * loan's current borrower can use it, through the handover
 * (`PrecloseFacet.transferObligationViaOffer`). When the borrower uses it,
 * the requester becomes the loan's borrower: the requester's collateral
 * (locked in the requester's own vault when the request is posted)
 * replaces the old collateral, and the requester receives NO principal,
 * because the debt already exists.
 *
 * This module holds the rules the request must meet to be usable, the
 * same ones the handover checks, so the form never offers terms the
 * borrower could not take:
 *   - the loan's lending, collateral and prepay assets, and its
 *     collateral type, repeated exactly;
 *   - the loan's principal exactly (one value, all or nothing);
 *   - at least the loan's collateral;
 *   - a term that ends no later than the loan's due date. That bound
 *     moves with time, so a request is usable only until its term no
 *     longer fits: the request's own expiry is set to that moment.
 *
 * Scope: ERC-20 lending with ERC-20 collateral. An NFT-collateral loan
 * needs the same token kind and a chosen token, and a rental is priced
 * per day; neither is offered here yet, and the form says so.
 */
import { AssetType } from '../lib/types';
import { MAX_INTEREST_BPS, ZERO_ADDRESS, type CreateOfferPayload } from '../lib/offerSchema';

/** The live-loan fields a request is built from. Structural, so this
 *  module does not import the contracts layer. */
export interface TakeoverSourceLoan {
  /** LibVaipakam.LoanStatus as a number (Active = 0). */
  status: number;
  principal: bigint;
  principalAsset: `0x${string}`;
  /** LibVaipakam.AssetType of the lent asset (ERC20 = 0). */
  assetType: number;
  collateralAsset: `0x${string}`;
  collateralAssetType: number;
  collateralAmount: bigint;
  prepayAsset: `0x${string}`;
  allowsPartialRepay: boolean;
  useFullTermInterest: boolean;
}

/** Why a loan cannot take a request from this form, or null when it can. */
export type TakeoverScopeRefusal = 'not-active' | 'rental' | 'nft-collateral' | 'no-term-left';

const DAY = 86_400n;

/** The longest whole-day term a request can carry now: the days left
 *  before the loan's due date (`maturity`, the loan clock's effective
 *  one), rounded down, so the request's term never ends after it. */
export function maxTakeoverDays(maturity: bigint, chainNow: bigint): number {
  if (maturity <= chainNow) return 0;
  return Number((maturity - chainNow) / DAY);
}

/** The last moment a request with this term can be used: after it,
 *  `now + term` passes the due date and the handover refuses it. */
export function takeoverRequestExpiry(maturity: bigint, durationDays: number): bigint {
  return maturity - BigInt(durationDays) * DAY;
}

/** Whether this form can post a request for the loan. */
export function takeoverScope(
  loan: TakeoverSourceLoan,
  maturity: bigint,
  chainNow: bigint,
): TakeoverScopeRefusal | null {
  if (loan.status !== 0) return 'not-active';
  if (loan.assetType !== AssetType.ERC20) return 'rental';
  if (loan.collateralAssetType !== AssetType.ERC20) return 'nft-collateral';
  if (maxTakeoverDays(maturity, chainNow) < 1) return 'no-term-left';
  return null;
}

export interface TakeoverTerms {
  /** The yearly rate the requester agrees to pay, in basis points. */
  rateBps: number;
  durationDays: number;
  /** Collateral the requester locks; at least the loan's. */
  collateralAmount: bigint;
  /** The request's own expiry, from {@link takeoverRequestExpiry}. */
  expiresAt: bigint;
  consent: boolean;
}

/** Why the entered terms cannot make a usable request, or null. */
export type TakeoverTermsRefusal = 'rate' | 'duration' | 'collateral-short';

export function checkTakeoverTerms(
  loan: TakeoverSourceLoan,
  terms: Pick<TakeoverTerms, 'rateBps' | 'durationDays' | 'collateralAmount'>,
  maturity: bigint,
  chainNow: bigint,
): TakeoverTermsRefusal | null {
  if (!Number.isInteger(terms.rateBps) || terms.rateBps < 0 || terms.rateBps > MAX_INTEREST_BPS) {
    return 'rate';
  }
  const maxDays = maxTakeoverDays(maturity, chainNow);
  if (!Number.isInteger(terms.durationDays) || terms.durationDays < 1 || terms.durationDays > maxDays) {
    return 'duration';
  }
  if (terms.collateralAmount < loan.collateralAmount) return 'collateral-short';
  return null;
}

/**
 * The `createTakeoverOffer` payload. A Borrower offer for exactly the
 * loan's principal, all or nothing, at one rate (the rate the loan
 * carries after the handover is the request's own), with the loan's
 * assets repeated. The loan keeps its own repayment settings after a
 * handover (cadence, partial repayment, full-term interest), so the
 * request carries no payment cadence of its own; the two flags are
 * copied from the loan so the request reads the same as the loan it
 * names.
 */
export function toTakeoverOfferPayload(loan: TakeoverSourceLoan, terms: TakeoverTerms): CreateOfferPayload {
  return {
    offerType: 1,
    lendingAsset: loan.principalAsset,
    amount: loan.principal,
    interestRateBps: terms.rateBps,
    collateralAsset: loan.collateralAsset,
    collateralAmount: terms.collateralAmount,
    durationDays: terms.durationDays,
    assetType: AssetType.ERC20,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: terms.consent,
    prepayAsset: loan.prepayAsset,
    collateralAssetType: AssetType.ERC20,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: loan.allowsPartialRepay,
    amountMax: loan.principal,
    interestRateBpsMax: terms.rateBps,
    collateralAmountMax: terms.collateralAmount,
    periodicInterestCadence: 0,
    // Refused by `createTakeoverOffer`.
    allowsParallelSale: false,
    // All or nothing: the handover refuses a partly filled offer.
    fillMode: 1,
    expiresAt: terms.expiresAt,
    allowsPrepayListing: false,
    // Refused by `createTakeoverOffer`: a request is never a refinance.
    refinanceTargetLoanId: 0n,
    useFullTermInterest: loan.useFullTermInterest,
    lifecycleFlex: 0,
    // This app names no integrator.
    integrator: ZERO_ADDRESS,
    linkKind: 0,
    linkMarginBps: 0,
    rateFarFromAverageAcknowledged: false,
  };
}
