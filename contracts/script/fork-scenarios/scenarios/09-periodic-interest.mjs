/**
 * A9 — periodic interest, and the switch it ships behind.
 *
 * Periodic interest is a governance-armed feature: the master switch
 * defaults OFF ("feature ships dormant; flipped on by governance when
 * ready"), and on this deployment it is off. So the scenario first records
 * the deployed posture — an offer carrying a cadence is refused outright —
 * and only then arms the switch on the FORK to exercise the settlement path
 * the deployment cannot currently reach. The switch is always put back.
 *
 * The connected app is consistent with the dark posture: its offer form
 * never offers a cadence (it hard-defaults to None) and only carries an
 * existing position's cadence through accept / sale / refinance. So there is
 * no user-reachable capability hidden behind the flag — this file checks the
 * contract path, not an interface gap.
 */
import { ADMIN, DIAMOND, MOCKS, TREASURY, borrower, chainNow, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, approveDiamond, delta, mint, offerParams, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { sendAs, warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { cannotContinue, check, expectLedger, observe, expectRefusal, requireEnvelope } from '../lib/report.mjs';
import { dynamicIncentiveBps } from '../lib/flow.mjs';

const MONTHLY = 1;

/**
 * Warp to just past the loan's CURRENT period end plus its grace, as the chain
 * reports them — the grace bucket is governance-configurable, so a fixed
 * "31 days" is only right while that grace is at most a day.
 */
async function warpPastPeriodGrace(loanId) {
  const [, , graceEndsAt] = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [loanId]);
  const now = BigInt(await chainNow());
  const target = BigInt(graceEndsAt) + 60n;
  if (target > now) await warpDays(Number(target - now) / 86_400);
  return target;
}

export async function run() {
  const initial = await read(ABIS.numeraireConfig, 'getPeriodicInterestEnabled');
  try {
    await runPeriodic(initial);
  } finally {
    // Restore the deployment's own posture whatever happened above.
    await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.numeraireConfig, functionName: 'setPeriodicInterestEnabled', args: [initial] });
  }
}

