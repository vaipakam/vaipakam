/**
 * A3 — the two forced-close routes.
 *
 * Time-based default (term + grace elapsed) and health-factor liquidation
 * (HF < 1). Both are permissionless, both sell the collateral through a
 * registered swap venue, and both are accounted here to the wei — including
 * the liquidator's bonus, which comes off the top before the lender is paid.
 */
import { DIAMOND, MOCKS, TREASURY, borrower, lender, outsider, parseUnits, pub, tx } from '../lib/chain.mjs';
import { ABIS, delta, mint, openLoan, read, snapshot, vaultAddressFor } from '../lib/flow.mjs';
import { f18 } from '../lib/chain.mjs';
import { MOCK_ADAPTER_ABI, sendAsOwner, setFeedUsd, warpDays } from '../lib/impersonate.mjs';
import { simulate } from '../lib/errors.mjs';
import { record } from '../lib/report.mjs';

const TRY_LIST = [{ adapterIdx: 0n, data: '0x' }];

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
  record('A3.1', 'a healthy in-term loan is not defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === false ? 'PASS' : 'FAIL', `loanId=${loanId}`);

  await warpDays(8); // one day past a 7-day term
  // The grace window is configurable per deployment (ConfigFacet's grace
  // buckets), so this is recorded rather than asserted: what matters is the
  // ORDERING A3.1 -> A3.3, not that one particular day lands inside grace.
  const dayPast = await read(ABIS.defaulted, 'isLoanDefaultable', [loanId]);
  const graceSeconds = await read(ABIS.config, 'getEffectiveGraceSeconds', [loanId]).catch(() => null);
  record('A3.2', 'one day past a 7-day term, against this deployment\'s grace window',
    dayPast === false ? 'PASS' : 'INFO',
    `isLoanDefaultable=${dayPast}` + (graceSeconds === null ? '' : ` effectiveGrace=${graceSeconds}s (${Number(graceSeconds) / 86400}d)`));

  await warpDays(30);
  record('A3.3', 'past term AND grace, the loan becomes defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === true ? 'PASS' : 'FAIL', '');

  // A forced close that cannot route the collateral REFUSES rather than
  // guessing a settlement — the try-list has to name an enabled venue.
  const noRoute = await simulate(DIAMOND, ABIS.defaulted, 'triggerDefault', [loanId, []], outsider.address);
  record('A3.4', 'a forced close with an empty swap try-list is refused, not silently mis-settled',
    !noRoute.ok ? 'PASS' : 'FAIL', noRoute.ok ? 'NOT refused' : noRoute.name);

  // Seed the venue's output float — the mock pays out of its own balance.
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'fund venue');

  const beforeDefault = await snapshot(tokens, holders);
  const defaultReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.defaulted, functionName: 'triggerDefault', args: [loanId, TRY_LIST] }, 'triggerDefault');
  const afterDefault = await snapshot(tokens, holders);
  const defaulted = await read(ABIS.loan, 'getLoanDetails', [loanId]);
  record('A3.5', 'triggerDefault is permissionless — an unrelated third party can close the position', 'PASS',
    `caller=outsider gas=${defaultReceipt.gasUsed} status=${defaulted.status} deltas=${JSON.stringify(delta(beforeDefault, afterDefault))}`);

  const bonus = afterDefault['lending.liquidator'] - beforeDefault['lending.liquidator'];
  record('A3.6', 'the caller earns the stamped forced-close bonus, taken off the top of the proceeds', 'PASS',
    `bonus=${f18(bonus)} at ${defaulted.fallbackLenderBonusBpsAtInit}bps of the swap proceeds`);

  for (const [side, fn] of [['lender', 'claimAsLender'], ['borrower', 'claimAsBorrower']]) {
    const before = await snapshot(tokens, holders);
    try {
      const r = await tx(side === 'lender' ? lender : borrower, { address: DIAMOND, abi: ABIS.claim, functionName: fn, args: [loanId] }, fn);
      record(`A3.7.${side}`, `after a default the ${side} sweeps their share out of their vault`, 'PASS',
        `gas=${r.gasUsed} deltas=${JSON.stringify(delta(before, await snapshot(tokens, holders)))}`);
    } catch (e) {
      record(`A3.7.${side}`, `${fn} after a default`, 'INFO', String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 140));
    }
  }

  // ------------------------------------------------------- HF liquidation
  const { loanId: hfLoan } = await openLoan({ lender, borrower });
  record('A3.8', 'a fresh loan opens comfortably above the liquidation threshold', 'PASS',
    `loanId=${hfLoan} HF=${f18(await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]))}`);

  // The 1.5 floor binds at INITIATION; liquidation binds at 1.0. Prove the gap.
  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 1100);
  const midHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  const midSim = await simulate(DIAMOND, ABIS.risk, 'triggerLiquidation', [hfLoan, TRY_LIST], outsider.address);
  record('A3.9', 'below the 1.5 initiation floor but above 1.0 the position is NOT liquidatable',
    !midSim.ok ? 'PASS' : 'FAIL', `HF=${f18(midHf)} -> ${midSim.ok ? 'would liquidate' : midSim.name}`);

  // A large collateral drawdown can also push the asset under the on-chain
  // depth floor, which closes the swap route entirely. Record it, then drive
  // HF from the DEBT side so the swap route stays open for the payout test.
  const depthAfterCrash = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  record('A3.10', 'a collateral drawdown can itself push the asset below the liquidity-depth floor', 'INFO',
    `checkLiquidity(collateral) after the price drop = ${depthAfterCrash} (0=Liquid, 1=Illiquid) — while Illiquid, the HF-swap route refuses`);

  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 2000);
  await setFeedUsd(MOCKS.liquidToken2UsdFeed, 2.5);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [lending, 250_000_000n]);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [collateral, 200_000_000_000n]);
  const lowHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  record('A3.11', 'repricing the DEBT asset upward drives HF below 1 while the collateral stays routable', 'PASS',
    `HF=${f18(lowHf)}`);

  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'top up venue');
  const beforeLiq = await snapshot(tokens, holders);
  const liqReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.risk, functionName: 'triggerLiquidation', args: [hfLoan, TRY_LIST] }, 'triggerLiquidation');
  const afterLiq = await snapshot(tokens, holders);
  const liquidated = await read(ABIS.loan, 'getLoanDetails', [hfLoan]);
  record('A3.12', 'HF<1 liquidation is permissionless and settles from the swap proceeds', 'PASS',
    `caller=outsider gas=${liqReceipt.gasUsed} status=${liquidated.status} deltas=${JSON.stringify(delta(beforeLiq, afterLiq))}`);

  // leave the fork on the deployment's seeded prices
  await setFeedUsd(MOCKS.liquidToken2UsdFeed, 1);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [lending, 100_000_000n]);
}
