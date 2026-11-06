/**
 * OFF-04 / OFF-07 / OFF-12 / OFF-13 / OFF-18 — the borrow request a reader
 * types, as plain rules: what each field accepts, what the protocol is sent
 * for it, and what it promises the reader. Nothing here reads the chain;
 * the review (requestReview.ts) adds the protocol's own figures and verdict.
 *
 * Basic posts a single-value request: the amount, the rate and the
 * collateral are each one figure (the protocol's minimum and maximum are
 * the same), so a lender lends exactly that amount or nothing.
 *
 * OFF-10 / OFF-11 (Advanced): a range lets a lender lend anywhere from the
 * smallest to the largest amount, the rate stays the one most you pay, and
 * the collateral is the most you lock with, optionally, a smaller amount for
 * the smallest loan (the protocol's floor); a fill mode says how matches
 * may fill it. A lender taking it directly lends the smallest amount at your
 * rate against the floor, and the collateral above the floor goes back to
 * your wallet (spec §4, direct-accept semantics).
 */
import { interestAtDue, listFee } from '../../../shared/offers/model';

import type { Cadence } from '../../../shared/offers/cadence';

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
  /** The ERC-20 amount locked, or an ERC-1155 token's quantity, as typed. */
  collateral: string;
  /** NFT-13: the id of the NFT pledged (ERC-721 or ERC-1155), as typed. */
  tokenId: string;
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
  /** OFF-10 (Advanced): the amount is a range from `amount` to `amountMax`. */
  ranged: boolean;
  amountMax: string;
  /** OFF-10 (Advanced): the collateral locked for the smallest loan, as
   *  typed; blank means the same as `collateral` (no collateral range). */
  collateralFloor: string;
  /** OFF-11 (Advanced): how matches may fill the request. */
  fillMode: FillMode;
  /** OFF-14 (Advanced): the periodic-interest schedule, by the protocol's
   *  cadence position; 0 is interest at repayment. */
  cadence: Cadence;
}

/** OFF-11: the fill modes, in the protocol's `FillMode` order. */
export const FILL_MODES = ['partial', 'aon', 'ioc'] as const;
export type FillMode = (typeof FILL_MODES)[number];
export const FILL_MODE_CODE: Readonly<Record<FillMode, number>> = { partial: 0, aon: 1, ioc: 2 };

export const DEFAULT_INPUT: RequestInput = {
  amount: '',
  collateral: '',
  tokenId: '',
  rate: '',
  durationDays: DEFAULT_DURATION_DAYS,
  customTerm: false,
  termDays: '',
  expiry: '7d',
  expiryDays: '',
  fullTerm: true,
  allowsPartialRepay: false,
  ranged: false,
  amountMax: '',
  collateralFloor: '',
  fillMode: 'partial',
  cadence: 0,
};

/** Why a fill mode cannot go with the rest of the request: all-or-none
 *  takes one amount, never a range, and immediate-or-cancel needs an
 *  expiry (the protocol refuses both shapes). */
export type FillModeBlock = 'aon-range' | 'ioc-open';

export function fillModeBlock(mode: FillMode, ranged: boolean, expiry: ExpiryChoice): FillModeBlock | null {
  if (mode === 'aon' && ranged) return 'aon-range';
  if (mode === 'ioc' && expiry === 'never') return 'ioc-open';
  return null;
}

/** Why a range is not well formed: the largest amount below the smallest,
 *  or the floor collateral above what is locked. */
export type RangeError = 'max-below-min' | 'floor-above-lock';

export function rangeError(amount: bigint, amountMax: bigint, collateral: bigint, floor: bigint): RangeError | null {
  if (amountMax < amount) return 'max-below-min';
  if (floor > collateral) return 'floor-above-lock';
  return null;
}

/** The Advanced options a request carries, named so a Basic reader is told
 *  they still apply (RB-MODE: switching mode never drops what was set). */
export type AdvancedOption = 'range' | 'fill' | 'cadence';

