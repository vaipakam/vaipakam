/**
 * A4 — the ways out that are not "wait for the term to end".
 *
 * Borrower-side: preclose on day one, and partial repayment. Lender-side:
 * listing an open position for sale. The preclose case is the one worth
 * reading twice — under a full-term-interest offer an early exit saves the
 * borrower no interest at all, which any interface quoting an early payoff
 * has to say out loud.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, delta, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { parseEventLogs } from 'viem';
import { f18 } from '../lib/chain.mjs';
import { warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, expectEq } from '../lib/report.mjs';

export async function run() {
  const lending = MOCKS.liquidToken2;
  const collateral = MOCKS.liquidToken;
  const lenderVault = await vaultAddressFor(lender);
  const borrowerVault = await vaultAddressFor(borrower);
  const tokens = { lending, collateral };
  const holders = {
    lenderEOA: lender.address, lenderVault,
    borrowerEOA: borrower.address, borrowerVault,
    diamond: DIAMOND, treasury: TREASURY,
  };

  // ------------------------------------------------------------- preclose
  {
    const { loanId } = await openLoan({ lender, borrower });
    await warpDays(1);
    const quoted = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]);
    const payoff = Array.isArray(quoted) ? quoted[0] : quoted;
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.preclose, functionName: 'precloseDirect', args: [loanId] }, 'precloseDirect');
    const after = await snapshot(tokens, holders);
    const closed = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    const paid = before['lending.borrowerEOA'] - after['lending.borrowerEOA'];
    check('A4.1', 'precloseDirect closes an open loan on day 1 of a 7-day term, ending it Repaid', String(closed.status) === String(STATUS.Repaid),
      `loanId=${loanId} gas=${receipt.gasUsed} status=${closed.status} deltas=${JSON.stringify(delta(before, after))}`);
    expectEq('A4.2', 'under a full-term-interest offer an early exit pays the FULL term\'s interest',
      paid, payoff, 'no early-exit interest saving — a payoff quote must say so');
    const beforeClaim = await snapshot(tokens, holders);
    await tx(borrower, { address: DIAMOND, abi: ABIS.claim, functionName: 'claimAsBorrower', args: [loanId] }, 'claimAsBorrower');
    const afterClaim = await snapshot(tokens, holders);
    const reclaimed = afterClaim['collateral.borrowerEOA'] - beforeClaim['collateral.borrowerEOA'];
    expectEq('A4.3', 'the borrower reclaims the whole collateral after a preclose', reclaimed, closed.collateralAmount);
  }

  // -------------------------------------------------------- partial repay
  {
    const { loanId } = await openLoan({ lender, borrower, allowsPartialRepay: true });
    const opened = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    expectEq('A4.4', 'the offer\'s allowsPartialRepay flag carries onto the loan', opened.allowsPartialRepay, true);

    const part = parseUnits('400', 18);
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayPartial', args: [loanId, part] }, 'repayPartial');
    const after = await snapshot(tokens, holders);
    const mid = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    check('A4.5', 'a partial repayment reduces the outstanding principal by exactly the payment and leaves the loan Active',
      String(mid.status) === '0' && opened.principal - mid.principal === part,
      `gas=${receipt.gasUsed} status=${mid.status} principalNow=${f18(mid.principal)} deltas=${JSON.stringify(delta(before, after))}`);

    const quoted = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]);
    const remaining = Array.isArray(quoted) ? quoted[0] : quoted;
    check('A4.6', 'the payoff quote reflects the paydown — the new principal plus interest, and no more than before',
      remaining > mid.principal && remaining < opened.principal, `remaining=${f18(remaining)} principalNow=${f18(mid.principal)}`);

    await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayLoan', args: [loanId] }, 'repayLoan');
    const finished = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    expectEq('A4.7', 'the final repayment after a partial terminalizes to Repaid', finished.status, 1);
  }

  // ---------------------------------------------------- lender loan sale
  {
    const { loanId } = await openLoan({ lender, borrower });
    const ok = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer', [loanId, 600n, true, BigInt(3 * 86_400)], lender.address);
    check('A4.8', 'the lender can list an open position for sale', ok.ok, ok.ok ? `loanId=${loanId}` : ok.name);

    const perpetual = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer', [loanId, 600n, true, 0n], lender.address);
    check('A4.9', 'a zero listing window is refused — every sale listing carries a finite expiry',
      !perpetual.ok, perpetual.ok ? 'zero expiry accepted' : perpetual.name);

    const impostor = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer', [loanId, 600n, true, BigInt(3 * 86_400)], outsider.address);
    check('A4.10', 'a third party cannot list someone else\'s position',
      !impostor.ok, impostor.ok ? 'NOT refused' : impostor.name);

    if (ok.ok) {
      const receipt = await tx(lender, { address: DIAMOND, abi: ABIS.earlyWithdrawal, functionName: 'createLoanSaleOffer', args: [loanId, 600n, true, BigInt(3 * 86_400)] }, 'createLoanSaleOffer');
      const [link] = parseEventLogs({ abi: ABIS.earlyWithdrawal, eventName: 'LoanSaleOfferLinked', logs: receipt.logs });
      const linked = link ? await read(ABIS.offerCancel, 'getOfferLinkedLoanId', [link.args.saleOfferId]) : null;
      check('A4.11', 'the sale listing lands on-chain as an offer linked to the loan',
        linked !== null && String(linked) === String(loanId), `gas=${receipt.gasUsed} saleOfferId=${link?.args.saleOfferId} linkedLoanId=${linked}`);
    }
  }
}
