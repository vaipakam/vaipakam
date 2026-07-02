import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

const ACCEPT_DEADLINE_SECONDS = 30 * 60;
const ASSET_TYPE_ERC20 = 0;
const OFFER_TYPE_LENDER = 0;

const ACCEPT_TERMS_TYPES = {
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
  ],
} as const;

export interface AcceptTermsPayload {
  terms: Record<string, unknown>;
  signature: Hex;
}

export async function signAcceptTerms(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  diamondAddress: Address;
  chainId: number;
  offerId: bigint;
  consent: boolean;
}): Promise<AcceptTermsPayload> {
  const account = opts.walletClient.account;
  if (!account) throw new Error('Wallet has no account');

  const o = (await opts.publicClient.readContract({
    address: opts.diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOffer',
    args: [opts.offerId],
  })) as Record<string, unknown>;

  let linkedLoanId = 0n;
  try {
    linkedLoanId = (await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOfferLinkedLoanId',
      args: [opts.offerId],
    })) as bigint;
  } catch {
    linkedLoanId = 0n;
  }

  let riskTermsHash =
    '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;
  try {
    riskTermsHash = (await opts.publicClient.readContract({
      address: opts.diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getCurrentRiskTermsHash',
    })) as Hex;
  } catch {
    // Pre-gate deploys may lack the getter.
  }

  const isERC20 = Number(o.assetType) === ASSET_TYPE_ERC20;
  const isLender = Number(o.offerType) === OFFER_TYPE_LENDER;
  const roleAmount = isERC20
    ? isLender
      ? (o.amountMax as bigint)
      : (o.amount as bigint)
    : (o.amount as bigint);
  const roleRate = isERC20
    ? isLender
      ? (o.interestRateBps as bigint)
      : (o.interestRateBpsMax as bigint)
    : (o.interestRateBps as bigint);

  const nonce = BigInt(Date.now());
  const deadline = BigInt(Math.floor(Date.now() / 1000) + ACCEPT_DEADLINE_SECONDS);

  const terms = {
    acceptor: account.address,
    offerCreator: o.creator as Address,
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [opts.offerId])),
    offerType: Number(o.offerType),
    lendingAsset: o.lendingAsset as Address,
    collateralAsset: o.collateralAsset as Address,
    amount: roleAmount,
    collateralAmount: o.collateralAmount as bigint,
    interestRateBps: roleRate,
    durationDays: BigInt(o.durationDays as number),
    tokenId: o.tokenId as bigint,
    collateralTokenId: o.collateralTokenId as bigint,
    quantity: o.quantity as bigint,
    collateralQuantity: o.collateralQuantity as bigint,
    assetType: Number(o.assetType),
    collateralAssetType: Number(o.collateralAssetType),
    prepayAsset: o.prepayAsset as Address,
    useFullTermInterest: Boolean(o.useFullTermInterest),
    allowsPartialRepay: Boolean(o.allowsPartialRepay),
    allowsPrepayListing: Boolean(o.allowsPrepayListing),
    allowsParallelSale: Boolean(o.allowsParallelSale),
    refinanceTargetLoanId: (o.refinanceTargetLoanId as bigint) ?? 0n,
    linkedLoanId,
    parallelSaleOrderHash:
      ((o.parallelSaleOrderHash as Hex | undefined) ??
        '0x0000000000000000000000000000000000000000000000000000000000000000') as Hex,
    periodicInterestCadence: Number(o.periodicInterestCadence ?? 0),
    riskAndTermsConsent: opts.consent,
    acknowledgedIlliquidLendingAsset: o.lendingAsset as Address,
    acknowledgedIlliquidCollateralAsset: o.collateralAsset as Address,
    nonce,
    deadline,
    riskTermsHash,
  };

  const signature = await opts.walletClient.signTypedData({
    account,
    domain: {
      name: 'Vaipakam AcceptOffer',
      version: '1',
      chainId: BigInt(opts.chainId),
      verifyingContract: opts.diamondAddress,
    },
    types: ACCEPT_TERMS_TYPES,
    primaryType: 'AcceptTerms',
    message: terms,
  });

  return { terms, signature };
}