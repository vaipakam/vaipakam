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
import { DIAMOND, ERC20, MOCKS, TREASURY, VENUE_ROUTE, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, claimAndExpect, delta, expectPosition, openLoan, positionOf, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectLedger, expectRefusal, requireEnvelope } from '../lib/report.mjs';

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

    const impostor = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, VENUE_ROUTE, loan.collateralAmount], outsider.address);
    expectRefusal('A11.1', 'only the borrower can sell their own collateral to repay', impostor, 'NotNFTOwner');

    const overCap = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, VENUE_ROUTE, loan.collateralAmount + 1n], borrower.address);
    expectRefusal('A11.2', 'a collateral cap larger than the collateral held is refused', overCap, 'InvalidAmount');

    const noRoute = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, [], loan.collateralAmount], borrower.address);
    expectRefusal('A11.3', 'with no swap route, the repayment is refused rather than attempted', noRoute, 'NoEnabledSwapRoute');

    // The debt, fixed before the sale from the payoff quote (principal + the
    // term's interest; no late fee in term) and split by the loan's stamped
    // treasury fee — independent of how much collateral the sale takes.
    const quoted = await read(ABIS.repay, 'calculateRepaymentAmount', [loanId]);
    const payoff = Array.isArray(quoted) ? quoted[0] : quoted;
    const interestDue = payoff - loan.principal;
    const interestCut = (interestDue * BigInt(loan.treasuryFeeBpsAtInit)) / 10_000n;
    // "Only what the debt needs", computed INDEPENDENTLY from live prices: the
    // least collateral whose worst-case proceeds — the oracle value less the
    // borrower-facing swap-to-repay slippage cap — cover the payoff.
    const [cP, cD] = await read(ABIS.oracle, 'getAssetPrice', [collateral]);
    const [pP, pD] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
    const slipBps = BigInt(await read(ABIS.config, 'getMaxSwapToRepaySlippageBps'));
    // Token decimals enter the conversion as well as feed decimals, so the
    // figure stays right for a collateral and lending asset of different
    // decimals (the faucet pair happens to share 18).
    const decimalsOf = async (token) => BigInt(await pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }));
    const [cTok, pTok] = [await decimalsOf(collateral), await decimalsOf(lending)];
    const num = payoff * pP * 10n ** BigInt(cD) * 10n ** cTok * 10_000n;
    const den = cP * 10n ** BigInt(pD) * 10n ** pTok * (10_000n - slipBps);
    const debtSized = (num + den - 1n) / den;
    // The cap is DERIVED too: midway between what the debt needs and all the
    // collateral — generous enough that "sell the cap" and "sell only what the
    // debt needs" differ, covering the debt at the worst case the slippage cap
    // allows under whatever the live prices are. A deployment whose collateral
    // cannot cover the debt at that worst case does not run this probe.
    requireEnvelope('swap-to-repay coverage', debtSized < loan.collateralAmount,
      `the payoff needs ${f18(debtSized)} collateral at the worst case, more than the ${f18(loan.collateralAmount)} pledged`);
    const CAP = (debtSized + loan.collateralAmount) / 2n;
    const fullPos = await positionOf(loanId);
    const before = await snapshot(tokens, holders);
    const sim = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayFull', [loanId, VENUE_ROUTE, CAP], borrower.address);
    if (!sim.ok) cannotContinue('A11.4 full swap-to-repay', sim.name);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.swapToRepay, functionName: 'swapToRepayFull', args: [loanId, VENUE_ROUTE, CAP] }, 'swapToRepayFull');
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
    //
    // "Only what the debt needs" is computed INDEPENDENTLY, not read back: the
    // least collateral whose worst-case proceeds — the oracle value less the
    // borrower-facing swap-to-repay slippage cap — cover the debt (the payoff,
    // fixed before the sale). A sale merely below the cap, e.g. cap − 1 wei,
    // is not that. The tolerance covers only the integer rounding of the
    // oracle conversion (a few wei in 1e18).
    const sold = before['collateral.borrowerVault'] - after['collateral.borrowerVault'];
    const tolerance = debtSized / 1_000_000_000_000n + 10n;
    const off = sold > debtSized ? sold - debtSized : debtSized - sold;
    check('A11.5', 'the protocol sells only what the debt needs — the least collateral whose slippage-capped oracle floor covers the payoff; the cap is an upper bound, not the sale size (#2317)',
      off <= tolerance,
      `sold=${f18(sold)} debtSized=${f18(debtSized)} (payoff ${f18(payoff)} at ${slipBps}bps worst case) cap=${f18(CAP)} of ${f18(loan.collateralAmount)}`);

    // Everything the sale raised is accounted, EACH recipient against its own
    // expectation: the lender's vault gets principal + interest net of the
    // treasury's fee, the treasury exactly that fee, the borrower's WALLET the
    // surplus as principal asset. Only the sale's size — what #2317 changes —
    // is read from the chain; the debt split is not.
    const raised = before['lending.venue'] - after['lending.venue'];
    expectLedger('A11.6', 'the full swap settles exactly: principal + interest net of the treasury fee to the lender\'s vault, the fee to the treasury, the surplus to the borrower\'s wallet',
      before, after, {
        'collateral.borrowerVault': -sold,
        'collateral.venue': sold,
        'lending.venue': -raised,
        'lending.lenderVault': payoff - interestCut,
        'lending.treasury': interestCut,
        'lending.borrowerEOA': raised - payoff,
      }, `payoff=${f18(payoff)} interest=${f18(interestDue)} raised=${f18(raised)} surplusToWallet=${f18(raised - payoff)}`);

    await expectPosition('A11.6c', 'the full swap changes the position exactly: status Repaid, the lien down to the unsold collateral — NFTs and recorded terms unchanged',
      loanId, fullPos, { status: STATUS.Repaid, lienAmount: fullPos.lienAmount - sold });

    // What was NOT sold is still the borrower's collateral, released to claim.
    const lien = await read(ABIS.metrics, 'getLoanCollateralLien', [loanId]);
    check('A11.6b', 'collateral the sale did not take stays in the borrower\'s vault, still liened for the claim',
      !lien.released && lien.amount === loan.collateralAmount - sold,
      `unsold=${f18(loan.collateralAmount - sold)} lien.amount=${f18(lien.amount)} lien.released=${lien.released}`);

    // …and the claim actually pays it out. Both sides then claim: the
    // borrower the unsold collateral, the lender the repayment credited to
    // their vault; with both claimed the loan settles.
    const unsold = loan.collateralAmount - sold;
    let pos = await positionOf(loanId);
    pos = await claimAndExpect({
      id: 'A11.6d', who: 'borrower', account: borrower, fn: 'claimAsBorrower', loanId, tokens, holders, before: pos,
      moves: { 'collateral.borrowerVault': -unsold, 'collateral.borrowerEOA': unsold },
      changes: { borrowerNftOwner: null, lienReleased: true, lienAmount: 0n },
    });
    await claimAndExpect({
      id: 'A11.6e', who: 'lender', account: lender, fn: 'claimAsLender', loanId, tokens, holders, before: pos,
      moves: { 'lending.lenderVault': -(payoff - interestCut), 'lending.lenderEOA': payoff - interestCut },
      changes: { lenderNftOwner: null, status: STATUS.Settled },
    });
  }

  // ------------------------------------------------------------- partial
  {
    const { loanId: noPartial } = await openLoan({ lender, borrower, borrowerCanRepayFromWallet: false });
    const refused = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayPartial', [noPartial, parseUnits('0.1', 18), VENUE_ROUTE], borrower.address);
    expectRefusal('A11.7', 'a partial swap on a loan that never allowed partial repayment is refused', refused, 'PartialRepayNotAllowed');

    const { loanId } = await openLoan({ lender, borrower, allowsPartialRepay: true, borrowerCanRepayFromWallet: false });
    // The probe sells a fixed 0.1 collateral. Its principal reduction must
    // clear the asset's governed minimum partial, so the envelope is checked
    // against the oracle value of that sale at the worst the slippage cap
    // allows — a deployment whose floor is higher does not run this probe.
    {
      const probe = await read(ABIS.loan, 'getLoanDetails', [loanId]);
      const { minPartialBps } = await read(ABIS.config, 'getAssetRiskParams', [lending]);
      const minPart = (probe.principal * BigInt(minPartialBps)) / 10_000n;
      const [cP, cD] = await read(ABIS.oracle, 'getAssetPrice', [collateral]);
      const [pP, pD] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
      const slipBps = BigInt(await read(ABIS.config, 'getMaxSwapToRepaySlippageBps'));
      const worst = (parseUnits('0.1', 18) * cP * 10n ** BigInt(pD) * (10_000n - slipBps)) / (pP * 10n ** BigInt(cD) * 10_000n);
      requireEnvelope('minPartialBps', worst >= minPart,
        `selling 0.1 collateral yields at worst ${f18(worst)}, below the asset's minimum partial ${f18(minPart)} (${minPartialBps} bps)`);
    }
    const hfBefore = await read(ABIS.risk, 'calculateHealthFactor', [loanId]);
    const loanBefore = await read(ABIS.loan, 'getLoanDetails', [loanId]);
    const partialPos = await positionOf(loanId);
    const sim = await simulate(DIAMOND, ABIS.swapToRepay, 'swapToRepayPartial', [loanId, parseUnits('0.1', 18), VENUE_ROUTE], borrower.address);
    if (!sim.ok) cannotContinue('A11.8 partial swap-to-repay', sim.name);
    const before = await snapshot(tokens, holders);
    const receipt = await tx(borrower, { address: DIAMOND, abi: ABIS.swapToRepay, functionName: 'swapToRepayPartial', args: [loanId, parseUnits('0.1', 18), VENUE_ROUTE] }, 'swapToRepayPartial');
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
    // The recorded collateral and its lien fall by exactly what was sold, so
    // risk math and a later claim never stand on collateral that has left.
    await expectPosition('A11.8c', 'the partial swap changes the position exactly: principal down by the principal repaid, recorded collateral and lien both down by the 0.1 sold, the accrual clock restarted',
      loanId, partialPos, {
        principal: partialPos.principal - (psProceeds - psInterest),
        collateralAmount: partialPos.collateralAmount - SOLD, lienAmount: partialPos.lienAmount - SOLD,
        interestAccrualStart: psAt, // the accrued interest is paid, so the clock restarts here
      });
    check('A11.9', 'a partial swap never leaves the position LESS healthy than it was',
      hfAfter >= hfBefore, `HF ${f18(hfBefore)} -> ${f18(hfAfter)}`);
  }
}
