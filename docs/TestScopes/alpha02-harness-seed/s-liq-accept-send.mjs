// Create an ACTIVE liquid loan on-chain (bypassing the stalled indexer's
// offer book) so the UI position page + repay/refi/liquidation flows can
// be reviewed. Borrower approves tLIQ→Diamond, ensures a vault, signs
// AcceptTerms exactly like the app, and SENDS acceptOffer for offer 15.
import { clientsFor, addressOf } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';
import { keccak256, encodeAbiParameters, parseAbiItem, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

const WALLETS = JSON.parse(fs.readFileSync('../testnet-wallets/wallets.json', 'utf8'));
const account = privateKeyToAccount(WALLETS.borrower.privateKey);
const { pub, wallet } = clientsFor(84532);
const w = wallet('borrower');
const tLIQ = '0x9d2a1acF65Ed12716Ca67Beb7D108890ccDa49f8';
const offerId = BigInt(process.env.OFFER_ID ?? '15');
const log = (...a) => console.log('[accept]', ...a);

const o = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOffer', args: [offerId] });
log('offer', offerId.toString(), 'collateralAsset', o.collateralAsset, 'collateralAmount', o.collateralAmount.toString(), 'accepted', o.accepted);
if (o.collateralAsset.toLowerCase() !== tLIQ.toLowerCase()) log('WARN: offer collateral is not tLIQ');

// 1. approve tLIQ -> diamond
const erc20 = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const allow = await pub.readContract({ address: tLIQ, abi: erc20, functionName: 'allowance', args: [account.address, DIAMOND] });
if (allow < o.collateralAmount) {
  const h = await w.writeContract({ address: tLIQ, abi: erc20, functionName: 'approve', args: [DIAMOND, maxUint256] });
  await pub.waitForTransactionReceipt({ hash: h });
  log('approved tLIQ -> diamond', h);
} else log('tLIQ already approved');

// 2. ensure vault
const vault = await pub.readContract({ address: DIAMOND, abi: abiOf('VaultFactoryFacet'), functionName: 'getUserVaultAddress', args: [account.address] }).catch(() => '0x0');
if (!vault || vault === '0x0000000000000000000000000000000000000000') {
  const h = await w.writeContract({ address: DIAMOND, abi: abiOf('VaultFactoryFacet'), functionName: 'getOrCreateUserVault', args: [account.address] });
  await pub.waitForTransactionReceipt({ hash: h });
  log('created vault', h);
} else log('vault exists', vault);

// 3. build + sign AcceptTerms (mirror useAcceptTerms.ts)
const block = await pub.getBlock({ blockTag: 'latest' });
const linkedLoanId = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOfferLinkedLoanId', args: [offerId] });
let riskTermsHash = '0x' + '0'.repeat(64);
try { riskTermsHash = await pub.readContract({ address: DIAMOND, abi: abiOf('RiskAccessFacet'), functionName: 'getCurrentRiskTermsHash' }); } catch {}
const isERC20 = Number(o.assetType) === 0, isLender = Number(o.offerType) === 0;
const terms = {
  acceptor: account.address, offerCreator: o.creator,
  offerKey: keccak256(encodeAbiParameters([{ type: 'uint256' }], [offerId])),
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
  { name: 'acceptor', type: 'address' }, { name: 'offerCreator', type: 'address' }, { name: 'offerKey', type: 'bytes32' },
  { name: 'offerType', type: 'uint8' }, { name: 'lendingAsset', type: 'address' }, { name: 'collateralAsset', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'collateralAmount', type: 'uint256' }, { name: 'interestRateBps', type: 'uint256' },
  { name: 'durationDays', type: 'uint256' }, { name: 'tokenId', type: 'uint256' }, { name: 'collateralTokenId', type: 'uint256' },
  { name: 'quantity', type: 'uint256' }, { name: 'collateralQuantity', type: 'uint256' }, { name: 'assetType', type: 'uint8' },
  { name: 'collateralAssetType', type: 'uint8' }, { name: 'prepayAsset', type: 'address' }, { name: 'useFullTermInterest', type: 'bool' },
  { name: 'allowsPartialRepay', type: 'bool' }, { name: 'allowsPrepayListing', type: 'bool' }, { name: 'allowsParallelSale', type: 'bool' },
  { name: 'refinanceTargetLoanId', type: 'uint256' }, { name: 'linkedLoanId', type: 'uint256' }, { name: 'parallelSaleOrderHash', type: 'bytes32' },
  { name: 'periodicInterestCadence', type: 'uint8' }, { name: 'riskAndTermsConsent', type: 'bool' },
  { name: 'acknowledgedIlliquidLendingAsset', type: 'address' }, { name: 'acknowledgedIlliquidCollateralAsset', type: 'address' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'riskTermsHash', type: 'bytes32' },
] };
const signature = await account.signTypedData({ domain: { name: 'Vaipakam AcceptOffer', version: '1', chainId: 84532, verifyingContract: DIAMOND }, types, primaryType: 'AcceptTerms', message: terms });

// 4. send acceptOffer
try {
  const sim = await pub.simulateContract({ address: DIAMOND, abi: abiOf('OfferAcceptFacet'), functionName: 'acceptOffer', args: [offerId, terms, signature], account: account.address });
  log('sim OK, loanId would be', sim.result);
  // Sign LOCALLY (w is bound to the borrower's private-key account) —
  // pass args directly, not sim.request (whose address-only account
  // makes viem fall back to eth_sendTransaction).
  const h = await w.writeContract({ address: DIAMOND, abi: abiOf('OfferAcceptFacet'), functionName: 'acceptOffer', args: [offerId, terms, signature], account, chain: w.chain });
  const rcpt = await pub.waitForTransactionReceipt({ hash: h });
  log('acceptOffer mined', h, 'status', rcpt.status);
  // find LoanInitiated / loanId
  const logs = await pub.getLogs({ address: DIAMOND, fromBlock: rcpt.blockNumber, toBlock: rcpt.blockNumber });
  fs.writeFileSync('state-liq-loan.json', JSON.stringify({ offerId: offerId.toString(), loanId: sim.result?.toString?.() ?? null, tx: h }));
  log('LOAN CREATED. loanId=', sim.result?.toString?.());
} catch (e) {
  log('ACCEPT FAILED:', e.shortMessage?.split('\n')[0] ?? e.message);
}
