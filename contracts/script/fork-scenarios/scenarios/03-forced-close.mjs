/**
 * A3 — the two forced-close routes.
 *
 * Time-based default (term + grace elapsed) and health-factor liquidation
 * (HF < 1). Both are permissionless, both sell the collateral through a
 * registered swap venue, and both are accounted here to the wei — including
 * the liquidator's bonus, which comes off the top before the lender is paid.
 *
 * #2796 — a forced sale sells only what settling the loan needs. Each close
 * quotes the amount from the contract's published plan (`previewForcedSale`)
 * and the rows assert that exactly that much was sold, that the rest stays
 * pledged in the borrower's vault, and that it goes back with the borrower's
 * claim.
 */
import { DIAMOND, MOCKS, TREASURY, VENUE_ROUTE, WETH, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, FORCED_SALE_KIND, STATUS, claimAndExpect, forcedSaleQuote, delta, dynamicIncentiveBps, expectPosition, forcedCloseWaterfall, lateFee, mint, openLoan, perSecondInterest, positionOf, read, snapshot, vaultAddressFor, bothNfts, NFT_STATUS } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { MOCK_ADAPTER_ABI, repriceFaucetAsset, sendAsOwner, setFeedUsd, warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectEq, expectLedger, observe, expectRefusal, requireEnvelope } from '../lib/report.mjs';


/**
 * Assert a forced close's EXACT ledger against the spec's waterfall, with
 * every input read from the chain: the dynamic keeper incentive, the
 * handling-charge rate, the loan's stamped treasury fee, the debt accrued by
 * the second to the close block, and the late fee from the loan's own term.
 */
