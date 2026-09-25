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
import { ABIS, approveDiamond, createOffer, acceptOffer, delta, mint, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { cannotContinue, check, expectEq, observe } from '../lib/report.mjs';

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
  check('A2.1', 'creating a lender offer moves the principal into the LENDER\'S OWN vault',
    escrowed === PRINCIPAL && debited === PRINCIPAL,
    `offerId=${offerId} deltas=${JSON.stringify(delta(atStart, afterCreate))}`);

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

  expectEq('A2.3', 'treasury fee bps is STAMPED per loan (rev-8 freeze)', loan.treasuryFeeBpsAtInit, 200);
  expectEq('A2.4', 'loan-initiation fee bps is STAMPED per loan', loan.loanInitiationFeeBpsAtInit, 20);
  expectEq('A2.5', 'minimum health factor is STAMPED per loan', loan.minHealthFactorAtInit, 1_500_000_000_000_000_000n);

  const lif = PRINCIPAL * 20n / 10_000n;
  const toTreasury = afterAccept['lending.treasury'] - afterCreate['lending.treasury'];
  expectEq('A2.6', 'the LIF is charged in the LENDING asset and 99% of it reaches the treasury',
    toTreasury, lif - lif / 100n, 'the remaining 1% is the matcher kickback');
  const toBorrower = afterAccept['lending.borrowerEOA'] - afterCreate['lending.borrowerEOA'];
  expectEq('A2.7', 'the borrower receives principal net of the LIF, in their WALLET not their vault',
    toBorrower, PRINCIPAL - lif + lif / 100n, 'the borrower was the accept caller, so the 1% matcher cut returns to them');

  const hf = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
  const ltv = await read(ABIS.risk, 'calculateLTV', [loanId]);
  // $2,500 of collateral at the 80% liquidation LTV against $1,000 of debt:
  // HF = 2,500 × 0.8 / 1,000 = 2.0 and LTV = 1,000 / 2,500 = 40%, exactly.
  check('A2.8', 'health factor and LTV are computed from live oracle prices',
    hf === 2_000_000_000_000_000_000n && ltv === 4000n,
    `HF=${f18(hf)} LTV=${ltv}bps (want HF=2 LTV=4000bps: collateral $2,500 at 80% liquidation LTV against $1,000 of debt)`);

  // --- repay
  const quoted = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]);
  const total = Array.isArray(quoted) ? quoted[0] : quoted;
  const interest = total - PRINCIPAL;
  expectEq('A2.9', 'the payoff quote is principal + simple interest over the full term',
    interest, PRINCIPAL * 500n * 7n / 10_000n / 365n, `total=${f18(total)}`);

  const beforeRepay = await snapshot(tokens, holders);
  const repayReceipt = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayLoan', args: [loanId] }, 'repayLoan');
  const afterRepay = await snapshot(tokens, holders);
  const treasuryCut = afterRepay['lending.treasury'] - beforeRepay['lending.treasury'];
  expectEq('A2.10', 'the treasury takes 2% of the INTEREST and nothing of the principal',
    treasuryCut, interest * 200n / 10_000n, `gas=${repayReceipt.gasUsed}`);
  const lenderCredit = afterRepay['lending.lenderVault'] - beforeRepay['lending.lenderVault'];
  expectEq('A2.11', 'the lender is credited principal plus 98% of the interest, into their vault',
    lenderCredit, PRINCIPAL + interest - treasuryCut);

  const repaid = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  expectEq('A2.12', 'the loan terminalizes to Repaid', repaid.status, 1);

  // --- the collateral lien outlives the repay
  const lienAfterRepay = await read(ABIS.metrics, 'getLoanCollateralLien', [loanId]);
  check('A2.13', 'a repay settles the MONEY but leaves the collateral lien standing', !lienAfterRepay.released,
    `lien.released=${lienAfterRepay.released} amount=${f18(lienAfterRepay.amount)} — release is a separate, borrower-initiated claim`);

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
  check('A2.15', 'claimAsBorrower releases the lien and returns the collateral',
    lienAfterClaim.released && afterClaim['collateral.borrowerEOA'] - beforeClaim['collateral.borrowerEOA'] === COLLATERAL,
    `gas=${claimReceipt.gasUsed} deltas=${JSON.stringify(delta(beforeClaim, afterClaim))}`);

  // --- and what the claim does to the position NFTs. The receipt is spent
  //     by redeeming it: the CLAIMING side's NFT is burned, the other stays.
  for (const [side, tokenId] of [['lender', repaid.lenderTokenId], ['borrower', repaid.borrowerTokenId]]) {
    let owner = null;
    try { owner = await pub.readContract({ address: DIAMOND, abi: ABIS.nft, functionName: 'ownerOf', args: [tokenId] }); } catch { /* burned */ }
    observe(`A2.16.${side}`, `after the borrower's claim, the ${side} position NFT`,
      owner ? `still resolves (owner=${owner})` : 'no longer resolves — redeeming the claim spends the receipt');
  }

  // --- claiming cannot pay twice
  const beforeSecond = await snapshot(tokens, holders);
  let secondReason = '(no revert)';
  try {
    await tx(borrower, { address: DIAMOND, abi: ABIS.claim, functionName: 'claimAsBorrower', args: [loanId] }, 'claimAsBorrower');
  } catch (e) { secondReason = String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 120); }
  const afterSecond = await snapshot(tokens, holders);
  check('A2.17', 'a second claim on the same side cannot pay out again',
    Object.keys(delta(beforeSecond, afterSecond)).length === 0, secondReason);
}
