/**
 * OFF-41 / OFF-44 / OFF-50 — the chain reads an accept stands on. Every
 * figure here is the protocol's own answer through the connected wallet's
 * connection (the own rail), never the index: the offers open for a pair come
 * from the protocol's pair index, each offer's terms from `getOffer`, its
 * state from `getOfferState`, and what an acceptance would do for THIS
 * wallet from `previewAccept`, which is the source of truth for the amount
 * received, the rate, the collateral, the fee and the first refusal.
 */
import { erc20Abi, type Abi, type PublicClient } from 'viem';
import {
  MetricsFacetABI,
  OfferCancelFacetABI,
  OfferPreviewFacetABI,
  OracleFacetABI,
  RiskAccessFacetABI,
  RiskPreviewFacetABI,
  ConfigFacetABI,
  VaultFactoryFacetABI,
} from '@vaipakam/contracts/abis';
import type { AtBlock } from '../tx/anchored';
import type { StoredOffer } from './acceptTerms';

type Hex = `0x${string}`;

export const METRICS = MetricsFacetABI as Abi;
export const OFFER_CANCEL = OfferCancelFacetABI as Abi;
export const OFFER_PREVIEW = OfferPreviewFacetABI as Abi;
export const ORACLE = OracleFacetABI as Abi;
export const RISK_ACCESS = RiskAccessFacetABI as Abi;
export const RISK_PREVIEW = RiskPreviewFacetABI as Abi;
export const CONFIG = ConfigFacetABI as Abi;
export const VAULT_FACTORY = VaultFactoryFacetABI as Abi;

/** `LibMetricsTypes.OfferState`, by enum position. */
export const OFFER_STATES = ['open', 'accepted', 'cancelled', 'sale-consumed', 'expired'] as const;
export type OfferState = (typeof OFFER_STATES)[number];

/** `LibVaipakam.LiquidityStatus`, by enum position. */
export const LIQUIDITY = ['liquid', 'illiquid'] as const;
export type Liquidity = (typeof LIQUIDITY)[number];

/** `OfferAcceptFacet.AcceptError`, by enum position: the protocol's first
 *  refusal of an acceptance, as `previewAccept` reports it. */
export const ACCEPT_ERRORS = [
  'None',
  'OfferAlreadyAccepted',
  'SanctionedAcceptor',
  'SanctionedCreator',
  'AssetPaused',
  'CountriesNotCompatible',
  'RiskAndTermsConsentRequired',
  'KYCRequired',
  'OfferExpired',
  'OfferPartiallyFilled',
  'SaleLoanNotActive',
  'SaleSelfBuy',
  'OfferIsCancelled',
  'SaleLoanPastMaturity',
  'SalePositionBelowSolvencyFloor',
  'SaleAdmissionBlocked',
  'SaleListingTermsStale',
  'ProtocolPaused',
  // #3204 — retired with the mandatory vault version; never produced.
  'RetiredVaultUpgradeRequired',
  'SelfTrade',
  'RefinanceRequestUntakeable',
  'CadenceNotAdmitted',
] as const;
export type AcceptErrorName = (typeof ACCEPT_ERRORS)[number] | 'Unrecognised';

export function acceptErrorName(code: number): AcceptErrorName {
  return ACCEPT_ERRORS[code] ?? 'Unrecognised';
}

export interface AcceptPreview {
  /** The principal the loan records, before the initiation fee. */
  effectivePrincipal: bigint;
  interestRateBps: bigint;
  collateralAmount: bigint;
  /** The loan initiation fee, in the lending asset, taken from the principal. */
  lifEstimate: bigint;
  collateralResidualRefund: bigint;
  error: AcceptErrorName;
}

type Raw = Record<string, unknown>;