async function expectForcedClose(id, name, loan, receipt, before, after, collateral, lending, quoted) {
  const at = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  const start = BigInt(loan.interestAccrualStart || loan.startTime);
  const endTime = BigInt(loan.startTime) + BigInt(loan.durationDays) * 86_400n;
  const sold = before['collateral.borrowerVault'] - after['collateral.borrowerVault'];
  // A forced close sells EXACTLY the amount it was quoted (#2796): checked
  // before `sold` feeds the waterfall, so an over- or under-sale cannot
  // become the baseline every other expectation is derived from.
  check(`${id}.sold`, 'the forced close sells exactly the quoted amount and leaves the rest pledged', sold === quoted,
    `sold=${f18(sold)} quoted=${f18(quoted)} pledged=${f18(loan.collateralAmount)}`);
  const proceeds = before['lending.venue'] - after['lending.venue'];
  const [handlingBps] = await read(ABIS.config, 'getLiquidationConfig');
  const incentiveBps = await dynamicIncentiveBps(collateral, lending, sold, proceeds);
  const interest = perSecondInterest(loan.principal, loan.interestRateBps, at - start);
  const fee = lateFee(loan.principal, endTime, at);
  const w = forcedCloseWaterfall({
    proceeds, incentiveBps, handlingBps, treasuryFeeBps: loan.treasuryFeeBpsAtInit,
    principal: loan.principal, interest, fee,
  });
  // The ledger row is recorded; the WATERFALL is returned, so a caller that
  // branches on who was credited (a surplus or not) branches on the
  // specification's arithmetic, never on the balance movement under test.
  expectLedger(id, name, before, after, {
    'collateral.borrowerVault': -sold,
    'collateral.venue': sold,
    'lending.venue': -proceeds,
    'lending.liquidator': w.bonus,
    'lending.lenderVault': w.lender,
    'lending.treasury': w.treasury,
    'lending.borrowerVault': w.borrower,
  }, `proceeds=${f18(proceeds)} debt=${f18(loan.principal + interest + fee)} (interest ${f18(interest)} + late fee ${f18(fee)}) incentive=${incentiveBps}bps handling=${handlingBps}bps`);
  return { ...w, incentiveBps, unsold: loan.collateralAmount - sold, debt: loan.principal + interest + fee };
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

  // Past the REST of the window the chain reported, plus a day — not a fixed
  // 30 days, which a valid grace longer than 60 days would leave short of.
  await warpDays(graceSeconds / 2 / 86_400 + 1);
  check('A3.3', 'past term AND grace, the loan becomes defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === true);

  // A forced close that cannot route the collateral REFUSES rather than
  // guessing a settlement — the try-list has to name an enabled venue.
  // Quoted inside the plan's range, so the probe reaches the route check
  // rather than stopping at `ForcedSaleQuoteOutOfRange`.
  const { sellAmount: probeQuote } = await forcedSaleQuote(loanId, FORCED_SALE_KIND.TimeBasedDefault);
  const noRoute = await simulate(DIAMOND, ABIS.defaulted, 'triggerDefault', [loanId, probeQuote, []], outsider.address);
  expectRefusal('A3.4', 'a forced close with an empty swap try-list is refused, not silently mis-settled', noRoute, 'NoEnabledSwapRoute');

  // Seed the venue's output float — the mock pays out of its own balance.
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'fund venue');

  const preDefault = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  const preDefaultPos = await positionOf(loanId);
  const beforeDefault = await snapshot(tokens, holders);
  const { plan: defaultPlan, sellAmount: defaultQuote } = await forcedSaleQuote(loanId, FORCED_SALE_KIND.TimeBasedDefault);
  check('A3.4b', 'past grace the default publishes a sale plan that covers the debt, and the quote lies inside its accepted range',
    defaultPlan.covered && defaultQuote >= defaultPlan.sell && defaultQuote <= defaultPlan.maxSell && defaultQuote < preDefault.collateralAmount,
    `plan sell=${f18(defaultPlan.sell)} maxSell=${f18(defaultPlan.maxSell)} covered=${defaultPlan.covered} quote=${f18(defaultQuote)} pledged=${f18(preDefault.collateralAmount)}`);
  const defaultReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.defaulted, functionName: 'triggerDefault', args: [loanId, defaultQuote, VENUE_ROUTE] }, 'triggerDefault');
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
  // per-asset cap — taken off the top of the proceeds, as a share of the debt
  // the sale settles (#2796). Not the loan's stamped fallback split, which
  // merely happens to be the same 300 bps here.
  const bonus = afterDefault['lending.liquidator'] - beforeDefault['lending.liquidator'];
  const defaultW = await expectForcedClose('A3.6b', 'the time-based default settles exactly per the spec\'s waterfall: keeper first, lender (net of the treasury fee on recovered interest and late fee), the subordinated handling charge, the borrower\'s extra',
    preDefault, defaultReceipt, beforeDefault, afterDefault, collateral, lending, defaultQuote);
  expectEq('A3.6', 'the caller earns the dynamic keeper incentive on the debt, taken off the top of the proceeds',
    bonus, defaultW.bonus, `${defaultW.incentiveBps}bps of the debt ${f18(defaultW.debt)} (proceeds ${f18(proceeds)})`);
  // The sale takes only what the debt needs, so the rest of the collateral
  // stays pledged: the lien falls by exactly what was sold and is NOT
  // released. The recorded collateral amount is the loan's original term;
  // the NFTs stay with their holders, who claim through them next.
  await expectPosition('A3.6c', 'the time-based default changes the position exactly: status Defaulted, both position NFTs "Loan Liquidated" because collateral was sold, the lien lowered to the unsold collateral — NFT holders and recorded terms unchanged',
    loanId, preDefaultPos, { status: STATUS.Defaulted, ...bothNfts(NFT_STATUS.LoanLiquidated), lienReleased: false, lienAmount: defaultW.unsold });

  // Each side's claim must move exactly the share the default credited to
  // that side's vault out to that side's wallet — both legs, and nothing else
  // (not the Diamond, not the treasury, not the other side). Any collateral
  // the sale did not take goes back with the borrower's claim.
  const unsold = defaultW.unsold;
  let claimPos = await positionOf(loanId);
  for (const [side, fn, acct] of [['lender', 'claimAsLender', lender], ['borrower', 'claimAsBorrower', borrower]]) {
    const credited = afterDefault[`lending.${side}Vault`] - beforeDefault[`lending.${side}Vault`];
    const residual = side === 'borrower' ? unsold : 0n;
    if (credited <= 0n && residual === 0n) cannotContinue(`A3.7.${side}`, `the default credited the ${side} nothing to claim`);
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
  // The pool's quote side is the WETH the deployment artifact records, not
  // one chain's WETH address written in here.
  const tliq = { asset: collateral, feed: MOCKS.liquidTokenUsdFeed, pool: MOCKS.liquidTokenWethPool, quote: WETH };
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
  // A healthy loan has no sale plan (`sell` 0), so the probe quotes 0 and the
  // health-factor guard is what answers it.
  const { sellAmount: midQuote } = await forcedSaleQuote(hfLoan, FORCED_SALE_KIND.HealthFactor);
  const midSim = await simulate(DIAMOND, ABIS.risk, 'triggerLiquidation', [hfLoan, midQuote, VENUE_ROUTE], outsider.address);
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
  // The band is governance-set, so the move is DERIVED from the live value:
  // one percentage point past it, measured from the seeded price.
  const [, , , consistencyBps] = await read(ABIS.config, 'getDepthTierConfigBundle');
  const seeded = 2000;
  const feedOnly = seeded * (1 - (Number(consistencyBps) + 100) / 10_000);
  await setFeedUsd(MOCKS.liquidTokenUsdFeed, feedOnly);
  const depthAfterCrash = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  check('A3.10', 'a FEED-ONLY reprice past the live pool-consistency band flips the asset Illiquid (the mock pool\'s spot does not follow the feed)',
    Number(depthAfterCrash) === 1,
    `checkLiquidity(collateral) after a feed-only move to $${feedOnly} (${Number(consistencyBps) + 100}bps, band ${consistencyBps}bps) = ${depthAfterCrash} (0=Liquid, 1=Illiquid) — while Illiquid, the HF-swap route refuses`);
  await setFeedUsd(MOCKS.liquidTokenUsdFeed, seeded);

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
  const { plan: liqPlan, sellAmount: liqQuote } = await forcedSaleQuote(hfLoan, FORCED_SALE_KIND.HealthFactor);
  const liqReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.risk, functionName: 'triggerLiquidation', args: [hfLoan, liqQuote, VENUE_ROUTE] }, 'triggerLiquidation');
  const afterLiq = await snapshot(tokens, holders);
  const liquidated = await read(ABIS.loan, 'getLoanDetails', [hfLoan]);
  const liqProceeds = beforeLiq['lending.venue'] - afterLiq['lending.venue'];
  const liqLanded = ['lenderVault', 'borrowerVault', 'treasury', 'liquidator']
    .reduce((acc, k) => acc + (afterLiq[`lending.${k}`] - beforeLiq[`lending.${k}`]), 0n);
  check('A3.12', 'HF<1 liquidation is permissionless, ends the loan Defaulted, and settles from the swap proceeds, every unit accounted',
    String(liquidated.status) === String(STATUS.Defaulted) && liqProceeds > 0n && liqLanded === liqProceeds,
    `caller=outsider gas=${liqReceipt.gasUsed} status=${liquidated.status} proceeds=${f18(liqProceeds)}`);
  // Whether all the collateral covers the debt is the plan's to say: a
  // covered plan sells only what the debt needs and pays the lender in full;
  // an uncovered one sells everything and the lender bears the loss.
  const liqW = await expectForcedClose('A3.12b', 'the HF liquidation settles exactly per the waterfall: keeper first, the lender up to the debt, the subordinated handling charge, the borrower\'s extra',
    preLiq, liqReceipt, beforeLiq, afterLiq, collateral, lending, liqQuote);
  await expectPosition('A3.12c', 'the HF liquidation changes the position exactly: status Defaulted, both position NFTs "Loan Liquidated", the lien lowered to the unsold collateral — NFT holders and recorded terms unchanged',
    hfLoan, preLiqPos, { status: STATUS.Defaulted, ...bothNfts(NFT_STATUS.LoanLiquidated), lienReleased: false, lienAmount: liqW.unsold });

  // The HF path writes its OWN claim records (RiskFacet, not DefaultedFacet),
  // so its claims are exercised in their own right.
  {
    const lenderCredit = afterLiq['lending.lenderVault'] - beforeLiq['lending.lenderVault'];
    const borrowerCredit = afterLiq['lending.borrowerVault'] - beforeLiq['lending.borrowerVault'];
    const borrowerClaims = liqW.borrower > 0n || liqW.unsold > 0n;
    if (liqPlan.covered) {
      check('A3.12e', 'a covered HF liquidation pays the lender the whole debt first (net only of the treasury fee on recovered interest)',
        liqW.allocated === liqW.debt, `lender gross=${f18(liqW.allocated)} net=${f18(liqW.lender)} debt=${f18(liqW.debt)}`);
    } else {
      check('A3.12e', 'an uncovered HF liquidation sells all the collateral and credits the borrower nothing',
        liqW.unsold === 0n && borrowerCredit === 0n, `unsold=${f18(liqW.unsold)} borrowerCredit=${f18(borrowerCredit)}`);
    }
    await claimAndExpectClose('A3.12d', hfLoan, { lenderCredit, borrowerCredit, unsold: liqW.unsold, borrowerClaims, tokens, holders });
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
  // The drawdown is DERIVED from the loan's own stamped liquidation LTV: the
  // collateral price that puts HF at 0.9 — below 1, so the HF path fires,
  // whatever threshold the loan stamped (a fixed $900 is only below it for
  // thresholds up to ~89%).
  const crashDetails = await read(ABIS.loan, 'getLoanDetails', [crashLoan]);
  const [crashDP, crashDD] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
  const crashDebtUsd = (crashDetails.principal * crashDP) / 10n ** BigInt(crashDD);
  const crashPrice = (9n * 10n ** 17n * crashDebtUsd * 10_000n) / (BigInt(crashDetails.liquidationLtvBpsAtInit) * crashDetails.collateralAmount);
  const crashDollars = Number(crashPrice) / 1e18;
  await repriceFaucetAsset(tliq, crashDollars);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [collateral, BigInt(Math.round(crashDollars * 1e8))]);
  const crashHf = await read(ABIS.risk, 'calculateHealthFactor', [crashLoan]);
  const stillRoutable = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  requireEnvelope('seeded pool depth', Number(stillRoutable) === 0,
    `at the derived drawdown price $${crashDollars} the collateral reads Illiquid`);
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'top up venue');
  const preCrash = await read(ABIS.loan, 'getLoanDetails', [crashLoan]);
  const preCrashPos = await positionOf(crashLoan);
  const beforeCrash = await snapshot(tokens, holders);
  const { sellAmount: crashQuote } = await forcedSaleQuote(crashLoan, FORCED_SALE_KIND.HealthFactor);
  const crashReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.risk, functionName: 'triggerLiquidation', args: [crashLoan, crashQuote, VENUE_ROUTE] }, 'triggerLiquidation(collateral drawdown)');
  const afterCrash = await snapshot(tokens, holders);
  const crashed = await read(ABIS.loan, 'getLoanDetails', [crashLoan]);
  const crashProceeds = beforeCrash['lending.venue'] - afterCrash['lending.venue'];
  const crashLanded = ['lenderVault', 'borrowerVault', 'treasury', 'liquidator']
    .reduce((acc, k) => acc + (afterCrash[`lending.${k}`] - beforeCrash[`lending.${k}`]), 0n);
  check('A3.13', 'a collateral drawdown to HF 0.9 with the pool following its feed keeps the asset routable, and HF<1 liquidation settles from the collateral side',
    Number(stillRoutable) === 0 && crashHf < 1_000_000_000_000_000_000n && String(crashed.status) === String(STATUS.Defaulted) &&
    crashProceeds > 0n && crashLanded === crashProceeds,
    `tLIQ $2,000 -> $${crashDollars} (derived; feed + pool spot) checkLiquidity=${stillRoutable} HF=${f18(crashHf)} gas=${crashReceipt.gasUsed} ` +
    `status=${crashed.status} proceeds=${f18(crashProceeds)}`);
  // Whether this close leaves the borrower an extra depends on the loan's
  // stamped threshold and the live incentive and handling rates, so the row
  // does not assume one: the waterfall computed from the specification says
  // which, and the claim sequence below follows it, together with whatever
  // collateral the sale did not take.
  const crashW = await expectForcedClose('A3.13b', 'the collateral-drawdown liquidation settles exactly per the waterfall: keeper, lender net of the interest fee, the handling charge, and the borrower\'s extra when the specification leaves one',
    preCrash, crashReceipt, beforeCrash, afterCrash, collateral, lending, crashQuote);
  await expectPosition('A3.13c', 'the drawdown liquidation changes the position exactly: status Defaulted, both position NFTs "Loan Liquidated", the lien lowered to the unsold collateral — NFT holders and recorded terms unchanged',
    crashLoan, preCrashPos, { status: STATUS.Defaulted, ...bothNfts(NFT_STATUS.LoanLiquidated), lienReleased: false, lienAmount: crashW.unsold });

  await claimAndExpectClose('A3.13d', crashLoan, {
    lenderCredit: afterCrash['lending.lenderVault'] - beforeCrash['lending.lenderVault'],
    borrowerCredit: afterCrash['lending.borrowerVault'] - beforeCrash['lending.borrowerVault'],
    unsold: crashW.unsold,
    borrowerClaims: crashW.borrower > 0n || crashW.unsold > 0n,
    tokens, holders,
  });
}

