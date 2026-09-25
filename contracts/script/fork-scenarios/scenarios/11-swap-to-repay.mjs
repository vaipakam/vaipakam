/**
 * A11 — repaying with the collateral itself.
 *
 * Swap-to-repay lets a borrower settle without holding the principal asset:
 * the protocol sells collateral for principal and repays in one transaction.
 * That makes it the one repayment path that SELLS the borrower's collateral
 * voluntarily, so the checks that matter are the ones bounding the sale —
 * the caller caps how much collateral may be taken, a partial swap may not
 * leave the position less healthy than before, and only the borrower may
 * start it.
 */
import { DIAMOND, ERC20, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, delta, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectEq, expectLedger, expectRefusal } from '../lib/report.mjs';

const TRY_LIST = [{ adapterIdx: 0n, data: '0x' }];

export async function run() {
  const lending = MOCKS.liquidToken2;
  const collateral = MOCKS.liquidToken;
  const venue = MOCKS.mockSwapAdapter;
  await tx(outsider, { address: lending, abi: ERC20, functionName: 'mint', args: [venue, parseUnits('10000000', 18)] }, 'fund venue');

  const tokens = { lending, collateral };
  const holders = {
    lenderEOA: lender.address, lenderVault: await vaultAddressFor(lender),
    borrowerEOA: borrower.address, borrowerVault: await vaultAddressFor(borrower),
    treasury: TREASURY, venue, diamond: DIAMOND,
  };

  // --------------------------------------------------------------- full
  {
    // No wallet allowance: every unit that repays this loan must come from
    // the collateral sale, or the close reverts.
    const { loanId } = await openLoan({ lender, borrower, borrowerCanRepayFromWallet: false });
    const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);

    const impostor = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, TRY_LIST, loan.collateralAmount], outsider.address);
    expectRefusal('A11.1', 'only the borrower can sell their own collateral to repay', impostor, 'NotNFTOwner');

    const overCap = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, TRY_LIST, loan.collateralAmount + 1n], borrower.address);
    expectRefusal('A11.2', 'a collateral cap larger than the collateral held is refused', overCap, 'InvalidAmount');

    const noRoute = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, [], loan.collateralAmount], borrower.address);
    expectRefusal('A11.3', 'with no swap route, the repayment is refused rather than attempted', noRoute, 'NoEnabledSwapRoute');

    // A TIGHT cap: 0.6 collateral ($1,200) against ≈$1,001 of debt. The cap
    // is what the caller lets the protocol take, so this is the case that
    // shows whether it sells the cap or only what the debt needs.
    const CAP = parseUnits('0.6', 18);
    const before = await snapshot(tokens, holders);
    const sim = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, TRY_LIST, CAP], borrower.address);
    if (!sim.ok) cannotContinue('A11.4 full swap-to-repay', sim.name);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.swapToRepay, functionName: 'swapToRepayFull', args: [loanId, TRY_LIST, CAP] }, 'swapToRepayFull');
    const after = await snapshot(tokens, holders);
    const closed = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    const d = delta(before, after);
    check('A11.4', 'a full swap-to-repay closes the loan in ONE transaction, from collateral alone — the borrower\'s wallet is never debited',
      String(closed.status) === String(STATUS.Repaid) && after['lending.borrowerEOA'] >= before['lending.borrowerEOA'],
      `gas=${receipt.gasUsed} status=${closed.status} deltas=${JSON.stringify(d)}`);

    // The oracle is the spec, per the owner's #2317 decision (2026-09-25):
    // `maxCollateralIn` is an UPPER BOUND and the sale is sized to the debt,
    // so collateral the debt does not need stays pledged. The live bytecode
    // this was first run against sells the whole cap, so this row FAILS
    // there until the #2317 fix is deployed — which is the point of it.
    const sold = before['collateral.borrowerVault'] - after['collateral.borrowerVault'];
    check('A11.5', 'the protocol sells only what the debt needs — the cap is an upper bound, not the sale size (#2317)',
      sold < CAP,
      `cap=${f18(CAP)} sold=${f18(sold)} of ${f18(loan.collateralAmount)}`);

    // Everything the sale raised is accounted: the debt to lender + treasury,
    // the surplus to the borrower's WALLET as the principal asset.
    const raised = before['lending.venue'] - after['lending.venue'];
    const toDebt = (after['lending.lenderVault'] - before['lending.lenderVault']) + (after['lending.treasury'] - before['lending.treasury']);
    const surplus = after['lending.borrowerEOA'] - before['lending.borrowerEOA'];
    expectEq('A11.6', 'the sale is accounted to the wei — debt to lender + treasury, the surplus to the borrower as principal asset',
      raised, toDebt + surplus, `raised=${f18(raised)} debt=${f18(toDebt)} surplusToWallet=${f18(surplus)}`);

    // What was NOT sold is still the borrower's collateral, released to claim.
    const lien = await read(ABIS.metrics, 'getLoanCollateralLien', [loanId]);
    check('A11.6b', 'collateral the sale did not take stays in the borrower\'s vault, still liened for the claim',
      !lien.released && lien.amount === loan.collateralAmount - sold,
      `unsold=${f18(loan.collateralAmount - sold)} lien.amount=${f18(lien.amount)} lien.released=${lien.released}`);
  }

  // ------------------------------------------------------------- partial
  {
    const { loanId: noPartial } = await openLoan({ lender, borrower, borrowerCanRepayFromWallet: false });
    const refused = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayPartial', [noPartial, parseUnits('0.1', 18), TRY_LIST], borrower.address);
    expectRefusal('A11.7', 'a partial swap on a loan that never allowed partial repayment is refused', refused, 'PartialRepayNotAllowed');

    const { loanId } = await openLoan({ lender, borrower, allowsPartialRepay: true, borrowerCanRepayFromWallet: false });
    const hfBefore = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
    const loanBefore = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    const sim = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayPartial', [loanId, parseUnits('0.1', 18), TRY_LIST], borrower.address);
    if (!sim.ok) cannotContinue('A11.8 partial swap-to-repay', sim.name);
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.swapToRepay, functionName: 'swapToRepayPartial', args: [loanId, parseUnits('0.1', 18), TRY_LIST] }, 'swapToRepayPartial');
    const after = await snapshot(tokens, holders);
    const hfAfter = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
    const loanAfter = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    // The money: the venue's proceeds for exactly 0.1 collateral go to the
    // lender (interest accrued so far — whole days, rounded down — then
    // principal), the treasury's fee on the interest part only, and the
    // principal falls by exactly the proceeds' principal part.
    const SOLD = parseUnits('0.1', 18);
    const psProceeds = before['lending.venue'] - after['lending.venue'];
    const psAt = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const psDays = (psAt - BigInt(loanBefore.startTime)) / 86_400n;
    const psInterest = (loanBefore.principal * BigInt(loanBefore.interestRateBps) * psDays) / (365n * 10_000n);
    const psCut = (psInterest * BigInt(loanBefore.treasuryFeeBpsAtInit)) / 10_000n;
    check('A11.8', 'a partial swap sells exactly 0.1 collateral, reduces principal by the proceeds net of accrued interest, and the loan stays Active',
      String(loanAfter.status) === '0' && loanBefore.principal - loanAfter.principal === psProceeds - psInterest,
      `gas=${receipt.gasUsed} principal ${f18(loanBefore.principal)} -> ${f18(loanAfter.principal)} proceeds=${f18(psProceeds)} interest=${f18(psInterest)}`);
    expectLedger('A11.8b', 'the partial swap moves exactly: 0.1 collateral to the venue, the proceeds to the lender net of the treasury\'s fee on the interest part',
      before, after, {
        'collateral.borrowerVault': -SOLD,
        'collateral.venue': SOLD,
        'lending.venue': -psProceeds,
        'lending.lenderEOA': psProceeds - psCut,
        'lending.treasury': psCut,
      });
    check('A11.9', 'a partial swap never leaves the position LESS healthy than it was',
      hfAfter >= hfBefore, `HF ${f18(hfBefore)} -> ${f18(hfAfter)}`);
  }
}
