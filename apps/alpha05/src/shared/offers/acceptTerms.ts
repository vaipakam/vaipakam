/**
 * OFF-50 / OFF-17 — the terms an acceptor signs before a direct accept. The
 * protocol binds EVERY loan-affecting field of the stored offer to the
 * acceptor's signature (EIP-712 `AcceptTerms`, `LibAcceptTerms`), so a page
 * that shows one figure and asks the wallet to sign another cannot get past
 * the contract. The signed message is built only from the offer as read from
 * the chain, never from anything the reader typed, and it records the
 * combined Risk and Terms consent the review asked for.
 *
 * The type list below is the contract's typehash, field for field; the unit
 * test reads `LibAcceptTerms.sol` and refuses any drift.
 */
import { encodeAbiParameters, keccak256 } from 'viem';

type Hex = `0x${string}`;

export const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';

/** The protocol's offer types and asset types, by their enum position. */
export const OFFER_LENDER = 0;
export const OFFER_BORROWER = 1;
export const ASSET_ERC20 = 0;

export const ACCEPT_TERMS_DOMAIN_NAME = 'Vaipakam AcceptOffer';
export const ACCEPT_TERMS_DOMAIN_VERSION = '1';

export const ACCEPT_TERMS_TYPES = {
  AcceptTerms: [
    { name: 'acceptor', type: 'address' },
    { name: 'offerCreator', type: 'address' },
    { name: 'offerKey', type: 'bytes32' },
    { name: 'offerType', type: 'uint8' },
    { name: 'lendingAsset', type: 'address' },
    { name: 'collateralAsset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'interestRateBps', type: 'uint256' },
    { name: 'durationDays', type: 'uint256' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'collateralTokenId', type: 'uint256' },
    { name: 'quantity', type: 'uint256' },
    { name: 'collateralQuantity', type: 'uint256' },
    { name: 'assetType', type: 'uint8' },
    { name: 'collateralAssetType', type: 'uint8' },
    { name: 'prepayAsset', type: 'address' },
    { name: 'useFullTermInterest', type: 'bool' },
    { name: 'allowsPartialRepay', type: 'bool' },
    { name: 'allowsPrepayListing', type: 'bool' },
    { name: 'allowsParallelSale', type: 'bool' },
    { name: 'refinanceTargetLoanId', type: 'uint256' },
    { name: 'linkedLoanId', type: 'uint256' },
    { name: 'parallelSaleOrderHash', type: 'bytes32' },
    { name: 'periodicInterestCadence', type: 'uint8' },
    { name: 'riskAndTermsConsent', type: 'bool' },
    { name: 'acknowledgedIlliquidLendingAsset', type: 'address' },
    { name: 'acknowledgedIlliquidCollateralAsset', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'riskTermsHash', type: 'bytes32' },
    { name: 'acceptorFull', type: 'bool' },
    { name: 'acceptorMaxCStar', type: 'uint256' },
    { name: 'acceptorAllowFullDowngrade', type: 'bool' },
  ],
} as const;

/** The stored offer's fields the signature binds, as `getOffer` returns them. */
export interface StoredOffer {
  id: bigint;
  creator: Hex;
  offerType: number;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: Hex;
  collateralAsset: Hex;
  amount: bigint;
  amountMax: bigint;
  amountFilled: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAmount: bigint;
  durationDays: bigint;
  tokenId: bigint;
  collateralTokenId: bigint;
  quantity: bigint;
  collateralQuantity: bigint;
  prepayAsset: Hex;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  allowsParallelSale: boolean;
  refinanceTargetLoanId: bigint;
  parallelSaleOrderHash: Hex;
  periodicInterestCadence: number;
  expiresAt: bigint;
  accepted: boolean;
}

export type AcceptTermsMessage = {
  acceptor: Hex;
  offerCreator: Hex;
  offerKey: Hex;
  offerType: number;
  lendingAsset: Hex;
  collateralAsset: Hex;
  amount: bigint;
  collateralAmount: bigint;
  interestRateBps: bigint;
  durationDays: bigint;
  tokenId: bigint;
  collateralTokenId: bigint;
  quantity: bigint;
  collateralQuantity: bigint;
  assetType: number;
  collateralAssetType: number;
  prepayAsset: Hex;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  allowsParallelSale: boolean;
  refinanceTargetLoanId: bigint;
  linkedLoanId: bigint;
  parallelSaleOrderHash: Hex;
  periodicInterestCadence: number;
  riskAndTermsConsent: boolean;
  acknowledgedIlliquidLendingAsset: Hex;
  acknowledgedIlliquidCollateralAsset: Hex;
  nonce: bigint;
  deadline: bigint;
  riskTermsHash: Hex;
  acceptorFull: boolean;
  acceptorMaxCStar: bigint;
  acceptorAllowFullDowngrade: boolean;
};

/** A direct offer's key: the offer id, ABI-encoded and hashed. */
export function directOfferKey(offerId: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }], [offerId]));
}

