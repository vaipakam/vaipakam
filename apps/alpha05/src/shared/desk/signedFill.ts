/**
 * OFF-60 (slice 2) — what a fill of a signed order stands on, and what it
 * did. A signed order has no offer id until its fill creates one, so the
 * accept review reads it through the protocol's own signed counterpart of
 * the accept preview (`previewSignedOfferAccept`), over the offer the fill
 * would write, and the outcome is found by the order's hash in the fill's
 * own log (`SignedOfferFilled`), which names the offer and the loan the
 * fill created.
 *
 * The offer the review binds the taker's signature to is the one the fill
 * writes (`LibSignedOffer.toCreateOfferParams` copies every term verbatim,
 * with one rule: an `amountMax` of zero is the single-amount form and
 * collapses to `amount`). The taker's signed terms key the order by its
 * hash, as the fill does (`verifyAndBindAccept(offerId, orderHash, …)`).
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { RiskPreviewFacetABI } from '@vaipakam/contracts/abis';
import type { AtBlock } from '../tx/anchored';
import type { StoredOffer } from '../offers/acceptTerms';
import { OFFER_PREVIEW, previewFrom, type AcceptPreview } from '../offers/reads';
import { pairFrom, type RiskPair } from '../risk/riskAccess';
import { SIGNED_OFFER } from './mySignedOrders';
import type { BookSignedOrder } from './signedBook';
import { typedMessage, type SignedOrderWire } from './signedOrder';

type Hex = `0x${string}`;

const RISK_PREVIEW = RiskPreviewFacetABI as Abi;

const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** The offer a fill of `o` would write, in the shape `getOffer` returns:
 *  not yet stored (id 0), the signer as creator, nothing filled, not
 *  accepted, no parallel sale. */
export function storedOfferFromSigned(o: SignedOrderWire): StoredOffer {
  const amount = BigInt(o.amount);
  const amountMax = BigInt(o.amountMax);
  const collateralAmount = BigInt(o.collateralAmount);
  const collateralAmountMax = BigInt(o.collateralAmountMax);
  return {
    id: 0n,
    creator: o.signer as Hex,
    offerType: Number(o.offerType),
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    lendingAsset: o.lendingAsset as Hex,
    collateralAsset: o.collateralAsset as Hex,
    amount,
    amountMax: amountMax === 0n ? amount : amountMax,
    amountFilled: 0n,
    interestRateBps: BigInt(o.interestRateBps),
    interestRateBpsMax: BigInt(o.interestRateBpsMax),
    collateralAmount,
    // The same zero-ceiling reading `storedOfferFrom` applies to a stored offer.
    collateralAmountMax: collateralAmountMax === 0n ? collateralAmount : collateralAmountMax,
    collateralAmountFilled: 0n,
    durationDays: BigInt(o.durationDays),
    tokenId: BigInt(o.tokenId),
    collateralTokenId: BigInt(o.collateralTokenId),
    quantity: BigInt(o.quantity),
    collateralQuantity: BigInt(o.collateralQuantity),
    prepayAsset: o.prepayAsset as Hex,
    useFullTermInterest: o.useFullTermInterest,
    allowsPartialRepay: o.allowsPartialRepay,
    allowsPrepayListing: o.allowsPrepayListing,
    allowsParallelSale: o.allowsParallelSale,
    refinanceTargetLoanId: BigInt(o.refinanceTargetLoanId),
    parallelSaleOrderHash: ZERO_HASH,
    periodicInterestCadence: Number(o.periodicInterestCadence),
    expiresAt: BigInt(o.expiresAt),
    accepted: false,
    creatorFull: o.creatorFull,
  };
}

/** The protocol's preview of filling a signed order, for one taker. */
export interface SignedFillPreview {
  accept: AcceptPreview;
  orderHash: Hex;
  /** What a fill draws from the maker's vault, and what it holds free of
   *  that asset now, by the protocol's own count. */
  stakeAsset: Hex;
  stakeRequired: bigint;
  makerFreeHolding: bigint;
}

type Raw = Record<string, unknown>;

export function signedPreviewFrom(raw: Raw): SignedFillPreview {
  return {
    accept: previewFrom(raw.accept as Raw),
    orderHash: raw.orderHash as Hex,
    stakeAsset: raw.stakeAsset as Hex,
    stakeRequired: raw.stakeRequired as bigint,
    makerFreeHolding: raw.makerFreeHolding as bigint,
  };
}

export async function readSignedPreview(c: PublicClient, diamond: Hex, o: BookSignedOrder, acceptor: Hex, b?: AtBlock): Promise<SignedFillPreview> {
  const raw = (await c.readContract({
    address: diamond,
    abi: OFFER_PREVIEW,
    functionName: 'previewSignedOfferAccept',
    args: [typedMessage(o.order), o.signature, acceptor],
    ...(b ? { blockNumber: b.blockNumber } : {}),
  })) as Raw;
  return signedPreviewFrom(raw);
}

/** #3577 — the risk-access gate a fill of `o` by `acceptor` faces, as the
 *  protocol previews it before the order is stored: the maker's block and
 *  the taker's, each with the codes of `previewOfferAcceptBlock` (0 = open
 *  or gate off), and the pair both are gated against. A fill re-gates the
 *  maker first, so the maker's block is the one the fill would raise. */
export interface SignedRiskBlocks {
  creator: number;
  acceptor: number;
  pair: RiskPair;
}

export async function readSignedRiskBlocks(c: PublicClient, diamond: Hex, o: BookSignedOrder, acceptor: Hex, b?: AtBlock): Promise<SignedRiskBlocks> {
  const [creator, taker, pair] = (await c.readContract({
    address: diamond,
    abi: RISK_PREVIEW,
    functionName: 'previewSignedOfferRiskBlocks',
    args: [typedMessage(o.order), acceptor],
    ...(b ? { blockNumber: b.blockNumber } : {}),
  })) as readonly [number | bigint, number | bigint, Record<string, unknown>];
  return { creator: Number(creator), acceptor: Number(taker), pair: pairFrom(pair) };
}

/** The fill call: the order, the maker's signature, the taker's signed
 *  terms and the taker's signature over them. */
export function signedFillCall(
  o: BookSignedOrder,
  terms: unknown,
  termsSignature: Hex,
): { abi: Abi; functionName: 'acceptSignedOffer'; args: readonly unknown[] } {
  return { abi: SIGNED_OFFER, functionName: 'acceptSignedOffer', args: [typedMessage(o.order), o.signature, terms, termsSignature] };
}

/** The offer and loan the fill of `orderHash` created, from the Diamond's
 *  own `SignedOfferFilled` log; null when the transaction recorded none. */
export function signedFillFrom(logs: readonly Log[], diamond: Hex, orderHash: Hex): { offerId: bigint; loanId: bigint } | null {
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = parseEventLogs({ abi: SIGNED_OFFER, logs: [...own], eventName: 'SignedOfferFilled', strict: false }) as unknown as {
    args: { orderHash?: Hex; offerId?: bigint; loanId?: bigint };
  }[];
  const hit = events.find((e) => e.args.orderHash?.toLowerCase() === orderHash.toLowerCase());
  if (!hit || hit.args.offerId === undefined || hit.args.loanId === undefined) return null;
  return { offerId: hit.args.offerId, loanId: hit.args.loanId };
}
