/**
 * A7 — the two exits that hand a position to someone else.
 *
 * The offset route lets a borrower close a loan by posting a replacement
 * offer that a third party fills; the obligation-transfer route hands the
 * debt to a replacement borrower who already has a standing offer. Both are
 * settlement paths, and the offset one carries a trap worth pinning: its
 * completion is AUTOMATIC. A third party accepting the offset offer closes
 * the original loan inside that same transaction, so a surface that waits
 * for a manual second step is waiting for something that already happened.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, approveDiamond, acceptOffer, acceptStoredOffer, createOffer, delta, mint, openLoan, read, snapshot, vaultAddressFor, lifSplit, liveFees } from '../lib/flow.mjs';
import { chainNow, f18 } from '../lib/chain.mjs';
import { warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectEq, expectLedger, observe, expectRefusal } from '../lib/report.mjs';

export async function run() {
  const lending = MOCKS.liquidToken2;
  const collateral = MOCKS.liquidToken;
  const lenderVault = await vaultAddressFor(lender);
  const borrowerVault = await vaultAddressFor(borrower);
  const outsiderVault = await vaultAddressFor(outsider);
  const tokens = { lending, collateral };
  const holders = {
    lenderEOA: lender.address, lenderVault,
    borrowerEOA: borrower.address, borrowerVault,
    outsiderEOA: outsider.address, outsiderVault,
    diamond: DIAMOND, treasury: TREASURY,
  };

  await mint(outsider, lending, '100000');
  await approveDiamond(outsider, lending);
  await mint(outsider, collateral, '100000');
  await approveDiamond(outsider, collateral);

  // ------------------------------------------------------------- offset
  {
    const { loanId } = await openLoan({ lender, borrower });

    const impostor = await simulate(DIAMOND, ABIS.preclose, 'offsetWithNewOffer',
      [loanId, 400n, 7n, collateral, parseUnits('1.25', 18), true, lending], outsider.address);
    expectRefusal('A7.1', 'only the borrower can offset their own loan', impostor, 'KeeperAccessRequired');

    // The replacement's maturity must not pass the ORIGINAL loan's, and the
    // bound is seconds-precise: `now + newTerm <= startTime + oldTerm`. A
    // same-length replacement therefore only fits in the same second the loan
    // originated, and is refused a block later — which is exactly the shape
    // that makes a simulate-then-send pair disagree.
    await warpDays(1 / 1440); // one minute, so the comparison is not same-second
    const sameTerm = await simulate(DIAMOND, ABIS.preclose, 'offsetWithNewOffer',
      [loanId, 400n, 7n, collateral, parseUnits('1.25', 18), true, lending], borrower.address);
    expectRefusal('A7.2a', 'a same-length replacement is refused once any time has passed — the maturity bound is seconds-precise', sameTerm, 'InvalidOfferTerms');

    const OFFSET_DAYS = 6n;
    const sim = await simulate(DIAMOND, ABIS.preclose, 'offsetWithNewOffer',
      [loanId, 400n, OFFSET_DAYS, collateral, parseUnits('1.25', 18), true, lending], borrower.address);
    if (!sim.ok) cannotContinue('A7.2 offset offer', sim.name);
    const posted = await tx(borrower, {
      address: DIAMOND, abi: ABIS.preclose, functionName: 'offsetWithNewOffer',
      args: [loanId, 400n, OFFSET_DAYS, collateral, parseUnits('1.25', 18), true, lending],
    }, 'offsetWithNewOffer');
    const offsetOfferId = BigInt(sim.result);
    const stillOpen = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    check('A7.2', 'posting an offset offer leaves the original loan Active — it is an OFFER, not a close',
      String(stillOpen.status) === '0',
      `loanId=${loanId} offsetOfferId=${offsetOfferId} status=${stillOpen.status} gas=${posted.gasUsed}`);

    // The offset vehicle is created BY the facet, not by this harness, so its
    // terms are read back rather than guessed. It is worth looking at what
    // comes back: the vehicle is a LENDER offer (`offerType` 0) posted by the
    // BORROWER — the offset works by the exiting borrower standing on the
    // other side of a replacement loan, which is not what "offset" suggests
    // on its own.
    const vehicle = await read(ABIS.offerCancel, 'getOffer', [offsetOfferId]);
    observe('A7.2b', 'the offset vehicle is a LENDER-side offer posted by the borrower',
      `offerType=${vehicle.offerType} creator=${vehicle.creator.slice(0, 10)} ` +
      `amount=${f18(vehicle.amount)} rate=${vehicle.interestRateBps}bps term=${vehicle.durationDays}d`);

    const before = await snapshot(tokens, holders);
    const accepted = await acceptStoredOffer(offsetOfferId, outsider);
    if (!accepted.ok) cannotContinue('A7.3 offset fill', accepted.reason);
    const after = await snapshot(tokens, holders);
    const settled = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    check('A7.3', 'accepting the offset offer CLOSES the original loan automatically — no manual second step',
      String(settled.status) === String(STATUS.Repaid), `gas=${accepted.gas} originalStatus=${settled.status}`);

    // The money, from the spec's Option 3 "Economic Protection": the exiting
    // borrower repays the principal and pays the interest accrued to the
    // offset SECOND plus max(0, original remaining interest − the new
    // offer's expected interest), held for the original lender; the treasury
    // takes its fee on the accrued part only. The borrower ALSO funds the new
    // position from the escrow they posted with the vehicle, and the third
    // party who fills it borrows that amount net of the loan-initiation fee
    // (99% treasury, 1% back to them as the accept's matcher), posting their
    // own collateral. The original collateral is not moved here — it becomes
    // claimable.
    const YEAR_BPS = 365n * 86_400n * 10_000n;
    const offsetAt = BigInt((await pub.getBlock({ blockNumber: accepted.receipt.blockNumber })).timestamp);
    const origLoan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    const oElapsed = offsetAt - BigInt(origLoan.startTime);
    const oTotal = BigInt(origLoan.durationDays) * 86_400n;
    const oRate = BigInt(origLoan.interestRateBps);
    const oAccrued = (origLoan.principal * oRate * oElapsed) / YEAR_BPS;
    const oRemaining = (origLoan.principal * oRate * (oTotal > oElapsed ? oTotal - oElapsed : 0n)) / YEAR_BPS;
    const oNew = (vehicle.amount * BigInt(vehicle.interestRateBps) * BigInt(vehicle.durationDays) * 86_400n) / YEAR_BPS;
    const oShortfall = oRemaining > oNew ? oRemaining - oNew : 0n;
    const oCut = (oAccrued * BigInt(origLoan.treasuryFeeBpsAtInit)) / 10_000n;
    // The new position's LIF is charged at the live configured rate it stamps.
    const liveFee = await liveFees();
    const { lif, toMatcher: lifMatcher } = lifSplit(vehicle.amount, liveFee.lifBps, liveFee.matcherBps);
    expectLedger('A7.3b', 'the offset settles exactly: the original lender is paid principal + accrued interest + the protection shortfall, the new borrower draws the escrowed principal net of the LIF',
      before, after, {
        'lending.borrowerEOA': -(origLoan.principal + oAccrued + oShortfall),
        'lending.lenderVault': origLoan.principal + oAccrued - oCut + oShortfall,
        'lending.borrowerVault': -vehicle.amount,
        'lending.outsiderEOA': vehicle.amount - lif + lifMatcher,
        'lending.treasury': oCut + lif - lifMatcher,
        'collateral.outsiderEOA': -vehicle.collateralAmount,
        'collateral.outsiderVault': vehicle.collateralAmount,
      }, `elapsed=${oElapsed}s accrued=${f18(oAccrued)} shortfall=${f18(oShortfall)}`);

    const late = await simulate(DIAMOND, ABIS.preclose, 'completeOffset', [loanId], borrower.address);
    expectRefusal('A7.4', 'calling completeOffset afterwards is refused — the auto-link already ran', late, 'LoanNotActive');
  }

  // ------------------------------------------------- obligation handover
  {
    const { loanId } = await openLoan({ lender, borrower });
    const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);

    // The replacement borrower posts a standing Borrower offer matching the
    // loan's shape; the exiting borrower then consumes it.
    const replacement = await createOffer(outsider, {
      offerType: 1,
      amount: loan.principal,
      amountMax: loan.principal,
      interestRateBps: loan.interestRateBps,
      interestRateBpsMax: loan.interestRateBps,
      collateralAmount: parseUnits('1.25', 18),
      collateralAmountMax: parseUnits('1.25', 18),
      // Same seconds-precise maturity bound as the offset route: the
      // replacement must not carry the lender's exposure past the original
      // maturity, so a same-length term cannot fit once the loan is running.
      durationDays: loan.durationDays - 1n,
    });
    const standing = await read(ABIS.offerCancel, 'getOffer', [replacement.offerId]);
    check('A7.5', 'a replacement borrower can post a standing borrow offer',
      standing.creator.toLowerCase() === outsider.address.toLowerCase() && String(standing.offerType) === '1',
      `loanId=${loanId} offerId=${replacement.offerId}`);

    const notBorrower = await simulate(DIAMOND, ABIS.preclose, 'transferObligationViaOffer',
      [loanId, replacement.offerId], outsider.address);
    expectRefusal('A7.6', 'only the exiting borrower can hand over their own obligation', notBorrower, 'KeeperAccessRequired');

    const handover = await simulate(DIAMOND, ABIS.preclose, 'transferObligationViaOffer',
      [loanId, replacement.offerId], borrower.address);
    if (!handover.ok) cannotContinue('A7.7 handover', handover.name);
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, {
      address: DIAMOND, abi: ABIS.preclose, functionName: 'transferObligationViaOffer',
      args: [loanId, replacement.offerId],
    }, 'transferObligationViaOffer');
    const after = await snapshot(tokens, holders);
    const moved = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    check('A7.7', 'the handover rewrites the loan\'s borrower in place — the loan itself survives',
      moved.borrower.toLowerCase() === outsider.address.toLowerCase() && String(moved.status) === String(STATUS.Active),
      `gas=${receipt.gasUsed} status=${moved.status} borrower ${borrower.address.slice(0, 10)} -> ${moved.borrower.slice(0, 10)}`);

    // The money, from the spec's "Economic Protection for the Original
    // Lender": the exiting borrower pays the interest accrued to the transfer
    // SECOND plus any shortfall between the original remaining interest and
    // the replacement's (max(0, orig − new)); those funds are held for the
    // lender. The treasury takes its fee on the ACCRUED interest only — the
    // shortfall is a lender top-up. The exiting borrower's own collateral is
    // released back to them; the replacement's was escrowed when they posted.
    const at = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const YEAR_BPS = 365n * 86_400n * 10_000n;
    const elapsed = at - BigInt(loan.startTime);
    const totalSecs = BigInt(loan.durationDays) * 86_400n;
    const remaining = totalSecs > elapsed ? totalSecs - elapsed : 0n;
    const rate = BigInt(loan.interestRateBps);
    const accrued = (loan.principal * rate * elapsed) / YEAR_BPS;
    const origRemaining = (loan.principal * rate * remaining) / YEAR_BPS;
    const newRemaining = (loan.principal * BigInt(standing.interestRateBps) * BigInt(standing.durationDays) * 86_400n) / YEAR_BPS;
    const shortfall = origRemaining > newRemaining ? origRemaining - newRemaining : 0n;
    const toTreasury = (accrued * BigInt(loan.treasuryFeeBpsAtInit)) / 10_000n;
    expectLedger('A7.7b', 'the exiting borrower pays accrued interest plus the lender-protection shortfall, held for the lender; the treasury cut is on the accrued part only',
      before, after, {
        'lending.borrowerEOA': -(accrued + shortfall),
        'lending.lenderVault': accrued - toTreasury + shortfall,
        'lending.treasury': toTreasury,
        'collateral.borrowerVault': -loan.collateralAmount,
        'collateral.borrowerEOA': loan.collateralAmount,
      }, `elapsed=${elapsed}s accrued=${f18(accrued)} shortfall=${f18(shortfall)}`);
    expectEq('A7.8', 'the lender is untouched by a handover — same lender, same principal',
      `${moved.lender}/${moved.principal}`, `${loan.lender}/${loan.principal}`);
  }
}