/** The amount and rate the protocol binds for the acceptor's role on an
 *  ERC-20 offer: a borrower accepting a lender offer takes the lender's
 *  upper amount at the lender's floor rate; a lender accepting a borrow
 *  request funds the borrower's lower amount at the borrower's ceiling. */
export function roleTerms(o: Pick<StoredOffer, 'offerType' | 'assetType' | 'amount' | 'amountMax' | 'interestRateBps' | 'interestRateBpsMax'>): {
  amount: bigint;
  rateBps: bigint;
} {
  if (o.assetType !== ASSET_ERC20) return { amount: o.amount, rateBps: o.interestRateBps };
  return o.offerType === OFFER_LENDER ? { amount: o.amountMax, rateBps: o.interestRateBps } : { amount: o.amount, rateBps: o.interestRateBpsMax };
}

export interface AcceptContext {
  acceptor: Hex;
  linkedLoanId: bigint;
  riskTermsHash: Hex;
  nonce: bigint;
  deadline: bigint;
  /** Which legs the review showed as illiquid. The acknowledgement names an
   *  asset only when the reader was shown that leg as illiquid; a leg the
   *  protocol finds illiquid at accept that the review did not show is
   *  refused by the contract, never consented to silently. */
  illiquidLending: boolean;
  illiquidCollateral: boolean;
}

/** The message, from the offer as stored and the review's context. The Full
 *  fee tariff is never opted into here (an Advanced option, RW-20). */
export function buildAcceptTerms(o: StoredOffer, ctx: AcceptContext): AcceptTermsMessage {
  const { amount, rateBps } = roleTerms(o);
  return {
    acceptor: ctx.acceptor,
    offerCreator: o.creator,
    offerKey: directOfferKey(o.id),
    offerType: o.offerType,
    lendingAsset: o.lendingAsset,
    collateralAsset: o.collateralAsset,
    amount,
    collateralAmount: o.collateralAmount,
    interestRateBps: rateBps,
    durationDays: o.durationDays,
    tokenId: o.tokenId,
    collateralTokenId: o.collateralTokenId,
    quantity: o.quantity,
    collateralQuantity: o.collateralQuantity,
    assetType: o.assetType,
    collateralAssetType: o.collateralAssetType,
    prepayAsset: o.prepayAsset,
    useFullTermInterest: o.useFullTermInterest,
    allowsPartialRepay: o.allowsPartialRepay,
    allowsPrepayListing: o.allowsPrepayListing,
    allowsParallelSale: o.allowsParallelSale,
    refinanceTargetLoanId: o.refinanceTargetLoanId,
    linkedLoanId: ctx.linkedLoanId,
    parallelSaleOrderHash: o.parallelSaleOrderHash,
    periodicInterestCadence: o.periodicInterestCadence,
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: ctx.illiquidLending ? o.lendingAsset : ZERO_ADDRESS,
    acknowledgedIlliquidCollateralAsset: ctx.illiquidCollateral ? o.collateralAsset : ZERO_ADDRESS,
    nonce: ctx.nonce,
    deadline: ctx.deadline,
    riskTermsHash: ctx.riskTermsHash,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
  };
}

/** The EIP-712 type string the list above encodes, as the contract writes it. */
export function acceptTermsTypeString(): string {
  return `AcceptTerms(${ACCEPT_TERMS_TYPES.AcceptTerms.map((f) => `${f.type} ${f.name}`).join(',')})`;
}

/** A fresh replay nonce: 128 random bits, so two reviews never collide. */
export function freshNonce(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): bigint {
  const bytes = random(new Uint8Array(16));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/** How long a signed acceptance stays valid, counted from the chain's clock. */
export const ACCEPT_DEADLINE_SECONDS = 30 * 60;