export function storedOfferFrom(raw: Raw): StoredOffer {
  return {
    id: raw.id as bigint,
    creator: raw.creator as Hex,
    offerType: Number(raw.offerType),
    assetType: Number(raw.assetType),
    collateralAssetType: Number(raw.collateralAssetType),
    lendingAsset: raw.lendingAsset as Hex,
    collateralAsset: raw.collateralAsset as Hex,
    amount: raw.amount as bigint,
    amountMax: raw.amountMax as bigint,
    amountFilled: raw.amountFilled as bigint,
    interestRateBps: raw.interestRateBps as bigint,
    interestRateBpsMax: raw.interestRateBpsMax as bigint,
    collateralAmount: raw.collateralAmount as bigint,
    durationDays: raw.durationDays as bigint,
    tokenId: raw.tokenId as bigint,
    collateralTokenId: raw.collateralTokenId as bigint,
    quantity: raw.quantity as bigint,
    collateralQuantity: raw.collateralQuantity as bigint,
    prepayAsset: raw.prepayAsset as Hex,
    useFullTermInterest: Boolean(raw.useFullTermInterest),
    allowsPartialRepay: Boolean(raw.allowsPartialRepay),
    allowsPrepayListing: Boolean(raw.allowsPrepayListing),
    allowsParallelSale: Boolean(raw.allowsParallelSale),
    refinanceTargetLoanId: raw.refinanceTargetLoanId as bigint,
    parallelSaleOrderHash: raw.parallelSaleOrderHash as Hex,
    periodicInterestCadence: Number(raw.periodicInterestCadence),
    expiresAt: BigInt(raw.expiresAt as bigint | number),
    accepted: Boolean(raw.accepted),
    creatorFull: Boolean(raw.creatorFull),
  };
}

export function previewFrom(raw: Raw): AcceptPreview {
  return {
    effectivePrincipal: raw.effectivePrincipal as bigint,
    interestRateBps: raw.interestRateBps as bigint,
    collateralAmount: raw.collateralAmount as bigint,
    lifEstimate: raw.lifEstimate as bigint,
    collateralResidualRefund: raw.collateralResidualRefund as bigint,
    error: acceptErrorName(Number(raw.errorCode)),
  };
}

const at = (b?: AtBlock) => (b ? { blockNumber: b.blockNumber } : {});

export async function readOffer(client: PublicClient, diamond: Hex, offerId: bigint, b?: AtBlock): Promise<StoredOffer> {
  const raw = (await client.readContract({
    address: diamond,
    abi: OFFER_CANCEL,
    functionName: 'getOffer',
    args: [offerId],
    ...at(b),
  })) as Raw;
  return storedOfferFrom(raw);
}

export async function readOfferState(client: PublicClient, diamond: Hex, offerId: bigint, b?: AtBlock): Promise<OfferState> {
  const s = Number(
    await client.readContract({
      address: diamond,
      abi: METRICS,
      functionName: 'getOfferState',
      args: [offerId],
      ...at(b),
    }),
  );
  return OFFER_STATES[s] ?? 'open';
}

export async function readPreview(client: PublicClient, diamond: Hex, offerId: bigint, acceptor: Hex, b?: AtBlock): Promise<AcceptPreview> {
  return previewFrom(
    (await client.readContract({
      address: diamond,
      abi: OFFER_PREVIEW,
      functionName: 'previewAccept',
      args: [offerId, acceptor],
      ...at(b),
    })) as Raw,
  );
}

export async function readLinkedLoanId(client: PublicClient, diamond: Hex, offerId: bigint): Promise<bigint> {
  return (await client.readContract({
    address: diamond,
    abi: OFFER_CANCEL,
    functionName: 'getOfferLinkedLoanId',
    args: [offerId],
  })) as bigint;
}

/** The risk-access gate's answer for this acceptor (0 = open or the gate is
 *  off; 1 = risk tier too low; 2 = this pair needs a recorded consent; 3 =
 *  a strict-mode acknowledgement is missing; 4 = an illiquid pair the signed
 *  acceptance's acknowledgement once covered, which this app treats as 2:
 *  only a pair consent clears it, owner decision 2026-11-06). */
export async function readAcceptGate(client: PublicClient, diamond: Hex, offerId: bigint, acceptor: Hex): Promise<number> {
  return Number(
    await client.readContract({
      address: diamond,
      abi: RISK_PREVIEW,
      functionName: 'previewOfferAcceptBlock',
      args: [offerId, acceptor],
    }),
  );
}

/** The risk-access block the offer's CREATOR faces on this offer now (the
 *  accept gate re-checks the creator first, and the combined preview returns
 *  the creator's code before the acceptor's), so a page can tell a lender-side
 *  block from one the connected wallet could act on. 0 = none. */
export async function readCreatorGate(client: PublicClient, diamond: Hex, offerId: bigint): Promise<number> {
  return Number(
    await client.readContract({
      address: diamond,
      abi: RISK_PREVIEW,
      functionName: 'previewCreatorBlock',
      args: [offerId],
    }),
  );
}

