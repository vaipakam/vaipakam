/**
 * A3 — the two forced-close routes.
 *
 * Time-based default (term + grace elapsed) and health-factor liquidation
 * (HF < 1). Both are permissionless, both sell the collateral through a
 * registered swap venue, and both are accounted here to the wei — including
 * the liquidator's bonus, which comes off the top before the lender is paid.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, STATUS, claimAndExpect, delta, dynamicIncentiveBps, expectPosition, forcedCloseWaterfall, lateFee, mint, openLoan, perSecondInterest, positionOf, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { MOCK_ADAPTER_ABI, repriceFaucetAsset, sendAsOwner, setFeedUsd, warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectEq, expectLedger, observe, expectRefusal, requireEnvelope } from '../lib/report.mjs';

const TRY_LIST = [{ adapterIdx: 0n, data: '0x' }];

/**
 * Assert a forced close's EXACT ledger against the spec's waterfall, with
 * every input read from the chain: the dynamic keeper incentive, the
 * handling-charge rate, the loan's stamped treasury fee, the debt accrued by
 * the second to the close block, and the late fee from the loan's own term.
 */
async function expectForcedClose(id, name, loan, receipt, before, after, collateral, lending) {
  const at = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  const start = BigInt(loan.interestAccrualStart || loan.startTime);
  const endTime = BigInt(loan.startTime) + BigInt(loan.durationDays) * 86_400n;
  const sold = before['collateral.borrowerVault'] - after['collateral.borrowerVault'];
  // A forced close sells the WHOLE pledged collateral: checked before `sold`
  // feeds the waterfall, so a partial withdrawal cannot become the baseline
  // every other expectation is derived from.
  check(`${id}.sold`, 'the forced close sells the whole pledged collateral', sold === loan.collateralAmount,
    `sold=${f18(sold)} pledged=${f18(loan.collateralAmount)}`);
  const proceeds = before['lending.venue'] - after['lending.venue'];
  const [handlingBps] = await read(ABIS.config, 'getLiquidationConfig');
  const incentiveBps = await dynamicIncentiveBps(collateral, lending, sold, proceeds);
  const interest = perSecondInterest(loan.principal, loan.interestRateBps, at - start);
  const fee = lateFee(loan.principal, endTime, at);
  const w = forcedCloseWaterfall({
    proceeds, incentiveBps, handlingBps, treasuryFeeBps: loan.treasuryFeeBpsAtInit,
    principal: loan.principal, interest, fee,
  });
  return expectLedger(id, name, before, after, {
    'collateral.borrowerVault': -sold,
    'collateral.venue': sold,
    'lending.venue': -proceeds,
    'lending.liquidator': w.bonus,
    'lending.lenderVault': w.lender,
    'lending.treasury': w.treasury,
    'lending.borrowerVault': w.borrower,
  }, `proceeds=${f18(proceeds)} debt=${f18(loan.principal + interest + fee)} (interest ${f18(interest)} + late fee ${f18(fee)}) incentive=${incentiveBps}bps handling=${handlingBps}bps`);
}

