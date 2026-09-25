/**
 * A2 — the ordinary life of a loan, accounted to the wei.
 *
 * Opens a liquid/liquid loan, then follows every unit of value from the
 * lender's wallet to the borrower's and back: escrow at offer creation, the
 * loan-initiation fee and its 99/1 treasury/matcher split at accept, the
 * interest and its 2% treasury cut at repay, and the collateral lien that a
 * repay leaves standing until the borrower claims.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, approveDiamond, createOffer, acceptOffer, delta, expectPosition, lifSplit, liveFees, mint, positionOf, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { cannotContinue, check, expectEq, expectLedger } from '../lib/report.mjs';

const PRINCIPAL = parseUnits('1000', 18);
const COLLATERAL = parseUnits('1.25', 18);

export async function run() {
  const lending = MOCKS.liquidToken2;   // priced $1.00 by the faucet feed
  const collateral = MOCKS.liquidToken; // priced $2,000

  await mint(lender, lending, '100000');
  await approveDiamond(lender, lending);
  await mint(borrower, collateral, '100000');
  await approveDiamond(borrower, collateral);
  await mint(borrower, lending, '100000');
  await approveDiamond(borrower, lending);

  const lenderVault = await vaultAddressFor(lender);
  const borrowerVault = await vaultAddressFor(borrower);
  const tokens = { lending, collateral };
  const holders = {
    lenderEOA: lender.address, lenderVault,
    borrowerEOA: borrower.address, borrowerVault,
    diamond: DIAMOND, treasury: TREASURY,
  };

  // --- offer creation escrows the principal
  const atStart = await snapshot(tokens, holders);
  const { offerId, offer } = await createOffer(lender, { amount: PRINCIPAL, collateralAmount: COLLATERAL });
  const afterCreate = await snapshot(tokens, holders);
  // Asserted, not merely printed: an unresolved vault address reads as a
  // zero balance, and a hard-coded PASS here is what let that slide through
  // to an accounting failure ten steps later.
  const escrowed = afterCreate['lending.lenderVault'] - atStart['lending.lenderVault'];
  const debited = atStart['lending.lenderEOA'] - afterCreate['lending.lenderEOA'];
  expectLedger('A2.1', 'creating a lender offer moves the principal into the LENDER\'S OWN vault, and nothing else moves',
    atStart, afterCreate, { 'lending.lenderEOA': -PRINCIPAL, 'lending.lenderVault': PRINCIPAL }, `offerId=${offerId}`);

  // --- accept: LIF + net delivery
  const accepted = await acceptOffer(offerId, offer, borrower, lender);
  if (!accepted.ok) cannotContinue('A2.2 accept', accepted.reason);
  const afterAccept = await snapshot(tokens, holders);
  const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
  const loanId = active[active.length - 1];
  const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  check('A2.2', 'accept initiates the loan and drains the escrow',
    afterCreate['lending.lenderVault'] - afterAccept['lending.lenderVault'] === PRINCIPAL && String(loan.status) === '0',
    `loanId=${loanId} gas=${accepted.gas} deltas=${JSON.stringify(delta(afterCreate, afterAccept))}`);

  // The stamps must equal the live governance configuration at the moment
  // the loan opened — that is what "stamped" means. The values themselves are
  // configuration (this deployment: 200 bps, 20 bps, 1.5), so every fee
  // figure below is derived FROM the stamps, never from today's defaults.
  const fees = await liveFees();
  const liveMinHf = await read(ABIS.risk, 'getMinHealthFactor');
  expectEq('A2.3', 'the treasury fee bps is STAMPED per loan, at the live configured value', loan.treasuryFeeBpsAtInit, fees.treasuryFeeBps);
  expectEq('A2.4', 'the loan-initiation fee bps is STAMPED per loan, at the live configured value', loan.loanInitiationFeeBpsAtInit, fees.lifBps);
  expectEq('A2.5', 'the minimum health factor is STAMPED per loan, at the live configured floor', loan.minHealthFactorAtInit, liveMinHf);

  const { lif, toMatcher, toTreasury: lifToTreasury } = lifSplit(PRINCIPAL, loan.loanInitiationFeeBpsAtInit, fees.matcherBps);
  const toTreasury = afterAccept['lending.treasury'] - afterCreate['lending.treasury'];
  expectEq('A2.6', 'the LIF is charged in the LENDING asset and, net of the matcher share, reaches the treasury',
    toTreasury, lifToTreasury, `LIF=${f18(lif)} at ${loan.loanInitiationFeeBpsAtInit}bps, matcher share ${fees.matcherBps}bps of it`);
  const toBorrower = afterAccept['lending.borrowerEOA'] - afterCreate['lending.borrowerEOA'];
  expectEq('A2.7', 'the borrower receives principal net of the LIF, in their WALLET not their vault',
    toBorrower, PRINCIPAL - lif + toMatcher, 'the borrower was the accept caller, so the matcher share returns to them');
  expectLedger('A2.7b', 'the accept moves exactly: escrow → borrower wallet net of the LIF, the LIF net of the matcher share to the treasury, the collateral into the borrower\'s own vault',
    afterCreate, afterAccept, {
      'lending.lenderVault': -PRINCIPAL,
      'lending.borrowerEOA': PRINCIPAL - lif + toMatcher,
      'lending.treasury': lifToTreasury,
      'collateral.borrowerEOA': -COLLATERAL,
      'collateral.borrowerVault': COLLATERAL,
    });

  const hf = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
  const ltv = await read(ABIS.risk, 'calculateLTV', [loanId]);
  // HF = collateral value × the loan's stamped liquidation LTV / debt, and
  // LTV = debt / collateral value, both from the live feeds (1e18-scaled
  // USD). Read in the accept's block-neighbourhood the debt is the principal.
  const [cP, cD] = await read(ABIS.oracle, 'getAssetPrice', [collateral]);
  const [pP, pD] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
  const colUsd = (COLLATERAL * cP) / 10n ** BigInt(cD);
  const debtUsd = (loan.principal * pP) / 10n ** BigInt(pD);
  const wantHf = (colUsd * BigInt(loan.liquidationLtvBpsAtInit) * 10n ** 18n) / (debtUsd * 10_000n);
  const wantLtv = (debtUsd * 10_000n) / colUsd;
  check('A2.8', 'health factor and LTV are computed from live oracle prices and the stamped liquidation LTV',
    hf === wantHf && ltv === wantLtv,
    `HF=${f18(hf)} want ${f18(wantHf)}; LTV=${ltv}bps want ${wantLtv} (collateral $${f18(colUsd)} at ${loan.liquidationLtvBpsAtInit}bps against $${f18(debtUsd)})`);

  // The opened position, which every later step is compared against in FULL.
  const opened = await positionOf(loanId);

  // --- repay
  const quoted = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]);
  const total = Array.isArray(quoted) ? quoted[0] : quoted;
  const interest = total - PRINCIPAL;
  expectEq('A2.9', 'the payoff quote is principal + simple interest over the full term',
    interest, (PRINCIPAL * BigInt(loan.interestRateBps) * BigInt(loan.durationDays)) / (365n * 10_000n), `total=${f18(total)}`);

  const beforeRepay = await snapshot(tokens, holders);
  const repayReceipt = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayLoan', args: [loanId] }, 'repayLoan');
  const afterRepay = await snapshot(tokens, holders);
  const treasuryCut = afterRepay['lending.treasury'] - beforeRepay['lending.treasury'];
  expectEq('A2.10', 'the treasury takes its stamped share of the INTEREST and nothing of the principal',
    treasuryCut, (interest * BigInt(loan.treasuryFeeBpsAtInit)) / 10_000n, `gas=${repayReceipt.gasUsed} at the stamped ${loan.treasuryFeeBpsAtInit}bps`);
  const lenderCredit = afterRepay['lending.lenderVault'] - beforeRepay['lending.lenderVault'];
  expectEq('A2.11', 'the lender is credited principal plus the interest net of the treasury\'s stamped share, into their vault',
    lenderCredit, PRINCIPAL + interest - treasuryCut);
  const interestCut = (interest * BigInt(loan.treasuryFeeBpsAtInit)) / 10_000n;
  expectLedger('A2.11b', 'the repay moves exactly: principal + interest from the borrower\'s wallet, the interest net of the treasury\'s stamped share and all the principal to the lender\'s vault, that share to the treasury — and no collateral',
    beforeRepay, afterRepay, {
      'lending.borrowerEOA': -(PRINCIPAL + interest),
      'lending.lenderVault': PRINCIPAL + interest - interestCut,
      'lending.treasury': interestCut,
    });

  const repaid = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  expectEq('A2.12', 'the loan terminalizes to Repaid', repaid.status, STATUS.Repaid);
  await expectPosition('A2.12b', 'the repay changes ONLY the status: both position NFTs, the recorded terms and the whole collateral lien are exactly as they were',
    loanId, opened, { status: STATUS.Repaid });
  const afterRepayPos = await positionOf(loanId);

  // --- the collateral lien outlives the repay
  // Every field, not just `released`: a standing lien with the wrong holder,
  // asset or amount would leave the collateral mis-encumbered while it awaits
  // the claim, and the claim's own record is separate from the lien.
  const lienAfterRepay = await read(ABIS.metrics, 'getLoanCollateralLien', [loanId]);
  const lienShape = (l) => `user=${l.user} asset=${l.asset} tokenId=${l.tokenId} amount=${l.amount} assetType=${l.assetType} released=${l.released}`;
  const wantLien = { user: borrower.address, asset: collateral, tokenId: 0n, amount: COLLATERAL, assetType: 0, released: false };
  expectEq('A2.13', 'a repay settles the MONEY but leaves the collateral lien standing, intact: the borrower\'s whole collateral, unreleased',
    lienShape({ ...lienAfterRepay, user: lienAfterRepay.user.toLowerCase(), asset: lienAfterRepay.asset.toLowerCase() }),
    lienShape({ ...wantLien, user: wantLien.user.toLowerCase(), asset: wantLien.asset.toLowerCase() }),
    'release is a separate, borrower-initiated claim');

  // --- position NFTs at terminalization, BEFORE the claim
  for (const [side, tokenId, holder] of [['lender', repaid.lenderTokenId, lender.address], ['borrower', repaid.borrowerTokenId, borrower.address]]) {
    let owner = null; let why = '';
    try { owner = await pub.readContract({ address: DIAMOND, abi: ABIS.nft, functionName: 'ownerOf', args: [tokenId] }); }
    catch (e) { why = String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 120); }
    check(`A2.14.${side}`, `at terminalization the ${side} position NFT still resolves, to its holder — status-updated, not burned`,
      owner !== null && owner.toLowerCase() === holder.toLowerCase(), owner ? `tokenId=${tokenId} owner=${owner}` : why);
  }

  const beforeClaim = await snapshot(tokens, holders);
  const claimReceipt = await tx(borrower, { address: DIAMOND, abi: ABIS.claim, functionName: 'claimAsBorrower', args: [loanId] }, 'claimAsBorrower');
  const afterClaim = await snapshot(tokens, holders);
  const lienAfterClaim = await read(ABIS.metrics, 'getLoanCollateralLien', [loanId]);
  check('A2.15', 'claimAsBorrower releases the lien', lienAfterClaim.released, `gas=${claimReceipt.gasUsed}`);
  expectLedger('A2.15b', 'the borrower\'s claim moves exactly the collateral, vault → wallet',
    beforeClaim, afterClaim, { 'collateral.borrowerVault': -COLLATERAL, 'collateral.borrowerEOA': COLLATERAL });

  // --- and what the claim does to the position NFTs. Spec (NFT Status
  //     Updates on Closure): each side's NFT is burned once THAT side has
  //     claimed. So the borrower's receipt is spent by this claim, and the
  //     lender's — whose side has not claimed — still resolves to the lender.
  const ownerOrNull = async (tokenId) => {
    try { return await pub.readContract({ address: DIAMOND, abi: ABIS.nft, functionName: 'ownerOf', args: [tokenId] }); } catch { return null; }
  };
  const borrowerNftAfter = await ownerOrNull(repaid.borrowerTokenId);
  check('A2.16.borrower', 'the borrower\'s claim BURNS the borrower position NFT — redeeming the claim spends the receipt',
    borrowerNftAfter === null, borrowerNftAfter ? `still resolves (owner=${borrowerNftAfter})` : `tokenId=${repaid.borrowerTokenId} no longer resolves`);
  const lenderNftAfter = await ownerOrNull(repaid.lenderTokenId);
  check('A2.16.lender', 'the borrower\'s claim leaves the LENDER position NFT alone — it still resolves, to the lender, until the lender claims',
    lenderNftAfter !== null && lenderNftAfter.toLowerCase() === lender.address.toLowerCase(),
    lenderNftAfter ? `tokenId=${repaid.lenderTokenId} owner=${lenderNftAfter}` : 'no longer resolves');

  // Spec: the loan settles once BOTH sides have claimed, so after the
  // borrower's claim alone it is still Repaid — the borrower receipt burned
  // and the lien released (a released lien encumbers nothing, so it reads
  // amount 0), nothing else changed.
  await expectPosition('A2.16b', 'after the borrower\'s claim alone the position changes exactly: borrower NFT burned, lien released, still Repaid',
    loanId, afterRepayPos, { borrowerNftOwner: null, lienReleased: true, lienAmount: 0n });
  const afterBorrowerClaimPos = await positionOf(loanId);

  // --- claiming cannot pay twice
  const beforeSecond = await snapshot(tokens, holders);
  let secondReason = '(no revert)';
  try {
    await tx(borrower, { address: DIAMOND, abi: ABIS.claim, functionName: 'claimAsBorrower', args: [loanId] }, 'claimAsBorrower');
  } catch (e) { secondReason = String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 120); }
  const afterSecond = await snapshot(tokens, holders);
  check('A2.17', 'a second claim on the same side is refused AlreadyClaimed and pays out nothing',
    Object.keys(delta(beforeSecond, afterSecond)).length === 0 && /AlreadyClaimed\(\)/.test(secondReason), secondReason);

  // The lender claims LAST: once both sides have claimed the loan settles,
  // and the double-claim probe above must run while it is still Repaid.
  // --- the lender's claim on an ordinary repayment: the repay credited the
  //     lender's VAULT, and the claim sweeps exactly that to their wallet.
  const lenderCredit2 = PRINCIPAL + interest - interestCut;
  const beforeLenderClaim = await snapshot(tokens, holders);
  const lenderClaim = await tx(lender, { address: DIAMOND, abi: ABIS.claim, functionName: 'claimAsLender', args: [loanId] }, 'claimAsLender');
  const afterLenderClaim = await snapshot(tokens, holders);
  expectLedger('A2.18', 'the lender\'s claim moves exactly principal + interest net of the treasury fee, vault → wallet, and nothing else',
    beforeLenderClaim, afterLenderClaim, { 'lending.lenderVault': -lenderCredit2, 'lending.lenderEOA': lenderCredit2 }, `gas=${lenderClaim.gasUsed}`);
  await expectPosition('A2.18b', 'with both sides claimed the position settles: the lender NFT is burned too, status Settled, nothing else changed',
    loanId, afterBorrowerClaimPos, { lenderNftOwner: null, status: STATUS.Settled });
}
