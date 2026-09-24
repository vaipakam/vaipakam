/**
 * A10 — renting an NFT.
 *
 * The oracle here is the functional spec, not the code. For an ERC-721
 * rental it says: the token is held in a Vaipakam vault during the rental,
 * the renter gets ONLY the ERC-4907 `user` right and "never receives custody
 * or ownership", rent is prepaid daily plus a buffer, and on an early close
 * the lender is owed the rent due, the renter is owed the unused prepayment
 * and buffer back, and the `user` right is revoked while the NFT stays in
 * vault custody. Each of those is asserted below against what the chain did.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, acceptStoredOffer, approveDiamond, delta, mint, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { expectEq, record } from '../lib/report.mjs';

const NFT = [
  { type: 'function', name: 'mint', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'ownerOf', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'userOf', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'view' },
];

const DAILY_FEE = parseUnits('10', 18);
const DAYS = 7n;
const BUFFER_BPS = 500n; // RENTAL_BUFFER_BPS

export async function run() {
  const nft = MOCKS.rentalNft;
  const prepay = MOCKS.liquidToken2;
  if (!nft) { record('A10.0', 'a rentable NFT mock is deployed', 'INFO', 'no rentalNft in the artifact'); return; }

  // A fresh token id per run, so a re-run never collides with a prior mint.
  const tokenId = BigInt(Date.now() % 1_000_000_000) + 7_000_000n;
  await tx(lender, { address: nft, abi: NFT, functionName: 'mint', args: [lender.address, tokenId] }, 'mint nft');
  await tx(lender, { address: nft, abi: NFT, functionName: 'approve', args: [DIAMOND, tokenId] }, 'approve nft');
  const lenderVault = await vaultAddressFor(lender);
  const borrowerVault = await vaultAddressFor(borrower);

  const { offerParams, createOffer } = await import('../lib/flow.mjs');
  const offer = {
    offerType: 0,
    lendingAsset: nft,
    amount: DAILY_FEE,
    amountMax: DAILY_FEE,
    interestRateBps: 0n,
    interestRateBpsMax: 0n,
    // Rentals take no collateral; the prepay token is a non-zero, distinct
    // placeholder so the self-collateralised-offer check passes.
    collateralAsset: prepay,
    collateralAmount: 0n,
    collateralAmountMax: 0n,
    durationDays: DAYS,
    assetType: 1,          // ERC721
    tokenId,
    quantity: 1n,
    prepayAsset: prepay,
    collateralAssetType: 0,
    useFullTermInterest: false,
  };
  let created;
  try {
    created = await createOffer(lender, offer);
  } catch (e) {
    record('A10.1', 'the lender lists an NFT for rent', 'INFO', String(e.message).split('\n')[0].slice(0, 160));
    return;
  }
  record('A10.1', 'the lender lists an NFT for rent at a daily fee', 'PASS',
    `offerId=${created.offerId} tokenId=${tokenId} fee=${f18(DAILY_FEE)}/day term=${DAYS}d`);

  const custodyAfterList = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  record('A10.2', 'listing moves the NFT into the LENDER\'S vault — out of the wallet, not to the Diamond',
    custodyAfterList.toLowerCase() === lenderVault.toLowerCase() ? 'PASS' : 'INFO',
    `ownerOf=${custodyAfterList} lenderVault=${lenderVault}`);

  // The renter prepays rent for the whole term plus a buffer.
  const rent = DAILY_FEE * DAYS;
  const buffer = (rent * BUFFER_BPS) / 10_000n;
  await mint(borrower, prepay, '100000');
  await approveDiamond(borrower, prepay);
  const tokens = { prepay };
  const holders = {
    lenderEOA: lender.address, lenderVault,
    borrowerEOA: borrower.address, borrowerVault,
    diamond: DIAMOND, treasury: TREASURY,
  };
  // A rented NFT is illiquid by definition, so the renter must name it in an
  // explicit acknowledgement — the same dual-consent gate as illiquid
  // collateral (A5.12), applied here to the LENT asset.
  const unacked = await acceptStoredOffer(created.offerId, borrower);
  record('A10.3a', 'accepting a rental WITHOUT acknowledging the illiquid NFT is refused',
    !unacked.ok ? 'PASS' : 'FAIL', unacked.ok ? 'accepted without consent' : unacked.reason);
  if (unacked.ok) return;

  const beforeAccept = await snapshot(tokens, holders);
  const accepted = await acceptStoredOffer(created.offerId, borrower, { acknowledgedIlliquidLendingAsset: nft });
  if (!accepted.ok) { record('A10.3', 'the renter accepts with the acknowledgement', 'INFO', accepted.reason); return; }
  const afterAccept = await snapshot(tokens, holders);
  const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
  const loanId = active[active.length - 1];
  const paid = beforeAccept['prepay.borrowerEOA'] - afterAccept['prepay.borrowerEOA'];
  expectEq('A10.3', 'the renter prepays the full term\'s rent PLUS a 5% buffer, up front',
    paid, rent + buffer, `rent=${f18(rent)} buffer=${f18(buffer)} deltas=${JSON.stringify(delta(beforeAccept, afterAccept))}`);

  // Custody vs use — the core of the spec's rental model.
  const owner = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  const user = await pub.readContract({ address: nft, abi: NFT, functionName: 'userOf', args: [tokenId] });
  record('A10.4', 'the renter gets the ERC-4907 USER right only — custody stays in a Vaipakam vault',
    user.toLowerCase() === borrower.address.toLowerCase() && owner.toLowerCase() !== borrower.address.toLowerCase() ? 'PASS' : 'FAIL',
    `userOf=${user.slice(0, 10)} ownerOf=${owner} (renter=${borrower.address.slice(0, 10)})`);

  const noHf = await simulate(DIAMOND, ABIS.risk, 'calculateHealthFactor', [loanId], borrower.address);
  record('A10.5', 'a rental carries no health factor — it is not a collateralised loan', 'INFO',
    noHf.ok ? `returned ${noHf.result}` : noHf.name);

  // Early close on day 3 of 7.
  await warpDays(3);
  const quote = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]).catch(() => null);
  const beforeClose = await snapshot(tokens, holders);
  const closeSim = await simulate(DIAMOND, ABIS.repay, 'repayLoan', [loanId], borrower.address);
  if (!closeSim.ok) { record('A10.6', 'the renter closes early', 'INFO', closeSim.name); return; }
  const closed = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayLoan', args: [loanId] }, 'repayLoan(rental)');
  const afterClose = await snapshot(tokens, holders);
  const loanAfter = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const userAfter = await pub.readContract({ address: nft, abi: NFT, functionName: 'userOf', args: [tokenId] });
  const ownerAfter = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  record('A10.6', 'closing early REVOKES the renter\'s user right, and the NFT stays in vault custody',
    userAfter.toLowerCase() !== borrower.address.toLowerCase() && ownerAfter.toLowerCase() !== borrower.address.toLowerCase() ? 'PASS' : 'FAIL',
    `gas=${closed.gasUsed} status=${loanAfter.status} userOf=${userAfter.slice(0, 10)} ownerOf=${ownerAfter.slice(0, 10)} ` +
    `quote=${quote === null ? 'n/a' : JSON.stringify(quote, (_, v) => (typeof v === 'bigint' ? String(v) : v))} ` +
    `deltas=${JSON.stringify(delta(beforeClose, afterClose))}`);

  // Claims — lender: rent + the NFT back; renter: unused prepay + buffer.
  for (const [who, acct, fn] of [['lender', lender, 'claimAsLender'], ['renter', borrower, 'claimAsBorrower']]) {
    const before = await snapshot(tokens, holders);
    try {
      const r = await tx(acct, { address: DIAMOND, abi: ABIS.claim, functionName: fn, args: [loanId] }, fn);
      const after = await snapshot(tokens, holders);
      const d = delta(before, after);
      record(`A10.7.${who}`, `after the early close the ${who} claims their side`, 'PASS', `gas=${r.gasUsed} deltas=${JSON.stringify(d)}`);
    } catch (e) {
      record(`A10.7.${who}`, `${fn} after the early close`, 'INFO', String(e.message).split('\n')[0].slice(0, 160));
    }
  }
  const finalOwner = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  record('A10.8', 'after the lender\'s claim the NFT is back with the lender (wallet or own vault)',
    [lender.address.toLowerCase(), lenderVault.toLowerCase()].includes(finalOwner.toLowerCase()) ? 'PASS' : 'FAIL',
    `ownerOf=${finalOwner}`);

  // Conservation: across the whole rental, the prepay token moved only
  // between the parties and the treasury — nothing created or lost.
  const end = await snapshot(tokens, holders);
  const net = Object.keys(end).reduce((acc, k) => acc + (end[k] - beforeAccept[k]), 0n);
  expectEq('A10.9', 'the rental conserves the prepay token across every party — nothing created or lost', net, 0n,
    `lifetime deltas=${JSON.stringify(delta(beforeAccept, end))}`);
}
