/**
 * OFF-04 / OFF-07 / OFF-12 / OFF-13 / OFF-18 — the borrow request a reader
 * types, as plain rules: what each field accepts, what the protocol is sent
 * for it, and what it promises the reader. Nothing here reads the chain;
 * the review (requestReview.ts) adds the protocol's own figures and verdict.
 *
 * Basic posts a single-value request: the amount, the rate and the
 * collateral are each one figure (the protocol's minimum and maximum are
 * the same), so a lender lends exactly that amount or nothing.
 */
import { interestAtDue, listFee } from '../../../shared/offers/model';

type Hex = `0x${string}`;

export const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** OFF-04: the duration buckets the picker offers; 30 days is the default. */
export const DURATION_BUCKETS = [7, 14, 30, 60, 90, 180, 365] as const;
export const DEFAULT_DURATION_DAYS = 30;

/** OFF-12: how long the request stays open before it lapses unaccepted;
 *  `custom` takes a typed number of days. */
export const EXPIRY_CHOICES = ['never', '1d', '7d', '30d', 'custom'] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];
const EXPIRY_DAYS: Readonly<Record<Exclude<ExpiryChoice, 'never' | 'custom'>, number>> = { '1d': 1, '7d': 7, '30d': 30 };
/** The furthest expiry the protocol accepts: one year ahead. */
export const MAX_EXPIRY_DAYS = 365;

/** The protocol's offer type for a borrower's request, and its ERC-20 leg. */
export const OFFER_TYPE_BORROWER = 1;
export const ASSET_ERC20 = 0;

/** What the reader typed, kept as text so nothing is rounded on the way. */
export interface RequestInput {
  amount: string;
  collateral: string;
  /** The yearly rate in percent, as typed ("8.5"). */
  rate: string;
  durationDays: number;
  /** OFF-04: a term typed in days instead of a bucket, when `customTerm`. */
  customTerm: boolean;
  termDays: string;
  expiry: ExpiryChoice;
  /** The days typed for a `custom` expiry. */
  expiryDays: string;
  /** OFF-13: the full-term interest floor (the default) or pro-rata. */
  fullTerm: boolean;
  allowsPartialRepay: boolean;
}

export const DEFAULT_INPUT: RequestInput = {
  amount: '',
  collateral: '',
  rate: '',
  durationDays: DEFAULT_DURATION_DAYS,
  customTerm: false,
  termDays: '',
  expiry: '7d',
  expiryDays: '',
  fullTerm: true,
  allowsPartialRepay: false,
};

export type ParseError = 'empty' | 'invalid' | 'zero' | 'decimals';

/**
 * A typed amount in the token's base units, exactly: digits with at most
 * one decimal point. More decimals than the token has are refused, never
 * rounded (OFF-18), and zero is refused, since the protocol takes no empty
 * leg.
 */
export function parseAmount(text: string, decimals: number): { ok: true; value: bigint } | { ok: false; error: ParseError } {
  const t = text.trim();
  if (t === '') return { ok: false, error: 'empty' };
  if (!/^\d*\.?\d*$/.test(t) || t === '.') return { ok: false, error: 'invalid' };
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > decimals) return { ok: false, error: 'decimals' };
  const value = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac || '').padEnd(decimals, '0') || '0');
  if (value === 0n) return { ok: false, error: 'zero' };
  return { ok: true, value };
}

/** The highest yearly rate a request may carry: 100% (10,000 bps). */
export const MAX_RATE_BPS = 10_000n;

/** A typed yearly rate in basis points, exactly (at most two decimals). */
export function parseRateBps(text: string): { ok: true; value: bigint } | { ok: false; error: ParseError | 'high' } {
  const r = parseAmount(text, 2);
  if (!r.ok) return r;
  if (r.value > MAX_RATE_BPS) return { ok: false, error: 'high' };
  return r;
}

/** A typed whole number of days from 1 to `max`. */
export function parseDays(text: string, max: number): { ok: true; value: number } | { ok: false; error: 'empty' | 'invalid' | 'zero' | 'high' } {
  const t = text.trim();
  if (t === '') return { ok: false, error: 'empty' };
  if (!/^\d+$/.test(t)) return { ok: false, error: 'invalid' };
  const n = Number(t);
  if (n === 0) return { ok: false, error: 'zero' };
  if (n > max) return { ok: false, error: 'high' };
  return { ok: true, value: n };
}

/** Whether a duration is inside the live range (1 day to the configured
 *  maximum); the maximum is read from the protocol, never assumed. */
export function durationOk(days: number, maxDays: bigint): boolean {
  return Number.isInteger(days) && days >= 1 && BigInt(days) <= maxDays;
}

/** The buckets inside the live range, so the picker never offers a term
 *  the protocol would refuse. */
export function bucketsWithin(maxDays: bigint): number[] {
  return DURATION_BUCKETS.filter((d) => BigInt(d) <= maxDays);
}

/** The request's expiry as the protocol stores it: 0 for open until taken
 *  or cancelled, else an absolute time that many days after `nowSeconds`
 *  (`customDays` for a `custom` choice). */
export function expiresAt(choice: ExpiryChoice, nowSeconds: bigint, customDays = 0): bigint {
  if (choice === 'never') return 0n;
  const days = choice === 'custom' ? customDays : EXPIRY_DAYS[choice];
  return nowSeconds + BigInt(days) * 86_400n;
}

/** The figures a request carries once parsed; null fields failed to parse. */
export interface ParsedRequest {
  amount: bigint;
  collateral: bigint;
  rateBps: bigint;
  durationDays: number;
  expiry: ExpiryChoice;
  fullTerm: boolean;
  allowsPartialRepay: boolean;
}

export interface RequestPair {
  lending: Hex;
  collateral: Hex;
}

/**
 * The protocol call for this request (`createOffer`'s parameters). Every
 * range field carries the single value; every option this page does not
 * offer is sent at its stated default (no schedule, no listing rights, no
 * refinance target), and the review states each.
 */
export function createParams(p: ParsedRequest, pair: RequestPair, expiry: bigint) {
  return {
    offerType: OFFER_TYPE_BORROWER,
    lendingAsset: pair.lending,
    amount: p.amount,
    interestRateBps: p.rateBps,
    collateralAsset: pair.collateral,
    collateralAmount: p.collateral,
    durationDays: BigInt(p.durationDays),
    assetType: ASSET_ERC20,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: ZERO,
    collateralAssetType: ASSET_ERC20,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: p.allowsPartialRepay,
    amountMax: p.amount,
    interestRateBpsMax: p.rateBps,
    collateralAmountMax: p.collateral,
    periodicInterestCadence: 0,
    expiresAt: expiry,
    fillMode: 0,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: p.fullTerm,
  } as const;
}

export type CreateParams = ReturnType<typeof createParams>;

/** What a request would pay the borrower and ask back, if a lender takes it
 *  at once and the protocol never pauses. */
export interface RequestFigures {
  /** The amount less the list-rate fee: the most the fee leaves you. */
  received: bigint;
  fee: bigint;
  interest: bigint;
  owedAtDue: bigint;
}

/** OFF-19: the fee is the list rate on the amount, charged once in the
 *  lending asset when a lender takes the request; a discount tier can only
 *  lower it, and the tier counts as of that moment. */
export function requestFigures(amount: bigint, rateBps: bigint, durationDays: number, lifBps: bigint): RequestFigures {
  const fee = listFee(amount, lifBps);
  const interest = interestAtDue(amount, rateBps, BigInt(durationDays));
  return { received: amount - fee, fee, interest, owedAtDue: amount + interest };
}
