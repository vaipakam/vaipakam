/**
 * A6 — surplus collateral, and moving a loan onto new terms.
 *
 * Two paths the earlier scenarios leave uncovered, both of which move funds
 * on an OPEN position rather than closing one:
 *
 *  - Releasing surplus collateral mid-loan. The interesting part is the
 *    boundary: how much the protocol will let go, and that it refuses a wei
 *    past it rather than letting the position drift under its own floor.
 *  - Refinance, which is NOT an in-place edit of a loan. It leaves two loan
 *    records and four position NFTs, and an indexer that assumes one NFT per
 *    loan, or that a terminal loan's NFTs are gone, is wrong on both counts.
 *    That is worth observing rather than trusting.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, approveDiamond, acceptOffer, createOffer, delta, mint, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { chainNow, f18 } from '../lib/chain.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectEq, expectLedger, expectRefusal } from '../lib/report.mjs';

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

  // ------------------------------------------- surplus collateral release
  {
    // 2.5 tLIQ against 1,000 tLIQ2 of debt is HF 4 — deliberately far above
    // the 1.5 floor, so there IS a surplus to release.
    const { loanId } = await openLoan({ lender, borrower, collateralAmount: parseUnits('2.5', 18) });
    const openedHf = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
    const max = await read(ABIS.partialWithdrawal, 'calculateMaxWithdrawable', [loanId]);
    const maxAmount = Array.isArray(max) ? max[0] : max;
    check('A6.1', 'an over-collateralised loan reports a releasable surplus', maxAmount > 0n,
      `loanId=${loanId} HF=${f18(openedHf)} maxWithdrawable=${f18(maxAmount)} of 2.5 collateral`);

    // Authorisation is probed WHILE there is surplus to release. Probed after
    // the release (as it first was), the outsider's one-wei call would be
    // refused by the health bound whether or not the ownership check existed,
    // and the row would certify an authorisation it never tested. The refusal
    // must also be the OWNERSHIP one, by name.
    const impostor = await simulate(DIAMOND, ABIS.partialWithdrawal, 'partialWithdrawCollateral', [loanId, 1n], outsider.address);
    expectRefusal('A6.5', 'a third party cannot release the borrower\'s collateral, even while a surplus is releasable', impostor, 'NotNFTOwner');

    // A wei past the quoted maximum must be refused, not clamped.
    const overshoot = await simulate(DIAMOND, ABIS.partialWithdrawal, 'partialWithdrawCollateral', [loanId, maxAmount + 1n], borrower.address);
    expectRefusal('A6.2', 'one wei past the quoted maximum is refused, not silently clamped', overshoot, 'HealthFactorTooLow');

    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.partialWithdrawal, functionName: 'partialWithdrawCollateral', args: [loanId, maxAmount] }, 'partialWithdrawCollateral');
    const after = await snapshot(tokens, holders);
    const closingHf = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
    const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    check('A6.3', 'releasing the whole quoted surplus leaves the loan Active, still above the floor, with its recorded collateral reduced by exactly that amount',
      String(loan.status) === '0' && closingHf >= 1_500_000_000_000_000_000n && parseUnits('2.5', 18) - loan.collateralAmount === maxAmount,
      `gas=${receipt.gasUsed} status=${loan.status} HF ${f18(openedHf)} -> ${f18(closingHf)} collateral ${f18(loan.collateralAmount)}`);
    // The borrower-position NFT holder is the borrower here, so the release
    // lands in their wallet — straight out of their own vault.
    expectLedger('A6.3b', 'the released collateral moves exactly: out of the borrower\'s vault into their wallet',
      before, after, { 'collateral.borrowerVault': -maxAmount, 'collateral.borrowerEOA': maxAmount }, `released=${f18(maxAmount)}`);

    // Having released the surplus, there is none left to release.
    const again = await read(ABIS.partialWithdrawal, 'calculateMaxWithdrawable', [loanId]);
    const againAmount = Array.isArray(again) ? again[0] : again;
    check('A6.4', 'a second quote reports no remaining surplus', againAmount === 0n,
      `maxWithdrawable now ${f18(againAmount)}`);

  }

  // ------------------------------------------------------------ refinance
  {
    const { loanId: oldLoanId } = await openLoan({ lender, borrower });
    const oldLoan = await read(ABIS.loan, 'getLoanDetails', [oldLoanId]);

    // A refinance-tagged offer is SINGLE-PURPOSE and heavily constrained: it
    // must be a BORROWER offer, all-or-nothing fill, on the same lending /
    // collateral / prepay assets, with `amount <= oldPrincipal <= amountMax`,
    // AND the borrower must have consented in advance by enabling
    // auto-refinance caps on the loan. That consent gate is the interesting
    // part — the terms a third party may move the borrower onto are bounded
    // by something the borrower set first, not by the offer alone.
    const capless = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
      [await (await import('../lib/flow.mjs')).offerParams({
        offerType: 1, interestRateBps: 300n, interestRateBpsMax: 300n,
        refinanceTargetLoanId: oldLoanId, fillMode: 1,
      })], borrower.address);
    expectRefusal('A6.6a', 'a refinance-tagged offer is refused until the borrower has set auto-refinance caps', capless, 'RefinanceCapsRequired');

    // `maxNewExpiry` must be a FUTURE timestamp when enabling: the setter
    // refuses 0 even though the checker reads 0 as "no expiry cap", so the
    // consent always carries a real deadline.
    const capsExpiry = BigInt((await chainNow()) + 365 * 86_400);
    const zeroExpiry = await simulate(DIAMOND, ABIS.autoLifecycle, 'setAutoRefinanceCaps',
      [oldLoanId, true, 400, 0n], borrower.address);
    expectRefusal('A6.6b', 'enabling caps with no expiry is refused — the consent always carries a deadline', zeroExpiry, 'InvalidCaps');

    const capsReceipt = await tx(borrower, {
      address: DIAMOND, abi: ABIS.autoLifecycle, functionName: 'setAutoRefinanceCaps',
      args: [oldLoanId, true, 400, capsExpiry],
    }, 'setAutoRefinanceCaps');
    const capsNow = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
      [await (await import('../lib/flow.mjs')).offerParams({
        offerType: 1, interestRateBps: 300n, interestRateBpsMax: 300n,
        refinanceTargetLoanId: oldLoanId, fillMode: 1,
      })], borrower.address);
    check('A6.6c', 'once the borrower has capped the rate in advance, a refinance offer within the cap is admitted',
      capsNow.ok, `loanId=${oldLoanId} maxRateBps=400 expiry=+365d gas=${capsReceipt.gasUsed}${capsNow.ok ? '' : ` -> ${capsNow.name}`}`);

    const overCap = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
      [await (await import('../lib/flow.mjs')).offerParams({
        offerType: 1, interestRateBps: 500n, interestRateBpsMax: 500n,
        refinanceTargetLoanId: oldLoanId, fillMode: 1,
      })], borrower.address);
    expectRefusal('A6.6d', 'an offer above the consented rate cap is refused', overCap, 'RefinanceRateExceedsCap');

    await mint(outsider, lending, '100000');
    await approveDiamond(outsider, lending);
    // Admitted by A6.6c's simulation, so a failure to post here is a broken
    // flow, not an observation — `createOffer` throws and the file aborts.
    const posted = await createOffer(borrower, {
      offerType: 1,
      interestRateBps: 300n,
      interestRateBpsMax: 300n,
      refinanceTargetLoanId: oldLoanId,
      fillMode: 1,
    });
    const tagged = await read(ABIS.offerCancel, 'getOffer', [posted.offerId]);
    check('A6.6', 'the borrower can post a refinance-tagged borrow offer at better terms',
      String(tagged.interestRateBps) === '300' && String(tagged.offerType) === '1',
      `oldLoanId=${oldLoanId} offerId=${posted.offerId} rate ${oldLoan.interestRateBps}bps -> ${tagged.interestRateBps}bps`);

    {
      const activeBefore = (await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address])).map(String);
      const refiHolders = { ...holders, newLenderEOA: outsider.address, newLenderVault: await vaultAddressFor(outsider) };
      const beforeRefi = await snapshot(tokens, refiHolders);
      const accepted = await acceptOffer(posted.offerId, posted.offer, outsider, borrower);
      if (!accepted.ok) cannotContinue('A6.7 refinance accept', accepted.reason);
      const afterRefi = await snapshot(tokens, refiHolders);
      const activeAfter = (await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address])).map(String);
      const opened = activeAfter.filter((id) => !activeBefore.includes(id));
      const closedIds = activeBefore.filter((id) => !activeAfter.includes(id));
      check('A6.7', 'a new lender accepting the tagged offer chains into the refinance — the old loan leaves the borrower\'s active set and exactly one new loan joins it',
        opened.length === 1 && closedIds.length === 1 && closedIds[0] === String(oldLoanId),
        `gas=${accepted.gas} opened=[${opened}] closed=[${closedIds}]`);

      {
        const settled = await read(ABIS.loan, 'getLoanDetails', [oldLoanId]);
        expectEq('A6.8', 'the ORIGINAL loan terminalizes to Repaid — refinance is not an in-place edit',
          settled.status, 1);

        const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
        const newLoanId = active[active.length - 1];
        const fresh = await read(ABIS.loan, 'getLoanDetails', [newLoanId]);
        check('A6.9', 'the replacement is a SEPARATE loan record carrying the new terms',
          newLoanId !== oldLoanId && String(fresh.interestRateBps) === '300' && fresh.lender.toLowerCase() === outsider.address.toLowerCase(),
          `old=${oldLoanId} (${oldLoan.interestRateBps}bps, status ${settled.status}) ` +
          `new=${newLoanId} (${fresh.interestRateBps}bps, status ${fresh.status}, lender ${fresh.lender})`);

        // All FOUR position NFTs must still resolve: the old pair is
        // status-updated, not burned, so the old borrower token stays a
        // redeemable receipt on the original position.
        const tokenIds = [
          ['old lender', settled.lenderTokenId], ['old borrower', settled.borrowerTokenId],
          ['new lender', fresh.lenderTokenId], ['new borrower', fresh.borrowerTokenId],
        ];
        const resolved = [];
        for (const [label, tokenId] of tokenIds) {
          try {
            const owner = await pub.readContract({ address: DIAMOND, abi: ABIS.nft, functionName: 'ownerOf', args: [tokenId] });
            resolved.push(`${label}#${tokenId}=${owner.slice(0, 10)}`);
          } catch {
            resolved.push(`${label}#${tokenId}=BURNED`);
          }
        }
        const distinct = new Set(tokenIds.map(([, id]) => String(id))).size;
        // The money. Spec (refinance, #411): the EXITING lender is repaid
        // principal + the interest due under the loan's interest mode — the
        // FULL term's interest on this full-term loan — with the treasury's
        // fee on that interest; no rate-shortfall top-up. The new lender funds
        // the replacement principal, paying the replacement's loan-initiation
        // fee as any accept does (99% treasury, 1% to the matcher — the new
        // lender, who called accept). The borrower covers the rest from their
        // wallet. This is a carry-over refinance, so no collateral moves.
        const oldInterest = (oldLoan.principal * BigInt(oldLoan.interestRateBps) * BigInt(oldLoan.durationDays)) / (365n * 10_000n);
        const oldCut = (oldInterest * BigInt(oldLoan.treasuryFeeBpsAtInit)) / 10_000n;
        const newLif = (fresh.principal * BigInt(fresh.loanInitiationFeeBpsAtInit)) / 10_000n;
        const toBorrower = fresh.principal - newLif; // net disbursement, applied to the payoff
        expectLedger('A6.7b', 'the refinance moves exactly: the new lender funds the replacement, the old lender receives principal + full-term interest net of the treasury fee, the borrower covers the difference, and no collateral moves',
          beforeRefi, afterRefi, {
            'lending.newLenderEOA': -fresh.principal + newLif / 100n,
            'lending.lenderVault': oldLoan.principal + oldInterest - oldCut,
            'lending.treasury': oldCut + newLif - newLif / 100n,
            'lending.borrowerEOA': -(oldLoan.principal + oldInterest - toBorrower),
          }, `oldInterest=${f18(oldInterest)} newLIF=${f18(newLif)}`);

        check('A6.10', 'a completed refinance leaves FOUR distinct position NFTs, all still resolving',
          distinct === 4 && !resolved.some((r) => r.endsWith('BURNED')),
          resolved.join(' '));
      }
    }
  }
}
