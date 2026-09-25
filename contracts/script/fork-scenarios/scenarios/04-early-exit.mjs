/**
 * A4 — the ways out that are not "wait for the term to end".
 *
 * Borrower-side: preclose on day one, and partial repayment. Lender-side:
 * listing an open position for sale. The preclose case is the one worth
 * reading twice — under a full-term-interest offer an early exit saves the
 * borrower no interest at all, which any interface quoting an early payoff
 * has to say out loud.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, delta, expectPosition, openLoan, positionOf, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { parseEventLogs } from 'viem';
import { f18 } from '../lib/chain.mjs';
import { warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, expectEq, expectLedger, expectRefusal, requireEnvelope } from '../lib/report.mjs';

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
    const prePos = await positionOf(loanId);
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.preclose, functionName: 'precloseDirect', args: [loanId] }, 'precloseDirect');
    const after = await snapshot(tokens, holders);
    const closed = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    const paid = before['lending.borrowerEOA'] - after['lending.borrowerEOA'];
    check('A4.1', 'precloseDirect closes an open loan on day 1 of a 7-day term, ending it Repaid', String(closed.status) === String(STATUS.Repaid),
      `loanId=${loanId} gas=${receipt.gasUsed} status=${closed.status} deltas=${JSON.stringify(delta(before, after))}`);
    expectEq('A4.2', 'under a full-term-interest offer an early exit pays the FULL term\'s interest',
      paid, payoff, 'no early-exit interest saving — a payoff quote must say so');
    const preInterest = payoff - closed.principal;
    const preCut = (preInterest * BigInt(closed.treasuryFeeBpsAtInit)) / 10_000n;
    expectLedger('A4.2b', 'the preclose moves exactly: the payoff from the borrower\'s wallet, principal + the interest net of the treasury\'s stamped share to the lender\'s vault, that share to the treasury',
      before, after, {
        'lending.borrowerEOA': -payoff,
        'lending.lenderVault': payoff - preCut,
        'lending.treasury': preCut,
      });
    await expectPosition('A4.2c', 'the preclose changes ONLY the status to Repaid — both NFTs, terms and the whole lien as they were',
      loanId, prePos, { status: STATUS.Repaid });
    const beforeClaim = await snapshot(tokens, holders);
    await tx(borrower, { address: DIAMOND, abi: ABIS.claim, functionName: 'claimAsBorrower', args: [loanId] }, 'claimAsBorrower');
    const afterClaim = await snapshot(tokens, holders);
    expectLedger('A4.3', 'the borrower reclaims exactly the whole collateral after a preclose, vault → wallet',
      beforeClaim, afterClaim, { 'collateral.borrowerVault': -closed.collateralAmount, 'collateral.borrowerEOA': closed.collateralAmount });
  }

  // -------------------------------------------------------- partial repay
  {
    const { loanId } = await openLoan({ lender, borrower, allowsPartialRepay: true });
    const opened = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    expectEq('A4.4', 'the offer\'s allowsPartialRepay flag carries onto the loan', opened.allowsPartialRepay, true);

    // 400 of 1,000, raised to the asset's governed minimum partial if that is
    // higher (a partial below it is refused by design), and declared in-
    // envelope only if that still leaves some principal outstanding.
    const { minPartialBps } = await read(ABIS.config, 'getAssetRiskParams', [lending]);
    const floor = (opened.principal * BigInt(minPartialBps) + 9_999n) / 10_000n;
    const part = floor > parseUnits('400', 18) ? floor : parseUnits('400', 18);
    requireEnvelope('minPartialBps', part < opened.principal,
      `the asset's minimum partial (${minPartialBps} bps) leaves no partial below the whole principal`);
    const partPos = await positionOf(loanId);
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayPartial', args: [loanId, part] }, 'repayPartial');
    const after = await snapshot(tokens, holders);
    const mid = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    // Spec: a non-periodic partial pays the interest accrued so far (whole
    // days, rounded down — borrower-favourable) plus the principal reduction,
    // straight to the lender's WALLET; the treasury takes its fee on the
    // interest only.
    const partAt = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const partDays = (partAt - BigInt(opened.startTime)) / 86_400n;
    const partInterest = (opened.principal * BigInt(opened.interestRateBps) * partDays) / (365n * 10_000n);
    const partCut = (partInterest * BigInt(opened.treasuryFeeBpsAtInit)) / 10_000n;
    expectLedger('A4.5b', 'the partial repayment moves exactly: accrued interest + the principal reduction from the borrower, to the lender\'s wallet, the treasury\'s fee on the interest only',
      before, after, {
        'lending.borrowerEOA': -(part + partInterest),
        'lending.lenderEOA': part + partInterest - partCut,
        'lending.treasury': partCut,
      }, `wholeDaysElapsed=${partDays} interest=${f18(partInterest)}`);
    check('A4.5', 'a partial repayment reduces the outstanding principal by exactly the payment and leaves the loan Active',
      String(mid.status) === '0' && opened.principal - mid.principal === part,
      `gas=${receipt.gasUsed} status=${mid.status} principalNow=${f18(mid.principal)} deltas=${JSON.stringify(delta(before, after))}`);

    // The partial also restarts the accrual clock at its own block — the
    // interest it charged is paid, so the next charge accrues from here.
    await expectPosition('A4.5c', 'the partial changes the position exactly: principal down by the payment, the accrual clock restarted at the payment — collateral, NFTs and lien unchanged, still Active',
      loanId, partPos, { principal: partPos.principal - part, interestAccrualStart: partAt });
    const quoted = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]);
    const remaining = Array.isArray(quoted) ? quoted[0] : quoted;
    check('A4.6', 'the payoff quote reflects the paydown — the new principal plus interest, and no more than before',
      remaining > mid.principal && remaining < opened.principal, `remaining=${f18(remaining)} principalNow=${f18(mid.principal)}`);

    // The final repayment runs on the state the partial left behind — the
    // reduced principal and the reset accrual clock — which the ordinary A2
    // repay never exercises, so it is accounted in its own right: the payoff
    // quote from the borrower's wallet, the remaining principal + interest
    // less the treasury's fee on that interest into the lender's vault.
    const finalInterest = remaining - mid.principal;
    const finalCut = (finalInterest * BigInt(mid.treasuryFeeBpsAtInit)) / 10_000n;
    const finalPos = await positionOf(loanId);
    const beforeFinal = await snapshot(tokens, holders);
    const finalReceipt = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayLoan', args: [loanId] }, 'repayLoan');
    const afterFinal = await snapshot(tokens, holders);
    const finished = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    expectEq('A4.7', 'the final repayment after a partial terminalizes to Repaid', finished.status, STATUS.Repaid);
    expectLedger('A4.7b', 'the final repayment after a partial moves exactly: the re-quoted payoff from the borrower, the remaining principal + interest net of the treasury fee to the lender\'s vault',
      beforeFinal, afterFinal, {
        'lending.borrowerEOA': -remaining,
        'lending.lenderVault': remaining - finalCut,
        'lending.treasury': finalCut,
      }, `gas=${finalReceipt.gasUsed} principal=${f18(mid.principal)} interest=${f18(finalInterest)}`);
    await expectPosition('A4.7c', 'the final repayment changes ONLY the status to Repaid',
      loanId, finalPos, { status: STATUS.Repaid });
  }

  // ---------------------------------------------------- lender loan sale
  {
    const { loanId } = await openLoan({ lender, borrower });
    const ok = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer', [loanId, 600n, true, BigInt(3 * 86_400)], lender.address);
    check('A4.8', 'the lender can list an open position for sale', ok.ok, ok.ok ? `loanId=${loanId}` : ok.name);

    const perpetual = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer', [loanId, 600n, true, 0n], lender.address);
    expectRefusal('A4.9', 'a zero listing window is refused — every sale listing carries a finite expiry', perpetual, 'SaleListingWindowInvalid');

    const impostor = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer', [loanId, 600n, true, BigInt(3 * 86_400)], outsider.address);
    expectRefusal('A4.10', 'a third party cannot list someone else\'s position', impostor, 'KeeperAccessRequired');

    if (ok.ok) {
      const receipt = await tx(lender, { address: DIAMOND, abi: ABIS.earlyWithdrawal, functionName: 'createLoanSaleOffer', args: [loanId, 600n, true, BigInt(3 * 86_400)] }, 'createLoanSaleOffer');
      const [link] = parseEventLogs({ abi: ABIS.earlyWithdrawal, eventName: 'LoanSaleOfferLinked', logs: receipt.logs });
      const linked = link ? await read(ABIS.offerCancel, 'getOfferLinkedLoanId', [link.args.saleOfferId]) : null;
      check('A4.11', 'the sale listing lands on-chain as an offer linked to the loan',
        linked !== null && String(linked) === String(loanId), `gas=${receipt.gasUsed} saleOfferId=${link?.args.saleOfferId} linkedLoanId=${linked}`);
    }
  }
}
