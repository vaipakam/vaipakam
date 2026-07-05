// Accept-side sim for sale offer #21 (loan #11). Listing already live.
import './proxy-setup.mjs';
import { clientsFor } from './driver.mjs';
import { DIAMOND, DIAMOND_ABI } from './verify.mjs';
import { keccak256, encodeAbiParameters, decodeErrorResult, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

import { abiOf } from './verify.mjs'; const oldAbi = abiOf;
const W = JSON.parse(fs.readFileSync('../testnet-wallets/wallets.json', 'utf8'));
const buyer = privateKeyToAccount(W.newLender.privateKey);
const { pub, wallet } = clientsFor(84532);
const SALE_OFFER_ID = 21n, LOAN_ID = 11n;

const o = await pub.readContract({ address: DIAMOND, abi: oldAbi('OfferCancelFacet'), functionName: 'getOffer', args: [SALE_OFFER_ID] });

// buyer funding: principal is WETH — wrap if short, then approve
const weth = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function deposit() payable',
]);
const bal = await pub.readContract({ address: o.lendingAsset, abi: weth, functionName: 'balanceOf', args: [buyer.address] });
console.log('buyer WETH balance:', bal, '| needed:', o.amount);
if (bal < o.amount) {
  const h = await wallet('newLender').writeContract({ address: o.lendingAsset, abi: weth, functionName: 'deposit', value: o.amount * 2n });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('wrapped ETH -> WETH');
}
const allo = await pub.readContract({ address: o.lendingAsset, abi: weth, functionName: 'allowance', args: [buyer.address, DIAMOND] });
if (allo < o.amount) {
  const h = await wallet('newLender').writeContract({ address: o.lendingAsset, abi: weth, functionName: 'approve', args: [DIAMOND, o.amount * 10n] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('approved diamond for WETH');
}

const block = await pub.getBlock({ blockTag: 'latest' });
const linkedLoanId = await pub.readContract({ address: DIAMOND, abi: oldAbi('OfferCancelFacet'), functionName: 'getOfferLinkedLoanId', args: [SALE_OFFER_ID] });
let riskTermsHash = '0x' + '0'.repeat(64);
try { riskTermsHash = await pub.readContract({ address: DIAMOND, abi: oldAbi('RiskAccessFacet'), functionName: 'getCurrentRiskTermsHash' }); } catch {}
console.log('linkedLoanId:', linkedLoanId);

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
  nonce: BigInt(Date.now()) * 1000n + 99n, deadline: block.timestamp + 1800n, riskTermsHash,
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

try {
  const res = await pub.simulateContract({
    address: DIAMOND, abi: oldAbi('OfferAcceptFacet'), functionName: 'acceptOffer',
    args: [SALE_OFFER_ID, terms, signature], account: buyer.address,
  });
  console.log('ACCEPT SIMULATION SUCCEEDS - temp loanId:', res.result);
  fs.writeFileSync('state-986-accept.json', JSON.stringify({ saleOfferId: '21', loanId: '11', simOk: true }));
} catch (e) {
  console.log('SIM REVERT:', e.shortMessage?.split('\n')[0]);
  let raw = e.cause?.data ?? e.walk?.((x) => x?.data !== undefined)?.data;
  if (typeof raw === 'object') raw = raw?.data;
  if (typeof raw === 'string' && raw.length >= 10) {
    try { const dec = decodeErrorResult({ abi: DIAMOND_ABI, data: raw });
      console.log('DECODED:', dec.errorName, JSON.stringify(dec.args, (k, v) => typeof v === 'bigint' ? String(v) : v));
    } catch { console.log('selector', raw.slice(0, 10)); }
  }
}
