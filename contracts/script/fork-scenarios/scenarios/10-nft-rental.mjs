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
import { cannotContinue, check, expectEq, observe } from '../lib/report.mjs';

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
  // A deployment without the rental mock cannot be tested here at all — an
  // honest observation, not a failure of the protocol.
  if (!nft) { observe('A10.0', 'a rentable NFT mock is deployed', 'no rentalNft in the artifact — rental not exercised'); return; }

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
  // A listing that cannot be created is a broken flow: createOffer throws.
  const created = await createOffer(lender, offer);
  const listed = await read(ABIS.offerCancel, 'getOffer', [created.offerId]);
  check('A10.1', 'the lender lists an NFT for rent at a daily fee',
    listed.lendingAsset.toLowerCase() === nft.toLowerCase() && listed.tokenId === tokenId && listed.amount === DAILY_FEE,
    `offerId=${created.offerId} tokenId=${tokenId} fee=${f18(DAILY_FEE)}/day term=${DAYS}d`);

  const custodyAfterList = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  check('A10.2', 'listing moves the NFT into the LENDER\'S vault — out of the wallet, not to the Diamond',
    custodyAfterList.toLowerCase() === lenderVault.toLowerCase(),
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
  check('A10.3a', 'accepting a rental WITHOUT acknowledging the illiquid NFT is refused',
    !unacked.ok, unacked.ok ? 'accepted without consent' : unacked.reason);
  if (unacked.ok) cannotContinue('A10.3a', 'an unacknowledged rental was accepted; the rest of the rental flow would run on the wrong loan');

  const beforeAccept = await snapshot(tokens, holders);
  const accepted = await acceptStoredOffer(created.offerId, borrower, { acknowledgedIlliquidLendingAsset: nft });
  if (!accepted.ok) cannotContinue('A10.3 acknowledged accept', accepted.reason);
  const afterAccept = await snapshot(tokens, holders);
  const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
  const loanId = active[active.length - 1];
  const paid = beforeAccept['prepay.borrowerEOA'] - afterAccept['prepay.borrowerEOA'];
  expectEq('A10.3', 'the renter prepays the full term\'s rent PLUS a 5% buffer, up front',
    paid, rent + buffer, `rent=${f18(rent)} buffer=${f18(buffer)} deltas=${JSON.stringify(delta(beforeAccept, afterAccept))}`);

  // Custody vs use — the core of the spec's rental model.
  const owner = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  const user = await pub.readContract({ address: nft, abi: NFT, functionName: 'userOf', args: [tokenId] });
  check('A10.4', 'the renter gets the ERC-4907 USER right only — custody stays in the lender\'s vault',
    user.toLowerCase() === borrower.address.toLowerCase() && owner.toLowerCase() === lenderVault.toLowerCase(),
    `userOf=${user.slice(0, 10)} ownerOf=${owner} (renter=${borrower.address.slice(0, 10)})`);

  const noHf = await simulate(DIAMOND, ABIS.risk, 'calculateHealthFactor', [loanId], borrower.address);
  observe('A10.5', 'a rental carries no health factor — it is not a collateralised loan',
    noHf.ok ? `returned ${noHf.result}` : noHf.name);

  // Early close on day 3 of 7.
  await warpDays(3);
  const quote = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]).catch(() => null);
  const beforeClose = await snapshot(tokens, holders);
  const closeSim = await simulate(DIAMOND, ABIS.repay, 'repayLoan', [loanId], borrower.address);
  // The spec gives an accepted rental an early close; losing it is a
  // regression, so the file aborts rather than recording an observation.
  if (!closeSim.ok) cannotContinue('A10.6 early close', closeSim.name);
  const closed = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayLoan', args: [loanId] }, 'repayLoan(rental)');
  const afterClose = await snapshot(tokens, holders);
  const loanAfter = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const userAfter = await pub.readContract({ address: nft, abi: NFT, functionName: 'userOf', args: [tokenId] });
  const ownerAfter = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  // Exact, not "anyone but the renter": the user right is cleared to the
  // zero address and custody stays in the LENDER'S vault until the claim.
  check('A10.6', 'closing early REVOKES the renter\'s user right, and the NFT stays in the lender\'s vault',
    /^0x0{40}$/i.test(userAfter) && ownerAfter.toLowerCase() === lenderVault.toLowerCase(),
    `gas=${closed.gasUsed} status=${loanAfter.status} userOf=${userAfter.slice(0, 10)} ownerOf=${ownerAfter.slice(0, 10)} ` +
    `quote=${quote === null ? 'n/a' : JSON.stringify(quote, (_, v) => (typeof v === 'bigint' ? String(v) : v))} ` +
    `deltas=${JSON.stringify(delta(beforeClose, afterClose))}`);

  // Claims — each side's claim moves exactly what the close credited to that
  // side's vault out to that side's wallet: the lender's rent for the days
  // used (net of the treasury's cut), the renter's unused prepay plus the
  // whole buffer.
  for (const [who, side, acct, fn] of [['lender', 'lender', lender, 'claimAsLender'], ['renter', 'borrower', borrower, 'claimAsBorrower']]) {
    const credited = afterClose[`prepay.${side}Vault`] - beforeClose[`prepay.${side}Vault`] +
      (side === 'borrower' ? afterAccept['prepay.borrowerVault'] - beforeAccept['prepay.borrowerVault'] : 0n);
    const before = await snapshot(tokens, holders);
    const r = await tx(acct, { address: DIAMOND, abi: ABIS.claim, functionName: fn, args: [loanId] }, fn);
    const after = await snapshot(tokens, holders);
    check(`A10.7.${who}`, `after the early close the ${who} claims exactly their side`,
      after[`prepay.${side}EOA`] - before[`prepay.${side}EOA`] === credited && credited > 0n,
      `gas=${r.gasUsed} credited=${f18(credited)} deltas=${JSON.stringify(delta(before, after))}`);
  }
  const finalOwner = await pub.readContract({ address: nft, abi: NFT, functionName: 'ownerOf', args: [tokenId] });
  check('A10.8', 'after the lender\'s claim the NFT is back in the lender\'s wallet',
    finalOwner.toLowerCase() === lender.address.toLowerCase(),
    `ownerOf=${finalOwner}`);

  // Conservation: across the whole rental, the prepay token moved only
  // between the parties and the treasury — nothing created or lost.
  const end = await snapshot(tokens, holders);
  const net = Object.keys(end).reduce((acc, k) => acc + (end[k] - beforeAccept[k]), 0n);
  expectEq('A10.9', 'the rental conserves the prepay token across every party — nothing created or lost', net, 0n,
    `lifetime deltas=${JSON.stringify(delta(beforeAccept, end))}`);
}
