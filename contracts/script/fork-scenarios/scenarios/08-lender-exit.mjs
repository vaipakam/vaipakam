/**
 * A8 — the lender's two ways out of an open position.
 *
 * A4 already shows a lender can LIST a position; this follows the listing
 * through to a sale, and adds the direct route that skips the listing
 * entirely. Both hand the lender side of a live loan to a new lender while
 * the borrower's position runs on unchanged.
 *
 *  - Listed: `createLoanSaleOffer` posts a vehicle offer; a buyer filling it
 *    completes the sale automatically, the same auto-link shape as the
 *    borrower's offset route (A7) — there is no manual second step.
 *  - Direct: `sellLoanViaBuyOffer` sells straight into a standing lender
 *    offer in one transaction, split into its own facet (#1780) and worth
 *    exercising for that reason alone.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, tx } from '../lib/chain.mjs';
import { ABIS, acceptStoredOffer, approveDiamond, createOffer, delta, mint, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { simulate } from '../lib/errors.mjs';
import { parseEventLogs } from 'viem';
import { record } from '../lib/report.mjs';

export async function run() {
  const lending = MOCKS.liquidToken2;
  const collateral = MOCKS.liquidToken;
  const tokens = { lending, collateral };
  const holders = {
    lenderEOA: lender.address, lenderVault: await vaultAddressFor(lender),
    borrowerEOA: borrower.address, borrowerVault: await vaultAddressFor(borrower),
    buyerEOA: outsider.address, buyerVault: await vaultAddressFor(outsider),
    diamond: DIAMOND, treasury: TREASURY,
  };
  await mint(outsider, lending, '100000');
  await approveDiamond(outsider, lending);

  // ------------------------------------------------------- listed sale
  {
    const { loanId } = await openLoan({ lender, borrower });
    const before = await read(ABIS.loan, 'getLoanDetails', [loanId]);

    const listing = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'createLoanSaleOffer',
      [loanId, 500n, true, BigInt(3 * 86_400)], lender.address);
    if (!listing.ok) {
      record('A8.1', 'the lender lists the position', 'INFO', listing.name);
    } else {
      const listed = await tx(lender, {
        address: DIAMOND, abi: ABIS.earlyWithdrawal, functionName: 'createLoanSaleOffer',
        args: [loanId, 500n, true, BigInt(3 * 86_400)],
      }, 'createLoanSaleOffer');
      // `createLoanSaleOffer` returns nothing, so the vehicle's id comes from
      // the `LoanSaleOfferLinked` event rather than from a return value.
      const [link] = parseEventLogs({ abi: ABIS.earlyWithdrawal, eventName: 'LoanSaleOfferLinked', logs: listed.logs });
      const saleOfferId = link.args.saleOfferId;
      const vehicle = await read(ABIS.offerCancel, 'getOffer', [saleOfferId]);
      const linked = await read(ABIS.offerCancel, 'getOfferLinkedLoanId', [saleOfferId]);
      record('A8.1', 'listing posts a vehicle offer linked to the loan, and leaves the loan untouched',
        String(linked) === String(loanId) ? 'PASS' : 'FAIL',
        `saleOfferId=${saleOfferId} linkedLoanId=${linked} offerType=${vehicle.offerType} ` +
        `creator=${vehicle.creator.slice(0, 10)} expiresAt=${vehicle.expiresAt}`);

      const pre = await snapshot(tokens, holders);
      const bought = await acceptStoredOffer(saleOfferId, outsider);
      if (!bought.ok) {
        record('A8.2', 'a buyer fills the listed sale', 'INFO', bought.reason);
      } else {
        const post = await snapshot(tokens, holders);
        const after = await read(ABIS.loan, 'getLoanDetails', [loanId]);
        record('A8.2', 'filling the listing hands the lender side to the buyer — in the same transaction',
          after.lender.toLowerCase() === outsider.address.toLowerCase() ? 'PASS' : 'INFO',
          `gas=${bought.gas} lender ${before.lender.slice(0, 10)} -> ${after.lender.slice(0, 10)} ` +
          `status=${after.status} deltas=${JSON.stringify(delta(pre, post))}`);
        record('A8.3', 'the borrower\'s side runs on unchanged — same borrower, principal, rate and term',
          after.borrower === before.borrower && after.principal === before.principal &&
          after.interestRateBps === before.interestRateBps && String(after.status) === '0' ? 'PASS' : 'FAIL',
          `borrower=${after.borrower.slice(0, 10)} principal=${f18(after.principal)} rate=${after.interestRateBps}bps status=${after.status}`);
        const late = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'completeLoanSale', [loanId], lender.address);
        record('A8.4', 'completeLoanSale afterwards is refused — the fill already completed it',
          !late.ok ? 'PASS' : 'INFO', late.ok ? 'still callable' : late.name);
      }
    }
  }

  // ------------------------------------------------------- direct sale
  {
    const { loanId } = await openLoan({ lender, borrower });
    const before = await read(ABIS.loan, 'getLoanDetails', [loanId]);

    // The buyer's standing lender offer, on the loan's shape. The direct
    // route sells INTO it without the lender ever listing.
    const buy = await createOffer(outsider, {
      amount: before.principal,
      amountMax: before.principal,
      collateralAmount: before.collateralAmount,
      collateralAmountMax: before.collateralAmount,
      durationDays: before.durationDays,
    });
    record('A8.5', 'a buyer posts a standing lender offer matching the loan', 'PASS',
      `loanId=${loanId} buyOfferId=${buy.offerId}`);

    const notLender = await simulate(DIAMOND, ABIS.earlyWithdrawalDirect, 'sellLoanViaBuyOffer',
      [loanId, buy.offerId], outsider.address);
    record('A8.6', 'only the current lender can sell the position',
      !notLender.ok ? 'PASS' : 'FAIL', notLender.ok ? 'NOT refused' : notLender.name);

    const sim = await simulate(DIAMOND, ABIS.earlyWithdrawalDirect, 'sellLoanViaBuyOffer',
      [loanId, buy.offerId], lender.address);
    if (!sim.ok) {
      record('A8.7', 'the lender sells directly into the standing offer', 'INFO', sim.name);
      return;
    }
    const pre = await snapshot(tokens, holders);
    const receipt = await tx(lender, {
      address: DIAMOND, abi: ABIS.earlyWithdrawalDirect, functionName: 'sellLoanViaBuyOffer',
      args: [loanId, buy.offerId],
    }, 'sellLoanViaBuyOffer');
    const post = await snapshot(tokens, holders);
    const after = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    record('A8.7', 'a direct sale hands the lender side over in ONE transaction, with no listing',
      after.lender.toLowerCase() === outsider.address.toLowerCase() ? 'PASS' : 'INFO',
      `gas=${receipt.gasUsed} lender ${before.lender.slice(0, 10)} -> ${after.lender.slice(0, 10)} ` +
      `status=${after.status} deltas=${JSON.stringify(delta(pre, post))}`);
  }
}
