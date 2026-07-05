import './proxy-setup.mjs';
import { clientsFor } from './driver.mjs';
import { DIAMOND, DIAMOND_ABI, abiOf } from './verify.mjs';
import { keccak256, encodeAbiParameters, decodeErrorResult, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

const W = JSON.parse(fs.readFileSync('../testnet-wallets/wallets.json', 'utf8'));
const buyer = privateKeyToAccount(W.newLender.privateKey);
const { pub } = clientsFor(84532);
const SALE_OFFER_ID = 21n;

const o = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOffer', args: [SALE_OFFER_ID] });
const block = await pub.getBlock({ blockTag: 'latest' });
const linkedLoanId = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOfferLinkedLoanId', args: [SALE_OFFER_ID] });
let riskTermsHash = '0x' + '0'.repeat(64);
try { riskTermsHash = await pub.readContract({ address: DIAMOND, abi: abiOf('RiskAccessFacet'), functionName: 'getCurrentRiskTermsHash' }); } catch {}

const isERC20 = Number(o.assetType) === 0;
const isLender = Number(o.offerType) === 0;
const terms = {
  acceptor: buyer.address, offerCreator: o.creator,
  offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [SALE_OFFER_ID])),
  offerType: Number(o.offerType), lendingAsset: o.lendingAsset, collateralAsset: o.collateralAsset,
  amount: isERC20 ? (isLender ? o.amountMax : o.amount) : o.amount,
  collateralAmount: o.collateralAmount,
  interestRateBps: isERC20 ? (isLender ? o.interestRateBps : o.interestRateBpsMax) : o.interestRateBps,
  durationDays: o.durationDays, tokenId: o.tokenId, collateralTokenId: o.collateralTokenId,
  quantity: o.quantity, collateralQuantity: o.collateralQuantity,
  assetType: Number(o.assetType), collateralAssetType: Number(o.collateralAssetType),
  prepayAsset: o.prepayAsset, useFullTermInterest: Boolean(o.useFullTermInterest),
  allowsPartialRepay: Boolean(o.allowsPartialRepay), allowsPrepayListing: Boolean(o.allowsPrepayListing),
  allowsParallelSale: Boolean(o.allowsParallelSale), refinanceTargetLoanId: o.refinanceTargetLoanId,
  linkedLoanId, parallelSaleOrderHash: o.parallelSaleOrderHash,
  periodicInterestCadence: Number(o.periodicInterestCadence), riskAndTermsConsent: true,
  acknowledgedIlliquidLendingAsset: o.lendingAsset, acknowledgedIlliquidCollateralAsset: o.collateralAsset,
  nonce: BigInt(Date.now()) * 1000n + 7n, deadline: block.timestamp + 1800n, riskTermsHash,
};
const types = { AcceptTerms: [
  { name: 'acceptor', type: 'address' }, { name: 'offerCreator', type: 'address' },
  { name: 'offerKey', type: 'bytes32' }, { name: 'offerType', type: 'uint8' },
  { name: 'lendingAsset', type: 'address' }, { name: 'collateralAsset', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'collateralAmount', type: 'uint256' },
  { name: 'interestRateBps', type: 'uint256' }, { name: 'durationDays', type: 'uint256' },
  { name: 'tokenId', type: 'uint256' }, { name: 'collateralTokenId', type: 'uint256' },
  { name: 'quantity', type: 'uint256' }, { name: 'collateralQuantity', type: 'uint256' },
  { name: 'assetType', type: 'uint8' }, { name: 'collateralAssetType', type: 'uint8' },
  { name: 'prepayAsset', type: 'address' }, { name: 'useFullTermInterest', type: 'bool' },
  { name: 'allowsPartialRepay', type: 'bool' }, { name: 'allowsPrepayListing', type: 'bool' },
  { name: 'allowsParallelSale', type: 'bool' }, { name: 'refinanceTargetLoanId', type: 'uint256' },
  { name: 'linkedLoanId', type: 'uint256' }, { name: 'parallelSaleOrderHash', type: 'bytes32' },
  { name: 'periodicInterestCadence', type: 'uint8' }, { name: 'riskAndTermsConsent', type: 'bool' },
  { name: 'acknowledgedIlliquidLendingAsset', type: 'address' },
  { name: 'acknowledgedIlliquidCollateralAsset', type: 'address' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  { name: 'riskTermsHash', type: 'bytes32' },
]};
const signature = await buyer.signTypedData({
  domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: 84532, verifyingContract: DIAMOND },
  types, primaryType: 'AcceptTerms', message: terms,
});

const data = encodeFunctionData({ abi: abiOf('OfferAcceptFacet'), functionName: 'acceptOffer', args: [SALE_OFFER_ID, terms, signature] });
// raw eth_call to get revert bytes verbatim
try {
  const r = await pub.request({ method: 'eth_call', params: [{ from: buyer.address, to: DIAMOND, data, gas: '0x1C9C380' }, 'latest'] });
  console.log('CALL SUCCEEDED:', r);
} catch (e) {
  // viem RpcRequestError carries the revert bytes in e.cause.data or e.data
  const raw = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data;
  console.log('raw revert bytes:', typeof raw === 'object' ? JSON.stringify(raw) : raw);
  const hex = typeof raw === 'string' ? raw : raw?.data;
  if (typeof hex === 'string' && hex.startsWith('0x') && hex.length >= 10) {
    try {
      const dec = decodeErrorResult({ abi: DIAMOND_ABI, data: hex });
      console.log('DECODED REVERT:', dec.errorName, JSON.stringify(dec.args, (k, v) => typeof v === 'bigint' ? String(v) : v));
    } catch { console.log('selector not in barrel:', hex.slice(0, 10)); }
  } else {
    console.log('full error:', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 800));
  }
}
