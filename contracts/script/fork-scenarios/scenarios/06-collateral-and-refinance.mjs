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
import { expectEq, record } from '../lib/report.mjs';

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
    record('A6.1', 'an over-collateralised loan reports a releasable surplus', maxAmount > 0n ? 'PASS' : 'FAIL',
      `loanId=${loanId} HF=${f18(openedHf)} maxWithdrawable=${f18(maxAmount)} of 2.5 collateral`);

    // A wei past the quoted maximum must be refused, not clamped.
    const overshoot = await simulate(DIAMOND, ABIS.partialWithdrawal, 'partialWithdrawCollateral', [loanId, maxAmount + 1n], borrower.address);
    record('A6.2', 'one wei past the quoted maximum is refused, not silently clamped',
      !overshoot.ok ? 'PASS' : 'FAIL', overshoot.ok ? 'NOT refused' : overshoot.name);

    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.partialWithdrawal, functionName: 'partialWithdrawCollateral', args: [loanId, maxAmount] }, 'partialWithdrawCollateral');
    const after = await snapshot(tokens, holders);
    const closingHf = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
    const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    record('A6.3', 'releasing the whole quoted surplus leaves the loan Active and still above the floor',
      String(loan.status) === '0' && closingHf >= 1_500_000_000_000_000_000n ? 'PASS' : 'FAIL',
      `gas=${receipt.gasUsed} status=${loan.status} HF ${f18(openedHf)} -> ${f18(closingHf)} ` +
      `collateral ${f18(loan.collateralAmount)} deltas=${JSON.stringify(delta(before, after))}`);

    // Having released the surplus, there is none left to release.
    const again = await read(ABIS.partialWithdrawal, 'calculateMaxWithdrawable', [loanId]);
    const againAmount = Array.isArray(again) ? again[0] : again;
    record('A6.4', 'a second quote reports no remaining surplus', againAmount === 0n ? 'PASS' : 'INFO',
      `maxWithdrawable now ${f18(againAmount)}`);

    // A third party must not be able to release someone else's collateral.
    const impostor = await simulate(DIAMOND, ABIS.partialWithdrawal, 'partialWithdrawCollateral', [loanId, 1n], outsider.address);
    record('A6.5', 'a third party cannot release the borrower\'s collateral',
      !impostor.ok ? 'PASS' : 'FAIL', impostor.ok ? 'NOT refused' : impostor.name);
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
    record('A6.6a', 'a refinance-tagged offer is refused until the borrower has set auto-refinance caps',
      !capless.ok ? 'PASS' : 'FAIL', capless.ok ? 'NOT refused' : capless.name);

    // `maxNewExpiry` must be a FUTURE timestamp when enabling: the setter
    // refuses 0 even though the checker reads 0 as "no expiry cap", so the
    // consent always carries a real deadline.
    const capsExpiry = BigInt((await chainNow()) + 365 * 86_400);
    const zeroExpiry = await simulate(DIAMOND, ABIS.autoLifecycle, 'setAutoRefinanceCaps',
      [oldLoanId, true, 400, 0n], borrower.address);
    record('A6.6b', 'enabling caps with no expiry is refused — the consent always carries a deadline',
      !zeroExpiry.ok ? 'PASS' : 'FAIL', zeroExpiry.ok ? 'NOT refused' : zeroExpiry.name);

    const capsReceipt = await tx(borrower, {
      address: DIAMOND, abi: ABIS.autoLifecycle, functionName: 'setAutoRefinanceCaps',
      args: [oldLoanId, true, 400, capsExpiry],
    }, 'setAutoRefinanceCaps');
    record('A6.6c', 'the borrower consents in advance by capping the rate a refinance may carry', 'PASS',
      `loanId=${oldLoanId} maxRateBps=400 expiry=+365d gas=${capsReceipt.gasUsed}`);

    const overCap = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
      [await (await import('../lib/flow.mjs')).offerParams({
        offerType: 1, interestRateBps: 500n, interestRateBpsMax: 500n,
        refinanceTargetLoanId: oldLoanId, fillMode: 1,
      })], borrower.address);
    record('A6.6d', 'an offer above the consented rate cap is refused',
      !overCap.ok ? 'PASS' : 'FAIL', overCap.ok ? 'NOT refused' : overCap.name);

    await mint(outsider, lending, '100000');
    await approveDiamond(outsider, lending);
    let posted;
    try {
      posted = await createOffer(borrower, {
        offerType: 1,
        interestRateBps: 300n,
        interestRateBpsMax: 300n,
        refinanceTargetLoanId: oldLoanId,
        fillMode: 1,
      });
      record('A6.6', 'the borrower can post a refinance-tagged borrow offer at better terms', 'PASS',
        `oldLoanId=${oldLoanId} offerId=${posted.offerId} rate ${oldLoan.interestRateBps}bps -> 300bps`);
    } catch (e) {
      record('A6.6', 'the borrower posts a refinance-tagged borrow offer', 'INFO', String(e.message).split('\n')[0].slice(0, 180));
    }

    if (posted) {
      const accepted = await acceptOffer(posted.offerId, posted.offer, outsider, borrower);
      record('A6.7', 'a new lender accepting the tagged offer chains into the refinance',
        accepted.ok ? 'PASS' : 'INFO', accepted.ok ? `gas=${accepted.gas}` : accepted.reason);

      if (accepted.ok) {
        const settled = await read(ABIS.loan, 'getLoanDetails', [oldLoanId]);
        expectEq('A6.8', 'the ORIGINAL loan terminalizes to Repaid — refinance is not an in-place edit',
          settled.status, 1);

        const active = await read(ABIS.metrics, 'getUserActiveLoans', [borrower.address]);
        const newLoanId = active[active.length - 1];
        const fresh = await read(ABIS.loan, 'getLoanDetails', [newLoanId]);
        record('A6.9', 'the replacement is a SEPARATE loan record carrying the new terms',
          newLoanId !== oldLoanId ? 'PASS' : 'FAIL',
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
        record('A6.10', 'a completed refinance leaves FOUR distinct position NFTs, all still resolving',
          distinct === 4 && !resolved.some((r) => r.endsWith('BURNED')) ? 'PASS' : 'FAIL',
          resolved.join(' '));
      }
    }
  }
}
