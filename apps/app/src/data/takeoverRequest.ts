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
 *     longer fits: the request's own expiry is set to that moment;
 *   - a term no longer than the platform's longest offer term
 *     (`maxOfferDurationDays`);
 *   - a usable window: the borrower can use a request only once the
 *     platform's minimum offer age has passed (`getMinTermsAgeSec`), so
 *     the expiry must leave at least {@link TAKEOVER_MIN_USABLE_SEC} after
 *     that wait;
 *   - a rate outside the warning band around the term average carries
 *     the requester's own acknowledgement, or posting is refused.
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

/** The latest expiry any offer may carry: one year from posting
 *  (`OfferExpiryAboveCap`). */
export const TAKEOVER_EXPIRY_HORIZON_SEC = 365n * DAY;

/** The shortest time a request stays usable once the minimum offer age has
 *  passed: one hour, so the borrower has a real chance to use it. */
export const TAKEOVER_MIN_USABLE_SEC = 3_600n;

/** The platform settings a request's term is bounded by, read from the
 *  Diamond (never assumed). */
export interface TakeoverLimits {
  /** The longest term any offer may carry (`maxOfferDurationDays`). */
  maxOfferDurationDays: number;
  /** How long after posting a request can first be used (`getMinTermsAgeSec`). */
  minTermsAgeSec: bigint;
}

/** The longest whole-day term a request can carry now. Its expiry
 *  ({@link takeoverRequestExpiry}) must leave the minimum offer age plus
 *  {@link TAKEOVER_MIN_USABLE_SEC} from now, so the term ends that much
 *  before the loan's due date (`maturity`, the loan clock's effective one),
 *  rounded down to whole days, and is never longer than the platform's
 *  longest offer term. */
export function maxTakeoverDays(maturity: bigint, chainNow: bigint, limits: TakeoverLimits): number {
  const room = maturity - chainNow - limits.minTermsAgeSec - TAKEOVER_MIN_USABLE_SEC;
  if (room < DAY) return 0;
  return Math.min(Number(room / DAY), limits.maxOfferDurationDays);
}

/** The last moment a request with this term can be used: after it,
 *  `now + term` passes the due date and the handover refuses it. An offer
 *  may not expire more than a year after it is posted, so on a long loan
 *  the request expires a year from now instead, and says so. */
export function takeoverRequestExpiry(maturity: bigint, durationDays: number, chainNow: bigint): bigint {
  const fit = maturity - BigInt(durationDays) * DAY;
  const horizon = chainNow + TAKEOVER_EXPIRY_HORIZON_SEC;
  return fit < horizon ? fit : horizon;
}

/** Whether the request's expiry was cut to the one-year horizon rather
 *  than set by the loan's due date. */
export function takeoverExpiryAtHorizon(maturity: bigint, durationDays: number, chainNow: bigint): boolean {
  return maturity - BigInt(durationDays) * DAY > chainNow + TAKEOVER_EXPIRY_HORIZON_SEC;
}

/** The interest payment schedules, coarsest last (None, Monthly,
 *  Quarterly, Semi-annual, Annual). */
const CADENCE_PREFERENCE = [0, 4, 3, 2, 1] as const;

/**
 * The payment schedule the request is posted with. The loan keeps its own
 * schedule after a handover, so this value only has to pass the creation
 * rule (`LibCadenceAdmission`): None when it is admitted, else the
 * coarsest one admitted (a term over a year with periodic interest needs
 * at least Annual). Null when the rule admits none, so the form refuses
 * rather than posting a request that would revert.
 */
export function takeoverCadence(admitted: (cadence: number) => boolean): number | null {
  for (const c of CADENCE_PREFERENCE) if (admitted(c)) return c;
  return null;
}

/** The smallest collateral that keeps the request inside the loan-opening
 *  risk bounds (`initRiskBounds`) and at or above the loan's own. */
export interface TakeoverRiskBounds {
  /** The least collateral the bounds admit for the loan's principal. */
  floor: bigint;
  /** The largest principal the entered collateral backs. */
  amountCap: bigint;
}

/** Whether this form can post a request for the loan. */
export function takeoverScope(
  loan: TakeoverSourceLoan,
  maturity: bigint,
  chainNow: bigint,
  limits: TakeoverLimits,
): TakeoverScopeRefusal | null {
  if (loan.status !== 0) return 'not-active';
  if (loan.assetType !== AssetType.ERC20) return 'rental';
  if (loan.collateralAssetType !== AssetType.ERC20) return 'nft-collateral';
  if (maxTakeoverDays(maturity, chainNow, limits) < 1) return 'no-term-left';
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
  /** The schedule from {@link takeoverCadence}. */
  cadence: number;
  consent: boolean;
  /** The requester confirmed a rate outside the warning band around the
   *  term average (`RateLinkFacet.rateWarnings`). Needed only then. */
  rateFarAcknowledged: boolean;
}

/** Why the entered terms cannot make a usable request, or null. */
export type TakeoverTermsRefusal = 'rate' | 'duration' | 'collateral-short' | 'collateral-floor';

export function checkTakeoverTerms(
  loan: TakeoverSourceLoan,
  terms: Pick<TakeoverTerms, 'rateBps' | 'durationDays' | 'collateralAmount'>,
  maturity: bigint,
  chainNow: bigint,
  limits: TakeoverLimits,
  bounds?: TakeoverRiskBounds,
): TakeoverTermsRefusal | null {
  if (!Number.isInteger(terms.rateBps) || terms.rateBps < 0 || terms.rateBps > MAX_INTEREST_BPS) {
    return 'rate';
  }
  const maxDays = maxTakeoverDays(maturity, chainNow, limits);
  if (!Number.isInteger(terms.durationDays) || terms.durationDays < 1 || terms.durationDays > maxDays) {
    return 'duration';
  }
  if (terms.collateralAmount < loan.collateralAmount) return 'collateral-short';
  if (bounds && (terms.collateralAmount < bounds.floor || loan.principal > bounds.amountCap)) {
    return 'collateral-floor';
  }
  return null;
}

/**
 * The `createTakeoverOffer` payload. A Borrower offer for exactly the
 * loan's principal, all or nothing, at one rate (the rate the loan
 * carries after the handover is the request's own), with the loan's
 * assets repeated. The loan keeps its own repayment settings after a
 * handover (cadence, partial repayment, full-term interest). The two
 * flags are copied from the loan so the request reads the same as the
 * loan it names; the cadence is only the one the creation rule admits
 * ({@link takeoverCadence}) and does not change the loan's.
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
    periodicInterestCadence: terms.cadence,
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
    rateFarFromAverageAcknowledged: terms.rateFarAcknowledged,
  };
}
