/**
 * Offer / accept / accounting helpers shared by every scenario.
 *
 * Two things here are load-bearing and easy to get wrong by hand:
 *
 *  - The EIP-712 `AcceptTerms` struct is 34 fields and the ACCEPTOR signs it.
 *    Its `offerKey` is `keccak256(abi.encode(uint256 offerId))` on a direct
 *    accept — a zero key is accepted by the encoder and then refused on-chain
 *    as `OfferTermsMismatch(1)`, which reads like a terms bug rather than a
 *    missing key.
 *  - Expiries and deadlines are taken from the CHAIN's block timestamp, not
 *    from wall-clock time. Scenarios warp the fork weeks forward to reach the
 *    default path, after which a wall-clock expiry is already in the past and
 *    every later offer dies on `OfferExpiryInPast`.
 */
import { keccak256, encodeAbiParameters } from 'viem';
import {
  DIAMOND,
  ERC20,
  MOCKS,
  abi,
  chainNow,
  f18,
  forkChain,
  parseUnits,
  pub,
  tx,
  walletFor,
} from './chain.mjs';
import { simulate } from './errors.mjs';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const BYTES32_ZERO = `0x${'0'.repeat(64)}`;

export const ABIS = {
  offerCreate: abi('OfferCreateFacet'),
  offerAccept: abi('OfferAcceptFacet'),
  loan: abi('LoanFacet'),
  metrics: abi('MetricsFacet'),
  risk: abi('RiskFacet'),
  repay: abi('RepayFacet'),
  vaultFactory: abi('VaultFactoryFacet'),
  claim: abi('ClaimFacet'),
  defaulted: abi('DefaultedFacet'),
  preclose: abi('PrecloseFacet'),
  earlyWithdrawal: abi('EarlyWithdrawalFacet'),
  profile: abi('ProfileFacet'),
  admin: abi('AdminFacet'),
  oracle: abi('OracleFacet'),
  nft: abi('VaipakamNFTFacet'),
  loupe: abi('DiamondLoupeFacet'),
};

export const read = (facetAbi, functionName, args = []) =>
  pub.readContract({ address: DIAMOND, abi: facetAbi, functionName, args });

export const balanceOf = (token, holder) =>
  pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [holder] });

export const mint = (account, token, whole) =>
  tx(account, { address: token, abi: ERC20, functionName: 'mint', args: [account.address, parseUnits(whole, 18)] }, 'mint');

export const approveDiamond = (account, token) =>
  tx(account, { address: token, abi: ERC20, functionName: 'approve', args: [DIAMOND, 2n ** 255n] }, 'approve');

/** A liquid/liquid lender offer with every range bound pinned to the point value. */
export async function offerParams(overrides = {}) {
  const now = await chainNow();
  const amount = overrides.amount ?? parseUnits('1000', 18);
  const collateralAmount = overrides.collateralAmount ?? parseUnits('1.25', 18);
  return {
    offerType: 0,
    lendingAsset: MOCKS.liquidToken2,
    amount,
    interestRateBps: 500n,
    collateralAsset: MOCKS.liquidToken,
    collateralAmount,
    durationDays: 7n,
    assetType: 0,
    tokenId: 0n,
    quantity: 0n,
    creatorRiskAndTermsConsent: true,
    prepayAsset: MOCKS.liquidToken2,
    collateralAssetType: 0,
    collateralTokenId: 0n,
    collateralQuantity: 0n,
    allowsPartialRepay: false,
    amountMax: amount,
    interestRateBpsMax: overrides.interestRateBps ?? 500n,
    collateralAmountMax: collateralAmount,
    periodicInterestCadence: 0,
    expiresAt: BigInt(now + 7 * 86_400),
    fillMode: 0,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    refinanceTargetLoanId: 0n,
    useFullTermInterest: true,
    ...overrides,
  };
}

export async function createOffer(creator, overrides = {}) {
  const offer = await offerParams(overrides);
  const sim = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer', [offer], creator.address);
  if (!sim.ok) throw new Error(`createOffer would revert: ${sim.name}`);
  const receipt = await tx(creator, { address: DIAMOND, abi: ABIS.offerCreate, functionName: 'createOffer', args: [offer] }, 'createOffer');
  return { offerId: BigInt(sim.result), offer, gas: receipt.gasUsed };
}

