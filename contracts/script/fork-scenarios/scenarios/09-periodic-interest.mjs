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
import { ADMIN, DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, tx } from '../lib/chain.mjs';
import { ABIS, approveDiamond, delta, mint, offerParams, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { sendAs, warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { check, observe } from '../lib/report.mjs';
import { dynamicIncentiveBps } from '../lib/flow.mjs';

const MONTHLY = 1;

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
  check('A9.2', 'while dark, an offer carrying a cadence is refused outright rather than silently downgraded to None',
    !dark.ok, dark.ok ? 'NOT refused' : dark.name);

  const tooLong = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
    [await offerParams({ durationDays: 400n })], lender.address);
  check('A9.3', 'offer terms are capped — a 400-day term is refused, naming the cap',
    !tooLong.ok, tooLong.ok ? 'NOT refused' : tooLong.name);

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
  check('A9.5', 'a monthly cadence on a term shorter than one interval is refused',
    !shortTerm.ok, shortTerm.ok ? 'NOT refused' : shortTerm.name);

  const small = await simulate(DIAMOND, ABIS.offerCreate, 'createOffer',
    [await offerParams({ amount: parseUnits('10', 18), collateralAmount: parseUnits('0.0125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY })],
    lender.address);
  // 10 tLIQ2 at $1 is 10 numeraire units: refused exactly when the
  // deployment's threshold is above that, admitted otherwise.
  const shouldRefuse = threshold > parseUnits('10', 18);
  check('A9.6', 'the finer-cadence principal threshold decides admission of a 10-unit principal',
    !small.ok === shouldRefuse, `threshold=${f18(threshold)} -> ${small.ok ? 'admitted' : small.name}`);

  // ---------------------------------------- a periodic loan, settled
  const PRINCIPAL = parseUnits('100000', 18);
  // Armed and above the threshold, so a failure to open is a broken flow —
  // `openLoan` throws and the file aborts rather than recording an INFO.
  const { loanId } = await openLoan({ lender, borrower, amount: PRINCIPAL, collateralAmount: parseUnits('125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY });
  const loan = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  check('A9.7', 'a monthly-cadence loan opens once the feature is armed', String(loan.periodicInterestCadence) === String(MONTHLY),
    `loanId=${loanId} cadence=${loan.periodicInterestCadence} principal=${f18(loan.principal)} term=${loan.durationDays}d`);

  const early = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [loanId, []], outsider.address);
  check('A9.8', 'settling before the first period closes is refused', !early.ok, early.ok ? 'NOT refused' : early.name);

  await warpDays(31);
  const preview = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [loanId]);
  // [cadence, periodEndAt, graceEndsAt, expected, paidByBorrower, shortfall, dueNow]
  check('A9.9', 'after the first interval, a settlement preview reports the period due and its shortfall before anything moves',
    Array.isArray(preview) && preview[6] === true && preview[5] > 0n && preview[5] === preview[3] - preview[4],
    JSON.stringify(preview, (_, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 220));

  // The period closes on one of two paths, chosen by whether the borrower
  // has already paid it. Here they have NOT, so settling needs a swap route:
  // the protocol sells just enough collateral to cover the shortfall.
  const noRoute = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [loanId, []], outsider.address);
  check('A9.10', 'an UNPAID period cannot be stamped closed — settling it needs a swap route, and says so',
    !noRoute.ok, noRoute.ok ? 'NOT refused' : noRoute.name);

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
  check('A9.12', 'the same period cannot be settled twice', !twice.ok, twice.ok ? 'NOT refused' : twice.name);

  // Just-stamp path: a second loan whose borrower pays the period's interest
  // voluntarily first. Then nothing is sold — the period is simply stamped.
  const second = await openLoan({ lender, borrower, amount: PRINCIPAL, collateralAmount: parseUnits('125', 18), durationDays: 90n, periodicInterestCadence: MONTHLY, allowsPartialRepay: true });
  await warpDays(31);
  const due = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [second.loanId]);
  const shortfall = Array.isArray(due) ? due[5] : 0n;
  await mint(borrower, lending, '100000');
  await approveDiamond(borrower, lending);
  const pay = await simulate(DIAMOND, ABIS.repay, 'repayPartial', [second.loanId, shortfall], borrower.address);
  if (!pay.ok) throw new Error(`A9.13 voluntary period payment: repayPartial(${f18(shortfall)}) -> ${pay.name}`);
  const stampBefore = (await read(ABIS.loan, 'getLoanDetails', [second.loanId])).lastPeriodicInterestSettledAt;
  await tx(borrower, { address: DIAMOND, abi: ABIS.repay, functionName: 'repayPartial', args: [second.loanId, shortfall] }, 'repayPartial(period)');
  const paid = await read(ABIS.loan, 'getLoanDetails', [second.loanId]);
  const afterPay = await read(ABIS.repayPeriodic, 'previewPeriodicSettle', [second.loanId]);
  // What the run observed: the voluntary payment closes the period BY
  // ITSELF — the settled-at stamp advances inside the repayment, so there is
  // no separate "just-stamp" call left to make, and one is refused NotDue.
  check('A9.13', 'a borrower paying the period voluntarily closes it in the same transaction — no swap, no separate stamp',
    paid.lastPeriodicInterestSettledAt > stampBefore,
    `paid=${f18(shortfall)} settledAt ${stampBefore} -> ${paid.lastPeriodicInterestSettledAt} ` +
    `nextDue=${Array.isArray(afterPay) ? afterPay[1] : '?'} dueNow=${Array.isArray(afterPay) ? afterPay[6] : '?'}`);
  const stampSim = await simulate(DIAMOND, ABIS.repayPeriodic, 'settlePeriodicInterest', [second.loanId, []], outsider.address);
  check('A9.14', 'a stamp call after a voluntary payment is refused — the period is already closed',
    !stampSim.ok, stampSim.ok ? 'still stampable' : stampSim.name);
}
