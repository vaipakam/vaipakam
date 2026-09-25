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
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, acceptStoredOffer, approveDiamond, createOffer, delta, mint, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { simulate } from '../lib/errors.mjs';
import { parseEventLogs } from 'viem';
import { cannotContinue, check, expectLedger, expectRefusal } from '../lib/report.mjs';

// Spec, "Sell the Loan to Another Lender" → Accrued Interest: the new lender
// pays EXACTLY the outstanding principal; interest accrued up to the sale is
// forfeited by the seller and routed to the treasury (on a fresh loan none of
// it has been paid, so all of it is forfeitable). Accrual is per second.
const YEAR_BPS = 365n * 86_400n * 10_000n;
async function forfeitedAtSale(loan, receipt) {
  const at = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  return (loan.principal * BigInt(loan.interestRateBps) * (at - BigInt(loan.startTime))) / YEAR_BPS;
}

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
    if (!listing.ok) cannotContinue('A8.1 listing', listing.name);
    {
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
      const unchanged = await read(ABIS.loan, 'getLoanDetails', [loanId]);
      check('A8.1', 'listing posts a vehicle offer linked to the loan, and leaves the loan untouched',
        String(linked) === String(loanId) && unchanged.lender === before.lender && String(unchanged.status) === '0',
        `saleOfferId=${saleOfferId} linkedLoanId=${linked} offerType=${vehicle.offerType} ` +
        `creator=${vehicle.creator.slice(0, 10)} expiresAt=${vehicle.expiresAt}`);

      const pre = await snapshot(tokens, holders);
      const bought = await acceptStoredOffer(saleOfferId, outsider);
      if (!bought.ok) cannotContinue('A8.2 buyer fill', bought.reason);
      {
        const post = await snapshot(tokens, holders);
        const after = await read(ABIS.loan, 'getLoanDetails', [loanId]);
        check('A8.2', 'filling the listing hands the lender side to the buyer — in the same transaction',
          after.lender.toLowerCase() === outsider.address.toLowerCase(),
          `gas=${bought.gas} lender ${before.lender.slice(0, 10)} -> ${after.lender.slice(0, 10)} status=${after.status}`);
        const forfeited = await forfeitedAtSale(before, bought.receipt);
        expectLedger('A8.2b', 'the listed sale settles exactly: the buyer pays the principal, the seller receives it net of the accrued interest they forfeit, which goes to the treasury',
          pre, post, {
            'lending.buyerEOA': -before.principal,
            'lending.lenderEOA': before.principal - forfeited,
            'lending.treasury': forfeited,
          }, `forfeited=${f18(forfeited)}`);
        check('A8.3', 'the borrower\'s side runs on unchanged — same borrower, principal, rate and term',
          after.borrower === before.borrower && after.principal === before.principal &&
          after.interestRateBps === before.interestRateBps && after.durationDays === before.durationDays && String(after.status) === '0',
          `borrower=${after.borrower.slice(0, 10)} principal=${f18(after.principal)} rate=${after.interestRateBps}bps status=${after.status}`);
        const late = await simulate(DIAMOND, ABIS.earlyWithdrawal, 'completeLoanSale', [loanId], lender.address);
        expectRefusal('A8.4', 'completeLoanSale afterwards is refused — the fill already completed it', late, 'SaleNotLinked');
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
    const standing = await read(ABIS.offerCancel, 'getOffer', [buy.offerId]);
    check('A8.5', 'a buyer posts a standing lender offer matching the loan',
      standing.creator.toLowerCase() === outsider.address.toLowerCase() && String(standing.offerType) === '0' && standing.amount === before.principal,
      `loanId=${loanId} buyOfferId=${buy.offerId}`);

    const notLender = await simulate(DIAMOND, ABIS.earlyWithdrawalDirect, 'sellLoanViaBuyOffer',
      [loanId, buy.offerId], outsider.address);
    expectRefusal('A8.6', 'only the current lender can sell the position', notLender, 'NotNFTOwner');

    const sim = await simulate(DIAMOND, ABIS.earlyWithdrawalDirect, 'sellLoanViaBuyOffer',
      [loanId, buy.offerId], lender.address);
    if (!sim.ok) cannotContinue('A8.7 direct sale', sim.name);
    const pre = await snapshot(tokens, holders);
    const receipt = await tx(lender, {
      address: DIAMOND, abi: ABIS.earlyWithdrawalDirect, functionName: 'sellLoanViaBuyOffer',
      args: [loanId, buy.offerId],
    }, 'sellLoanViaBuyOffer');
    const post = await snapshot(tokens, holders);
    const after = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    check('A8.7', 'a direct sale hands the lender side over in ONE transaction, with no listing',
      after.lender.toLowerCase() === outsider.address.toLowerCase() && after.borrower === before.borrower && String(after.status) === '0',
      `gas=${receipt.gasUsed} lender ${before.lender.slice(0, 10)} -> ${after.lender.slice(0, 10)} status=${after.status}`);
    // The buyer's principal was escrowed in their vault when they posted the
    // standing offer, so the direct sale draws it from there.
    const forfeited = await forfeitedAtSale(before, receipt);
    expectLedger('A8.7b', 'the direct sale settles exactly: the principal leaves the buyer\'s escrow, the seller receives it net of the forfeited accrued interest, which goes to the treasury',
      pre, post, {
        'lending.buyerVault': -before.principal,
        'lending.lenderEOA': before.principal - forfeited,
        'lending.treasury': forfeited,
      }, `forfeited=${f18(forfeited)}`);
  }
}