const ACCEPT_TERMS_FIELDS = [
  ['acceptor', 'address'], ['offerCreator', 'address'], ['offerKey', 'bytes32'], ['offerType', 'uint8'],
  ['lendingAsset', 'address'], ['collateralAsset', 'address'], ['amount', 'uint256'], ['collateralAmount', 'uint256'],
  ['interestRateBps', 'uint256'], ['durationDays', 'uint256'], ['tokenId', 'uint256'], ['collateralTokenId', 'uint256'],
  ['quantity', 'uint256'], ['collateralQuantity', 'uint256'], ['assetType', 'uint8'], ['collateralAssetType', 'uint8'],
  ['prepayAsset', 'address'], ['useFullTermInterest', 'bool'], ['allowsPartialRepay', 'bool'],
  ['allowsPrepayListing', 'bool'], ['allowsParallelSale', 'bool'], ['refinanceTargetLoanId', 'uint256'],
  ['linkedLoanId', 'uint256'], ['parallelSaleOrderHash', 'bytes32'], ['periodicInterestCadence', 'uint8'],
  ['riskAndTermsConsent', 'bool'], ['acknowledgedIlliquidLendingAsset', 'address'],
  ['acknowledgedIlliquidCollateralAsset', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'],
  ['riskTermsHash', 'bytes32'], ['acceptorFull', 'bool'], ['acceptorMaxCStar', 'uint256'],
  ['acceptorAllowFullDowngrade', 'bool'],
].map(([name, type]) => ({ name, type }));

const TYPES = { AcceptTerms: ACCEPT_TERMS_FIELDS };

export async function acceptTerms(offerId, offer, acceptor, creator, overrides = {}) {
  const now = await chainNow();
  return {
    acceptor: acceptor.address,
    offerCreator: creator.address,
    offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [offerId])),
    offerType: offer.offerType,
    lendingAsset: offer.lendingAsset,
    collateralAsset: offer.collateralAsset,
    amount: offer.amount,
    collateralAmount: offer.collateralAmount,
    interestRateBps: offer.interestRateBps,
    durationDays: offer.durationDays,
    tokenId: offer.tokenId,
    collateralTokenId: offer.collateralTokenId,
    quantity: offer.quantity,
    collateralQuantity: offer.collateralQuantity,
    assetType: offer.assetType,
    collateralAssetType: offer.collateralAssetType,
    prepayAsset: offer.prepayAsset,
    useFullTermInterest: offer.useFullTermInterest,
    allowsPartialRepay: offer.allowsPartialRepay,
    allowsPrepayListing: offer.allowsPrepayListing,
    allowsParallelSale: offer.allowsParallelSale,
    refinanceTargetLoanId: offer.refinanceTargetLoanId,
    linkedLoanId: 0n,
    parallelSaleOrderHash: BYTES32_ZERO,
    periodicInterestCadence: offer.periodicInterestCadence,
    riskAndTermsConsent: true,
    acknowledgedIlliquidLendingAsset: ZERO,
    acknowledgedIlliquidCollateralAsset: ZERO,
    // The nonce is a per-acceptor one-shot ledger (`AcceptNonceUsed`), not a
    // counter — any never-before-used value is valid.
    nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
    deadline: BigInt(now + 3600),
    riskTermsHash: BYTES32_ZERO,
    acceptorFull: false,
    acceptorMaxCStar: 0n,
    acceptorAllowFullDowngrade: false,
    ...overrides,
  };
}

export async function acceptOffer(offerId, offer, acceptor, creator, overrides = {}) {
  const terms = await acceptTerms(offerId, offer, acceptor, creator, overrides);
  const signature = await walletFor(acceptor).signTypedData({
    domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: forkChain.id, verifyingContract: DIAMOND },
    types: TYPES,
    primaryType: 'AcceptTerms',
    message: terms,
  });
  const sim = await simulate(DIAMOND, ABIS.offerAccept, 'acceptOffer', [offerId, terms, signature], acceptor.address);
  if (!sim.ok) return { ok: false, reason: sim.name };
  const receipt = await tx(
    acceptor,
    { address: DIAMOND, abi: ABIS.offerAccept, functionName: 'acceptOffer', args: [offerId, terms, signature] },
    'acceptOffer',
  );
  return { ok: true, gas: receipt.gasUsed, receipt };
}

/**
 * Seed both roles, create a lender offer and accept it.
 * Returns `{ loanId, offerId, offer }`.
 */
export async function openLoan({ lender, borrower, ...overrides } = {}) {
  const { liquidToken: collateral, liquidToken2: lending } = MOCKS;
  await mint(lender, lending, '100000');
  await approveDiamond(lender, lending);
  await mint(borrower, collateral, '100000');
  await approveDiamond(borrower, collateral);
  await mint(borrower, lending, '100000');
  await approveDiamond(borrower, lending);
  const { offerId, offer } = await createOffer(lender, overrides);
  const accepted = await acceptOffer(offerId, offer, borrower, lender);
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.reason}`);
  const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
  return { loanId: active[active.length - 1], offerId, offer, gas: accepted.gas };
}

/** Snapshot every (token, holder) balance so a scenario can account a flow to the wei. */
export async function snapshot(tokens, holders) {
  const out = {};
  for (const [tokenName, token] of Object.entries(tokens)) {
    for (const [holderName, holder] of Object.entries(holders)) {
      if (!holder) continue;
      out[`${tokenName}.${holderName}`] = await balanceOf(token, holder);
    }
  }
  return out;
}

/** Non-zero deltas between two snapshots, formatted at 18 decimals. */
export function delta(before, after) {
  const out = {};
  for (const key of Object.keys(after)) {
    const d = after[key] - (before[key] ?? 0n);
    if (d !== 0n) out[key] = f18(d);
  }
  return out;
}