export async function readRiskTermsHash(client: PublicClient, diamond: Hex): Promise<Hex> {
  return (await client.readContract({
    address: diamond,
    abi: RISK_ACCESS,
    functionName: 'getCurrentRiskTermsHash',
  })) as Hex;
}

/** A leg's liquidity on this network, as the protocol classifies it now. A
 *  price the protocol distrusts reverts; the caller reports that, never a
 *  guessed class. */
export async function readLiquidity(client: PublicClient, diamond: Hex, asset: Hex): Promise<Liquidity> {
  const s = Number(
    await client.readContract({
      address: diamond,
      abi: ORACLE,
      functionName: 'checkLiquidityOnActiveNetwork',
      args: [asset],
    }),
  );
  return LIQUIDITY[s] ?? 'illiquid';
}

/** The ratio of the borrowed value to the collateral value, in basis
 *  points, by the protocol's own valuation rule. */
export async function readPairLtvBps(client: PublicClient, diamond: Hex, borrowed: Hex, amount: bigint, collateral: Hex, collateralAmount: bigint): Promise<bigint> {
  return (await client.readContract({
    address: diamond,
    abi: ORACLE,
    functionName: 'calculateLTV',
    args: [borrowed, amount, collateral, collateralAmount],
  })) as bigint;
}

export async function readGraceSeconds(client: PublicClient, diamond: Hex, durationDays: bigint): Promise<bigint> {
  return (await client.readContract({
    address: diamond,
    abi: CONFIG,
    functionName: 'getEffectiveGraceSeconds',
    args: [durationDays],
  })) as bigint;
}

export async function readLifBps(client: PublicClient, diamond: Hex): Promise<bigint> {
  return (await client.readContract({
    address: diamond,
    abi: CONFIG,
    functionName: 'getLoanInitiationFeeBps',
  })) as bigint;
}

/** The protocol's share of the interest a lender earns, in basis points,
 *  under today's setting: each loan fixes the figure in force when it opens. */
export async function readTreasuryFeeBps(client: PublicClient, diamond: Hex): Promise<bigint> {
  return (await client.readContract({
    address: diamond,
    abi: CONFIG,
    functionName: 'getTreasuryFeeBps',
  })) as bigint;
}

/** The share of an initiation fee paid to whoever submits the acceptance
 *  or match, in basis points of the fee. */
export async function readLifMatcherBps(client: PublicClient, diamond: Hex): Promise<bigint> {
  return (await client.readContract({
    address: diamond,
    abi: CONFIG,
    functionName: 'getLifMatcherFeeBps',
  })) as bigint;
}

export async function readVault(client: PublicClient, diamond: Hex, account: Hex, b?: AtBlock): Promise<Hex> {
  return (await client.readContract({
    address: diamond,
    abi: VAULT_FACTORY,
    functionName: 'getUserVaultAddress',
    args: [account],
    ...at(b),
  })) as Hex;
}

export interface WalletFunds {
  balance: bigint;
  allowance: bigint;
}

/** The wallet's balance of `token` and what it lets the protocol pull. */
/** Whether the token would accept `approve(spender, amount)` from `owner`
 *  now: a dry run, so a token that refuses a non-zero to non-zero change is
 *  found out before the wallet is asked. A dry run that cannot be answered
 *  counts as a refusal, which costs one extra prompt and never a failure. */
export async function tokenAcceptsApproval(client: PublicClient, token: Hex, owner: Hex, spender: Hex, amount: bigint): Promise<boolean> {
  return client.simulateContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount], account: owner }).then(
    () => true,
    () => false,
  );
}

export async function readWalletFunds(client: PublicClient, token: Hex, owner: Hex, spender: Hex): Promise<WalletFunds> {
  const [balance, allowance] = await Promise.all([
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    }),
  ]);
  return { balance, allowance };
}

/** One page of the protocol's pair index: the open offer ids for
 *  (lendingAsset, collateralAsset), with how many the index holds. */
export async function readPairOfferIds(client: PublicClient, diamond: Hex, lendingAsset: Hex, collateralAsset: Hex, limit: number): Promise<{ ids: bigint[]; total: bigint }> {
  const [rankings, total] = (await client.readContract({
    address: diamond,
    abi: METRICS,
    functionName: 'getActiveOffersByAssetPairRanked',
    args: [lendingAsset, collateralAsset, 0n, BigInt(limit)],
  })) as readonly [readonly Raw[], bigint];
  return { ids: rankings.map((r) => r.id as bigint), total };
}
