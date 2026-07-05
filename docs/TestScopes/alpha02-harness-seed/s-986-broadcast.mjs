// Full E2E: broadcast the buyer accept of sale offer #21 and verify the
// lender handoff on loan #11.
import './proxy-setup.mjs';
import { clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';
import { keccak256, encodeAbiParameters, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

const W = JSON.parse(fs.readFileSync('../testnet-wallets/wallets.json', 'utf8'));
const buyer = privateKeyToAccount(W.newLender.privateKey);
const { pub, wallet } = clientsFor(84532);
const SALE_OFFER_ID = 21n, LOAN_ID = 11n;
const WETH = '0x4200000000000000000000000000000000000006';
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

const sellerWethBefore = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [W.lender.address] });
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
  nonce: BigInt(Date.now()) * 1000n + 311n, deadline: block.timestamp + 1800n, riskTermsHash,
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

const { request } = await pub.simulateContract({
  address: DIAMOND, abi: abiOf('OfferAcceptFacet'), functionName: 'acceptOffer',
  args: [SALE_OFFER_ID, terms, signature], account: buyer,
});
const hash = await wallet('newLender').writeContract(request);
const rc = await pub.waitForTransactionReceipt({ hash });
console.log('ACCEPT BROADCAST:', hash, rc.status, '| gas used:', rc.gasUsed);

// verify handoff (retry a few times for RPC lag)
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const loan = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [LOAN_ID] });
  const sellerWethAfter = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [W.lender.address] });
  if (loan.lender.toLowerCase() === buyer.address.toLowerCase()) {
    console.log('VERIFIED: loan #11 lender is now the buyer (newLender)', loan.lender);
    console.log('loan status still Active:', loan.status === 0 || Number(loan.status) === 0);
    console.log('seller WETH delta:', sellerWethAfter - sellerWethBefore, '(sale principal 5000000000000000 minus accrued forfeit)');
    process.exit(0);
  }
  console.log(`  not yet reflected (attempt ${i + 1}) — lender still`, loan.lender);
}
console.log('handoff not observed after retries — check manually');