export function advancedSet(input: RequestInput): AdvancedOption[] {
  const out: AdvancedOption[] = [];
  if (input.ranged) out.push('range');
  if (input.fillMode !== 'partial') out.push('fill');
  if (input.cadence !== 0) out.push('cadence');
  return out;
}

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
  /** The smallest amount a lender may lend (the whole amount when single). */
  amount: bigint;
  /** The largest amount a match may lend; equal to `amount` when single. */
  amountMax: bigint;
  /** The ERC-20 amount locked now; for an ERC-721, the one token (1); for an
   *  ERC-1155, the quantity of the one token. */
  collateral: bigint;
  /** The ERC-20 collateral the smallest loan locks (the protocol's floor);
   *  equal to `collateral` without a collateral range, and unused for an
   *  NFT leg. */
  collateralFloor: bigint;
  fillMode: FillMode;
  /** OFF-14: the schedule; 0 is interest at repayment. */
  cadence: Cadence;
  rateBps: bigint;
  durationDays: number;
  expiry: ExpiryChoice;
  fullTerm: boolean;
  allowsPartialRepay: boolean;
}

/** NFT-13: what the collateral leg is. An ERC-721 token is pledged whole,
 *  by its id; an ERC-1155 leg is a quantity of one token, by its id. */
export type CollateralLeg = { kind: 'erc20' } | { kind: 'erc721'; tokenId: bigint } | { kind: 'erc1155'; tokenId: bigint; quantity: bigint };

export interface RequestPair {
  lending: Hex;
  collateral: Hex;
  leg: CollateralLeg;
}

/** The two assets the borrower picked, and the standard the collateral's
 *  contract claims; the form adds the token id for an ERC-721 leg. */
export interface RequestAssets {
  lending: Hex;
  collateral: Hex;
  standard: CollateralLeg['kind'];
}

/** The protocol's `AssetType` positions for the NFT standards. */
export const ASSET_ERC721 = 1;
export const ASSET_ERC1155 = 2;

/**
 * The protocol call for this request (`createOffer`'s parameters). The
 * range fields carry the request's range (equal ends for a single value);
 * the rate's two ends are the one rate, the most the borrower pays. Every
 * option this page does not offer is sent at its stated default (no
 * listing rights, no refinance target), and the review states each.
 */
export function createParams(p: ParsedRequest, pair: RequestPair, expiry: bigint) {
  const leg = pair.leg;
  const nft = leg.kind !== 'erc20';
  return {
    offerType: OFFER_TYPE_BORROWER,
    lendingAsset: pair.lending,
    amount: p.amount,
    interestRateBps: p.rateBps,
    collateralAsset: pair.collateral,
    // An NFT leg carries no amount: the token is named by its id, and an
    // ERC-1155 leg carries its quantity.
    collateralAmount: nft ? 0n : p.collateralFloor,
    durationDays: BigInt(p.durationDays),
    assetType: ASSET_ERC20,
    tokenId: 0n,
    quantity: 1n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: ZERO,
    collateralAssetType: leg.kind === 'erc721' ? ASSET_ERC721 : leg.kind === 'erc1155' ? ASSET_ERC1155 : ASSET_ERC20,
    collateralTokenId: leg.kind === 'erc20' ? 0n : leg.tokenId,
    collateralQuantity: leg.kind === 'erc721' ? 1n : leg.kind === 'erc1155' ? leg.quantity : 0n,
    allowsPartialRepay: p.allowsPartialRepay,
    amountMax: p.amountMax,
    interestRateBpsMax: p.rateBps,
    collateralAmountMax: nft ? 0n : p.collateral,
    periodicInterestCadence: p.cadence,
    expiresAt: expiry,
    fillMode: FILL_MODE_CODE[p.fillMode],
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

/** Whether the request is a range: a lender may lend less than the most it
 *  asks, or the smallest loan locks less than everything posted. */
export function isRanged(p: Pick<ParsedRequest, 'amount' | 'amountMax' | 'collateral' | 'collateralFloor'>): boolean {
  return p.amountMax !== p.amount || p.collateralFloor !== p.collateral;
}

/** OFF-19: the fee is the list rate on the amount, charged once in the
 *  lending asset when a lender takes the request; a discount tier can only
 *  lower it, and the tier counts as of that moment. */
export function requestFigures(amount: bigint, rateBps: bigint, durationDays: number, lifBps: bigint): RequestFigures {
  const fee = listFee(amount, lifBps);
  const interest = interestAtDue(amount, rateBps, BigInt(durationDays));
  return { received: amount - fee, fee, interest, owedAtDue: amount + interest };
}