export async function run() {
  const lending = MOCKS.liquidToken2;
  const collateral = MOCKS.liquidToken;
  const venue = MOCKS.mockSwapAdapter;

  const lenderVault = await vaultAddressFor(lender);
  const borrowerVault = await vaultAddressFor(borrower);
  const tokens = { lending, collateral };
  const holders = {
    lenderEOA: lender.address, lenderVault,
    borrowerEOA: borrower.address, borrowerVault,
    diamond: DIAMOND, treasury: TREASURY, venue, liquidator: outsider.address,
  };

  // ---------------------------------------------------------------- default
  const { loanId } = await openLoan({ lender, borrower });
  check('A3.1', 'a healthy in-term loan is not defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === false, `loanId=${loanId}`);

  // The grace window is governance-configurable per term bucket, so the probe
  // is placed RELATIVE to the window the chain reports for this loan —
  // halfway into it — rather than at a fixed offset that a different, valid
  // setting would put on or past the boundary.
  const graceSeconds = Number(await read(ABIS.config, 'getEffectiveGraceSeconds', [loanId]));
  const termDays = Number((await read(ABIS.loan, 'getLoanDetails', [loanId])).durationDays);
  await warpDays(termDays + graceSeconds / 2 / 86_400);
  const dayPast = await read(ABIS.defaulted, 'isLoanDefaultable', [loanId]);
  check('A3.2', 'halfway into this deployment\'s grace window after the term, the loan is NOT defaultable',
    graceSeconds > 0 && dayPast === false,
    `isLoanDefaultable=${dayPast} effectiveGrace=${graceSeconds}s (${graceSeconds / 86400}d), probed at term + ${graceSeconds / 2}s`);

  await warpDays(30);
  check('A3.3', 'past term AND grace, the loan becomes defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === true);

  // A forced close that cannot route the collateral REFUSES rather than
  // guessing a settlement — the try-list has to name an enabled venue.
  const noRoute = await simulate(DIAMOND, ABIS.defaulted, 'triggerDefault', [loanId, []], outsider.address);
  expectRefusal('A3.4', 'a forced close with an empty swap try-list is refused, not silently mis-settled', noRoute, 'NoEnabledSwapRoute');

  // Seed the venue's output float — the mock pays out of its own balance.
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'fund venue');

  const preDefault = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const preDefaultPos = await positionOf(loanId);
  const beforeDefault = await snapshot(tokens, holders);
  const defaultReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.defaulted, functionName: 'triggerDefault', args: [loanId, TRY_LIST] }, 'triggerDefault');
  const afterDefault = await snapshot(tokens, holders);
  const defaulted = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const d = delta(beforeDefault, afterDefault);
  // Status 2 = Defaulted. The whole sale must be accounted: every unit the
  // venue paid out lands with exactly one of the four parties.
  const proceeds = beforeDefault['lending.venue'] - afterDefault['lending.venue'];
  const landed = ['lenderVault', 'borrowerVault', 'treasury', 'liquidator']
    .reduce((acc, k) => acc + (afterDefault[`lending.${k}`] - beforeDefault[`lending.${k}`]), 0n);
  check('A3.5', 'triggerDefault is permissionless — an unrelated third party closes the position, and every unit of the sale is accounted',
    String(defaulted.status) === String(STATUS.Defaulted) && proceeds > 0n && landed === proceeds,
    `caller=outsider gas=${defaultReceipt.gasUsed} status=${defaulted.status} proceeds=${f18(proceeds)} deltas=${JSON.stringify(d)}`);

  // The spec's DYNAMIC keeper incentive (shared by the HF and time-based
  // paths): the max-liquidation-slippage budget minus the slippage actually
  // realized against the oracle, capped by the global incentive cap and any
  // per-asset cap — taken off the top of the proceeds. Not the loan's stamped
  // fallback split, which merely happens to be the same 300 bps here.
  const sold = beforeDefault['collateral.borrowerVault'] - afterDefault['collateral.borrowerVault'];
  const bonus = afterDefault['lending.liquidator'] - beforeDefault['lending.liquidator'];
  const bonusBps = await dynamicIncentiveBps(collateral, lending, sold, proceeds);
  expectEq('A3.6', 'the caller earns the dynamic keeper incentive, taken off the top of the proceeds',
    bonus, (proceeds * bonusBps) / 10_000n, `${bonusBps}bps of ${f18(proceeds)} of swap proceeds`);
  await expectForcedClose('A3.6b', 'the time-based default settles exactly per the spec\'s waterfall: keeper first, lender (net of the treasury fee on recovered interest and late fee), the subordinated handling charge, the borrower\'s residual',
    preDefault, defaultReceipt, beforeDefault, afterDefault, collateral, lending);
  // A forced close sells the WHOLE collateral, so nothing is left to
  // encumber and the lien reads released (amount 0). The recorded collateral
  // amount is the loan's original term and stays as it was on a terminal
  // close; the NFTs stay with their holders, who claim through them next.
  await expectPosition('A3.6c', 'the time-based default changes the position exactly: status Defaulted, the lien released because the whole collateral was sold — NFTs and recorded terms unchanged',
    loanId, preDefaultPos, { status: STATUS.Defaulted, lienReleased: true, lienAmount: 0n });

  // Each side's claim must move exactly the share the default credited to
  // that side's vault out to that side's wallet — both legs, and nothing else
  // (not the Diamond, not the treasury, not the other side). Any collateral
  // the sale did not take goes back with the borrower's claim.
  const unsold = preDefault.collateralAmount - sold;
  let claimPos = await positionOf(loanId);
  for (const [side, fn, acct] of [['lender', 'claimAsLender', lender], ['borrower', 'claimAsBorrower', borrower]]) {
    const credited = afterDefault[`lending.${side}Vault`] - beforeDefault[`lending.${side}Vault`];
    if (credited <= 0n) cannotContinue(`A3.7.${side}`, `the default credited the ${side} nothing to claim`);
    const residual = side === 'borrower' ? unsold : 0n;
    const before = await snapshot(tokens, holders);
    const r = await tx(acct, { address: DIAMOND, abi: ABIS.claim, functionName: fn, args: [loanId] }, fn);
    const after = await snapshot(tokens, holders);
    expectLedger(`A3.7.${side}`, `after a default the ${side} sweeps exactly their credited share, vault → wallet, and nothing else moves`,
      before, after, {
        [`lending.${side}Vault`]: -credited,
        [`lending.${side}EOA`]: credited,
        [`collateral.${side}Vault`]: -residual,
        [`collateral.${side}EOA`]: residual,
      }, `gas=${r.gasUsed} credited=${f18(credited)} unsoldCollateral=${f18(residual)}`);
    // The claim spends that side's receipt; once BOTH sides have claimed the
    // defaulted loan settles (the same closure rule as a repaid one).
    const last = side === 'borrower';
    await expectPosition(`A3.7.${side}.pos`, `after the ${side}'s default claim the position changes exactly: their NFT burned${last ? ', and with both sides claimed the loan Settled' : ''}`,
      loanId, claimPos, { [`${side}NftOwner`]: null, ...(last ? { status: STATUS.Settled } : {}) });
    claimPos = await positionOf(loanId);
  }

  // ------------------------------------------------------- HF liquidation
  const { loanId: hfLoan } = await openLoan({ lender, borrower });
  const openHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  const hfFloor = (await read(ABIS.loan, 'getLoanDetails', [hfLoan])).minHealthFactorAtInit;
  check('A3.8', 'a fresh loan opens at or above its stamped initiation floor', openHf >= hfFloor,
    `loanId=${hfLoan} HF=${f18(openHf)}`);

  // The 1.5 floor binds at INITIATION; liquidation binds at 1.0. Prove the
  // gap with the pool moving WITH its feed, so the collateral stays routable
  // and the only thing that can refuse is the health-factor guard itself —
  // required by name, since a feed-only move would let the later illiquidity
  // refusal keep this row green with the HF guard removed.
  const tliq = {
    asset: collateral, feed: MOCKS.liquidTokenUsdFeed, pool: MOCKS.liquidTokenWethPool,
    quote: '0x4200000000000000000000000000000000000006',
  };
  // The probe price is DERIVED, not fixed: the collateral price that puts HF
  // midway between 1.0 and this loan's stamped floor, from the loan's own
  // stamped liquidation LTV and the live debt-asset price. A fixed price is
  // only in the band for one configuration of those knobs.
  const hfLoanDetails = await read(ABIS.loan, 'getLoanDetails', [hfLoan]);
  const [dP, dD] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
  const debtUsd = (hfLoanDetails.principal * dP) / 10n ** BigInt(dD);
  const targetHf = (10n ** 18n + hfFloor) / 2n;
  const probePrice = (targetHf * debtUsd * 10_000n) / (BigInt(hfLoanDetails.liquidationLtvBpsAtInit) * hfLoanDetails.collateralAmount);
  await repriceFaucetAsset(tliq, Number(probePrice) / 1e18);
  const midHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  const midRoutable = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  const midSim = await simulate(DIAMOND, ABIS.risk, 'triggerLiquidation', [hfLoan, TRY_LIST], outsider.address);
  // In band by construction; routable only if the seeded pool carries the
  // move — which is the file's envelope, not a protocol property.
  requireEnvelope('seeded pool depth', Number(midRoutable) === 0,
    `at the derived probe price $${f18(probePrice)} the collateral reads Illiquid (checkLiquidity=${midRoutable})`);
  check('A3.9a', 'the probe position sits below the stamped initiation floor but above 1.0',
    midHf < hfFloor && midHf >= 1_000_000_000_000_000_000n,
    `HF=${f18(midHf)} (target ${f18(targetHf)}, floor ${f18(hfFloor)}) at collateral $${f18(probePrice)} checkLiquidity=${midRoutable}`);
  expectRefusal('A3.9', 'below the stamped initiation floor but above 1.0 the position is NOT liquidatable', midSim, 'HealthFactorNotLow');
  await repriceFaucetAsset(tliq, 2000);

  // A FEED-ONLY reprice, for contrast. The faucet's mock v3 pool keeps its
  // seeded spot, and the oracle only counts a pool whose spot agrees with
  // the feed within the TWAP-consistency band — so a feed-only move past the
  // band leaves no consistent pool and the asset reads Illiquid. It is not a
  // depth limit (#2314 first said it was); A3.13 moves the pool with the
  // feed and the route stays open.
  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 1940);
  const depthAfterCrash = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  observe('A3.10', 'a FEED-ONLY reprice past the pool-consistency band flips the asset Illiquid (the mock pool\'s spot does not follow the feed)',
    `checkLiquidity(collateral) after a feed-only 3% move to $1,940 = ${depthAfterCrash} (0=Liquid, 1=Illiquid) — while Illiquid, the HF-swap route refuses`);
  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 2000);

  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 2000);
  await setFeedUsd(MOCKS.liquidToken2UsdFeed, 2.5);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [lending, 250_000_000n]);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [collateral, 200_000_000_000n]);
  const lowHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  const routable = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  check('A3.11', 'repricing the DEBT asset upward drives HF below 1 while the collateral stays routable',
    lowHf < 1_000_000_000_000_000_000n && Number(routable) === 0, `HF=${f18(lowHf)} checkLiquidity(collateral)=${routable}`);

  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'top up venue');
  const preLiq = await read(ABIS.loan, 'getLoanDetails', [hfLoan]);
  const preLiqPos = await positionOf(hfLoan);
  const beforeLiq = await snapshot(tokens, holders);
  const liqReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.risk, functionName: 'triggerLiquidation', args: [hfLoan, TRY_LIST] }, 'triggerLiquidation');
  const afterLiq = await snapshot(tokens, holders);
  const liquidated = await read(ABIS.loan, 'getLoanDetails', [hfLoan]);
  const liqProceeds = beforeLiq['lending.venue'] - afterLiq['lending.venue'];
  const liqLanded = ['lenderVault', 'borrowerVault', 'treasury', 'liquidator']
    .reduce((acc, k) => acc + (afterLiq[`lending.${k}`] - beforeLiq[`lending.${k}`]), 0n);
  check('A3.12', 'HF<1 liquidation is permissionless, ends the loan Defaulted, and settles from the swap proceeds, every unit accounted',
    String(liquidated.status) === String(STATUS.Defaulted) && liqProceeds > 0n && liqLanded === liqProceeds,
    `caller=outsider gas=${liqReceipt.gasUsed} status=${liquidated.status} proceeds=${f18(liqProceeds)}`);
  await expectForcedClose('A3.12b', 'the underwater HF liquidation settles exactly per the waterfall: keeper first, the lender takes the rest and the loss, no handling charge',
    preLiq, liqReceipt, beforeLiq, afterLiq, collateral, lending);
  await expectPosition('A3.12c', 'the HF liquidation changes the position exactly: status Defaulted, the lien released because the whole collateral was sold — NFTs and recorded terms unchanged',
    hfLoan, preLiqPos, { status: STATUS.Defaulted, lienReleased: true, lienAmount: 0n });

  // The HF path writes its OWN claim records (RiskFacet, not DefaultedFacet),
  // so its claims are exercised in their own right. Underwater: the lender
  // was credited everything after the keeper, the borrower nothing.
  {
    const lenderCredit = afterLiq['lending.lenderVault'] - beforeLiq['lending.lenderVault'];
    const borrowerCredit = afterLiq['lending.borrowerVault'] - beforeLiq['lending.borrowerVault'];
    await claimAndExpect({
      id: 'A3.12d', who: 'lender', account: lender, fn: 'claimAsLender', loanId: hfLoan, tokens, holders,
      before: await positionOf(hfLoan),
      moves: { 'lending.lenderVault': -lenderCredit, 'lending.lenderEOA': lenderCredit },
      // The borrower has nothing to claim, so the lender's claim is the LAST
      // one and settles the loan; the borrower's NFT is left as it was.
      changes: { lenderNftOwner: null, status: STATUS.Settled },
    });
    check('A3.12e', 'an underwater HF liquidation credits the borrower nothing', borrowerCredit === 0n, `borrowerCredit=${f18(borrowerCredit)}`);
  }

  // leave the fork on the deployment's seeded prices
  await setFeedUsd(MOCKS.liquidToken2UsdFeed, 1);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [lending, 100_000_000n]);

  // ------------------------------- HF liquidation by a COLLATERAL drawdown
  // The scenario an operator naturally reaches for, which the feed-only
  // reprice above cannot reach: the collateral falls 55%, the pool moves
  // with its feed as a real market would, the asset stays routable, and the
  // position is liquidated from the collateral side.
  const { loanId: crashLoan } = await openLoan({ lender, borrower });
  await repriceFaucetAsset(tliq, 900);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [collateral, 90_000_000_000n]);
  const crashHf = await read(ABIS.risk, 'calculateHealthFactor', [crashLoan]);
  const stillRoutable = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'top up venue');
  const preCrash = await read(ABIS.loan, 'getLoanDetails', [crashLoan]);
  const preCrashPos = await positionOf(crashLoan);
  const beforeCrash = await snapshot(tokens, holders);
  const crashReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.risk, functionName: 'triggerLiquidation', args: [crashLoan, TRY_LIST] }, 'triggerLiquidation(collateral drawdown)');
  const afterCrash = await snapshot(tokens, holders);
  const crashed = await read(ABIS.loan, 'getLoanDetails', [crashLoan]);
  const crashProceeds = beforeCrash['lending.venue'] - afterCrash['lending.venue'];
  const crashLanded = ['lenderVault', 'borrowerVault', 'treasury', 'liquidator']
    .reduce((acc, k) => acc + (afterCrash[`lending.${k}`] - beforeCrash[`lending.${k}`]), 0n);
  check('A3.13', 'a 55% collateral drawdown with the pool following its feed keeps the asset routable, and HF<1 liquidation settles from the collateral side',
    Number(stillRoutable) === 0 && crashHf < 1_000_000_000_000_000_000n && String(crashed.status) === String(STATUS.Defaulted) &&
    crashProceeds > 0n && crashLanded === crashProceeds,
    `tLIQ $2,000 -> $900 (feed + pool spot) checkLiquidity=${stillRoutable} HF=${f18(crashHf)} gas=${crashReceipt.gasUsed} ` +
    `status=${crashed.status} proceeds=${f18(crashProceeds)}`);
  await expectForcedClose('A3.13b', 'the collateral-drawdown liquidation settles exactly per the waterfall, with a surplus: keeper, lender net of the interest fee, the handling charge, the borrower\'s residual',
    preCrash, crashReceipt, beforeCrash, afterCrash, collateral, lending);
  await expectPosition('A3.13c', 'the drawdown liquidation changes the position exactly: status Defaulted, the lien released because the whole collateral was sold — NFTs and recorded terms unchanged',
    crashLoan, preCrashPos, { status: STATUS.Defaulted, lienReleased: true, lienAmount: 0n });

  // With a surplus, both sides have a claim; with both claimed the loan settles.
  {
    const lenderCredit = afterCrash['lending.lenderVault'] - beforeCrash['lending.lenderVault'];
    const borrowerCredit = afterCrash['lending.borrowerVault'] - beforeCrash['lending.borrowerVault'];
    let pos = await positionOf(crashLoan);
    pos = await claimAndExpect({
      id: 'A3.13d', who: 'lender', account: lender, fn: 'claimAsLender', loanId: crashLoan, tokens, holders, before: pos,
      moves: { 'lending.lenderVault': -lenderCredit, 'lending.lenderEOA': lenderCredit },
      changes: { lenderNftOwner: null },
    });
    await claimAndExpect({
      id: 'A3.13e', who: 'borrower', account: borrower, fn: 'claimAsBorrower', loanId: crashLoan, tokens, holders, before: pos,
      moves: { 'lending.borrowerVault': -borrowerCredit, 'lending.borrowerEOA': borrowerCredit },
      changes: { borrowerNftOwner: null, status: STATUS.Settled },
    });
  }
}