/**
 * The claims after a forced close, in order: the lender sweeps their credit;
 * when the borrower holds a claim (an extra in the lending asset, or
 * collateral the sale did not take) they sweep both, and the second claim
 * settles the loan; with none, the lender's claim alone settles it.
 */
async function claimAndExpectClose(id, loanId, { lenderCredit, borrowerCredit, unsold, borrowerClaims, tokens, holders }) {
  let pos = await positionOf(loanId);
  pos = await claimAndExpect({
    id: `${id}.lender`, who: 'lender', account: lender, fn: 'claimAsLender', loanId, tokens, holders, before: pos,
    moves: { 'lending.lenderVault': -lenderCredit, 'lending.lenderEOA': lenderCredit },
    changes: borrowerClaims ? { lenderNftOwner: null } : { lenderNftOwner: null, status: STATUS.Settled },
  });
  if (borrowerClaims) {
    await claimAndExpect({
      id: `${id}.borrower`, who: 'borrower', account: borrower, fn: 'claimAsBorrower', loanId, tokens, holders, before: pos,
      moves: {
        'lending.borrowerVault': -borrowerCredit, 'lending.borrowerEOA': borrowerCredit,
        'collateral.borrowerVault': -unsold, 'collateral.borrowerEOA': unsold,
      },
      changes: { borrowerNftOwner: null, status: STATUS.Settled },
    });
  } else {
    check(`${id}.borrower`, 'with nothing left for the borrower, the borrower is credited nothing and the lender\'s claim alone settles the loan',
      borrowerCredit === 0n, `borrowerCredit=${f18(borrowerCredit)}`);
  }
}