async function runPeriodic(initial) {
  const lending = MOCKS.liquidToken2;
  await mint(lender, lending, '1000000');
  await approveDiamond(lender, lending);

  // ------------------------------------------------ the deployed posture
  // Governance flips this switch when ready, so its value is configuration:
  // observed, not certified.
  observe('A9.1', 'periodic-interest master switch on this deployment (the documented default is OFF)',
    `getPeriodicInterestEnabled=${initial}`);

  // The dark-posture refusal is only testable while the switch is dark; the
  // scenario turns it off first so the row asserts regardless of the
  // deployment's own setting (the `finally` in run() restores it).
  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.numeraireConfig, functionName: 'setPeriodicInterestEnabled', args: [false] });
  const dark = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
    [await offerParams({ amount: parseUnits('100000', 18), collateralAmount: parseUnits('125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY })],
    lender.address);
  expectRefusal('A9.2', 'while dark, an offer carrying a cadence is refused outright rather than silently downgraded to None', dark, 'PeriodicInterestDisabled');

  // The cap is governance-set (default 365) but bounded by a CODE ceiling of
  // 4,385 days, so a term one day past the ceiling exceeds every valid
  // setting — the probe cannot be defeated by a legitimate retune.
  const tooLong = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
    [await offerParams({ durationDays: 4386n })], lender.address);
  expectRefusal('A9.3', 'offer terms are capped — a term past the setter\'s ceiling is refused, naming the live cap', tooLong, 'OfferDurationExceedsCap');

  // ------------------------------------------- armed on the fork only
  await sendAs(ADMIN, { address: DIAMOND, abi: ABIS.numeraireConfig, functionName: 'setPeriodicInterestEnabled', args: [true] });
  const threshold = await read(ABIS.numeraireConfig, 'getMinPrincipalForFinerCadence');
  const armedNow = await read(ABIS.numeraireConfig, 'getPeriodicInterestEnabled');
  check('A9.4', 'the switch is admin-armed on the FORK to exercise the path; the deployment is untouched', armedNow === true,
    `getPeriodicInterestEnabled=${armedNow} minPrincipalForFinerCadence=${f18(threshold)} (numeraire units)`);

  // Admission filters, each named by the chain.
  const shortTerm = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
    [await offerParams({ amount: parseUnits('100000', 18), collateralAmount: parseUnits('125', 18), durationDays: 20n, periodicInterestCadence: MONTHLY })],
    lender.address);
  expectRefusal('A9.5', 'a monthly cadence on a term shorter than one interval is refused', shortTerm, 'CadenceNotAllowed');

  const small = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
    [await offerParams({ amount: parseUnits('10', 18), collateralAmount: parseUnits('0.0125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY })],
    lender.address);
  // The threshold is in NUMERAIRE units, so the 10-token principal is valued
  // at the live oracle price (token and feed decimals from the chain, not a
  // $1 assumption): refused exactly when that value is below the threshold.
  const [smallPrice, smallFeedDec] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
  const smallValue = (parseUnits('10', 18) * smallPrice) / 10n ** BigInt(smallFeedDec);
  const shouldRefuse = smallValue < threshold;
  check('A9.6', 'the finer-cadence principal threshold decides admission of a 10-token principal, valued at the live oracle price',
    small.ok === !shouldRefuse && (small.ok || small.name.split('(')[0] === 'CadenceNotAllowed'),
    `value=${f18(smallValue)} threshold=${f18(threshold)} -> ${small.ok ? 'admitted' : small.name}`);

  // ---------------------------------------- a periodic loan, settled
  // A fixed 100,000-token principal (and the collateral and mints sized for
  // it). Admission needs its live numeraire value to reach the threshold, so
  // that is this file's envelope: a deployment configured above it does not
  // run the settlement paths, rather than reporting the refusal as a defect.
  const PRINCIPAL = parseUnits('100000', 18);
  const [pPrice, pFeedDec] = await read(ABIS.oracle, 'getAssetPrice', [lending]);
  const principalValue = (PRINCIPAL * pPrice) / 10n ** BigInt(pFeedDec);
  requireEnvelope('minPrincipalForFinerCadence', principalValue >= threshold,
    `the probe principal's ${f18(principalValue)} numeraire value is below the live threshold ${f18(threshold)}`);
  // Armed and above the threshold, so a failure to open is a broken flow —
  // `openLoan` throws and the file aborts rather than recording an INFO.
  const { loanId } = await openLoan({ lender, borrower, amount: PRINCIPAL, collateralAmount: parseUnits('125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY });
  const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  check('A9.7', 'a monthly-cadence loan opens once the feature is armed', String(loan.periodicInterestCadence) === String(MONTHLY),
    `loanId=${loanId} cadence=${loan.periodicInterestCadence} principal=${f18(loan.principal)} term=${loan.durationDays}d`);

  const early = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [loanId, []], outsider.address);
  expectRefusal('A9.8', 'settling before the first period closes is refused', early, 'PeriodicSettleNotDue');

  await warpPastPeriodGrace(loanId);
  const preview = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [loanId]);
  // [cadence, periodEndAt, graceEndsAt, expected, paidByBorrower, shortfall, dueNow]
  check('A9.9', 'after the first interval, a settlement preview reports the period due and its shortfall before anything moves',
    Array.isArray(preview) && preview[6] === true && preview[5] > 0n && preview[5] === preview[3] - preview[4],
    JSON.stringify(preview, (_, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 220));

  // The period closes on one of two paths, chosen by whether the borrower
  // has already paid it. Here they have NOT, so settling needs a swap route:
  // the protocol sells just enough collateral to cover the shortfall.
  const noRoute = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [loanId, []], outsider.address);
  expectRefusal('A9.10', 'an UNPAID period cannot be stamped closed — settling it needs a swap route, and says so', noRoute, 'PeriodicSettleSwapPathRequired');

  // Auto-liquidate path: a permissionless settler supplies the route.
  const venue = MOCKS.mockSwapAdapter;
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('10000000', 18)] }, 'fund venue');
  const holders = {
    lenderEOA: lender.address, lenderVault: await vaultAddressFor(lender),
    borrowerEOA: borrower.address, borrowerVault: await vaultAddressFor(borrower),
    settlerEOA: outsider.address, treasury: TREASURY, venue,
  };
  const tokens = { lending, collateral: MOCKS.liquidToken };
  const beforeAuto = await snapshot(tokens, holders);
  const autoReceipt = await tx(outsider, {
    address: DIAMOND, abi: ABIS.repayPeriodic, functionName: 'settlePeriodicInterest',
    args: [loanId, [{ adapterIdx: 0n, data: '0x' }]],
  }, 'settlePeriodicInterest(auto)');
  const afterAuto = await snapshot(tokens, holders);
  const autoLoan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  // Spec (periodic settlement reuses the liquidation policy): sell enough
  // collateral to cover the shortfall plus configured buffers; the settler
  // earns the dynamic incentive and the treasury the handling charge, both on
  // the proceeds; the rest reaches the lender, which must cover the period.
  const shortfallDue = preview[5];
  const sold = beforeAuto['collateral.borrowerVault'] - afterAuto['collateral.borrowerVault'];
  const proceeds = beforeAuto['lending.venue'] - afterAuto['lending.venue'];
  const toSettler = afterAuto['lending.settlerEOA'] - beforeAuto['lending.settlerEOA'];
  const toTreasury = afterAuto['lending.treasury'] - beforeAuto['lending.treasury'];
  const toLender = afterAuto['lending.lenderEOA'] - beforeAuto['lending.lenderEOA'] + (afterAuto['lending.lenderVault'] - beforeAuto['lending.lenderVault']);
  const [handlingFeeBps] = await read(ABIS.config, 'getLiquidationConfig');
  const settlerBps = await dynamicIncentiveBps(MOCKS.liquidToken, lending, sold, proceeds);
  check('A9.11', 'an unpaid period is closed by selling collateral: the loan stays Active, the settler earns the dynamic incentive and the treasury its handling charge on the proceeds, the lender is covered, and every unit is accounted',
    String(autoLoan.status) === '0' &&
    loan.collateralAmount - autoLoan.collateralAmount === sold &&
    toSettler === (proceeds * settlerBps) / 10_000n &&
    toTreasury === (proceeds * handlingFeeBps) / 10_000n &&
    toLender >= shortfallDue &&
    toSettler + toTreasury + toLender === proceeds,
    `gas=${autoReceipt.gasUsed} sold=${f18(sold)} proceeds=${f18(proceeds)} settler=${f18(toSettler)} (${settlerBps}bps) ` +
    `treasury=${f18(toTreasury)} (${handlingFeeBps}bps) lender=${f18(toLender)} shortfall=${f18(shortfallDue)}`);
  // What the spec does NOT pin down is where the sizing buffer ends up once
  // the period is covered. Surfaced, not certified.
  observe('A9.11b', 'after an auto-settled period, the lender receives this much above the period\'s shortfall (the sale\'s sizing buffer)',
    `excess=${f18(toLender - shortfallDue)} of proceeds=${f18(proceeds)} — the spec says "shortfall plus configured buffers" and does not say who keeps the buffer`);

  const twice = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [loanId, [{ adapterIdx: 0n, data: '0x' }]], outsider.address);
  expectRefusal('A9.12', 'the same period cannot be settled twice', twice, 'PeriodicSettleNotDue');

  // Voluntary path: a second loan whose borrower pays the period themselves.
  // A partial repayment charges ALL interest accrued to now (whole days,
  // borrower-favourable) and then retires the principal amount named — so to
  // pay the period rather than buy down principal, the borrower names the
  // SMALLEST principal reduction the protocol accepts (the asset's
  // `minPartialBps` floor, or one unit if there is none). What it costs is
  // asserted exactly, not described.
  const second = await openLoan({ lender, borrower, amount: PRINCIPAL, collateralAmount: parseUnits('125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY, allowsPartialRepay: true });
  await warpPastPeriodGrace(second.loanId);
  const due = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [second.loanId]);
  const secondLoan = await read(ABIS.loan, 'getLoanDetails', [second.loanId]);
  const { minPartialBps } = await read(ABIS.config, 'getAssetRiskParams', [lending]);
  const minPart = (secondLoan.principal * BigInt(minPartialBps)) / 10_000n;
  const part = minPart > 0n ? minPart : 1n;
  await mint(borrower, lending, '100000');
  await approveDiamond(borrower, lending);
  const pay = await simulate(DIAMOND, ABIS.repay, 'repayPartial', [second.loanId, part], borrower.address);
  if (!pay.ok) cannotContinue('A9.13 voluntary period payment', `repayPartial(${f18(part)}) -> ${pay.name}`);
  const stampBefore = secondLoan.lastPeriodicInterestSettledAt;
  const beforePay = await snapshot(tokens, holders);
  const payReceipt = await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayPartial', args: [second.loanId, part] }, 'repayPartial(period)');
  const afterPayBal = await snapshot(tokens, holders);
  const paid = await read(ABIS.loan, 'getLoanDetails', [second.loanId]);
  const afterPay = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [second.loanId]);
  const payAt = BigInt((await pub.getBlock({ blockNumber: payReceipt.blockNumber })).timestamp);
  const accrualStart = BigInt(secondLoan.interestAccrualStart || secondLoan.startTime);
  const payDays = (payAt - accrualStart) / 86_400n;
  const payInterest = (secondLoan.principal * BigInt(secondLoan.interestRateBps) * payDays) / (365n * 10_000n);
  const payCut = (payInterest * BigInt(secondLoan.treasuryFeeBpsAtInit)) / 10_000n;
  expectLedger('A9.13', 'the voluntary period payment costs exactly the interest accrued to now plus the minimum principal reduction, to the lender\'s wallet, the treasury fee on the interest only',
    beforePay, afterPayBal, {
      'lending.borrowerEOA': -(payInterest + part),
      'lending.lenderEOA': payInterest - payCut + part,
      'lending.treasury': payCut,
    }, `wholeDays=${payDays} interest=${f18(payInterest)} principalReduction=${f18(part)} (minPartialBps=${minPartialBps}) periodDue=${f18(due[3])}`);
  check('A9.13b', 'that payment covers the period and closes it in the same transaction — principal down by exactly the reduction, the settled-at stamp advanced, nothing sold',
    payInterest >= due[3] && secondLoan.principal - paid.principal === part &&
    paid.lastPeriodicInterestSettledAt > stampBefore && paid.collateralAmount === secondLoan.collateralAmount,
    `settledAt ${stampBefore} -> ${paid.lastPeriodicInterestSettledAt} principal ${f18(secondLoan.principal)} -> ${f18(paid.principal)} ` +
    `nextDue=${Array.isArray(afterPay) ? afterPay[1] : '?'} dueNow=${Array.isArray(afterPay) ? afterPay[6] : '?'}`);
  const stampSim = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [second.loanId, []], outsider.address);
  expectRefusal('A9.14', 'a stamp call after a voluntary payment is refused — the period is already closed', stampSim, 'PeriodicSettleNotDue');
}
