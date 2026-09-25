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
import { check, expectEq, observe } from '../lib/report.mjs';

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
  check('A3.1', 'a healthy in-term loan is not defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === false, `loanId=${loanId}`);

  // Half a day past a 7-day term. Not a full day: this deployment's grace
  // for a 7-day loan is exactly one day, and the bound is seconds-precise, so
  // a one-day warp lands ON the boundary and the answer flips with whichever
  // second the warp happens to land on — seen on Anvil as `true` one run and
  // `false` the next.
  await warpDays(7.5);
  // The grace window is configurable per deployment (ConfigFacet's grace
  // buckets), so the assertion is RELATIVE to what the chain reports: inside
  // the reported window the loan must not be defaultable. The window itself
  // is recorded, not assumed.
  const dayPast = await read(ABIS.defaulted, 'isLoanDefaultable', [loanId]);
  const graceSeconds = await read(ABIS.config, 'getEffectiveGraceSeconds', [loanId]);
  check('A3.2', 'half a day past a 7-day term, inside this deployment\'s grace window, the loan is NOT defaultable',
    Number(graceSeconds) > 43_200 && dayPast === false,
    `isLoanDefaultable=${dayPast} effectiveGrace=${graceSeconds}s (${Number(graceSeconds) / 86400}d)`);

  await warpDays(30);
  check('A3.3', 'past term AND grace, the loan becomes defaultable',
    (await read(ABIS.defaulted, 'isLoanDefaultable', [loanId])) === true);

  // A forced close that cannot route the collateral REFUSES rather than
  // guessing a settlement — the try-list has to name an enabled venue.
  const noRoute = await simulate(DIAMOND, ABIS.defaulted, 'triggerDefault', [loanId, []], outsider.address);
  check('A3.4', 'a forced close with an empty swap try-list is refused, not silently mis-settled',
    !noRoute.ok, noRoute.ok ? 'NOT refused' : noRoute.name);

  // Seed the venue's output float — the mock pays out of its own balance.
  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'fund venue');

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
    String(defaulted.status) === '2' && proceeds > 0n && landed === proceeds,
    `caller=outsider gas=${defaultReceipt.gasUsed} status=${defaulted.status} proceeds=${f18(proceeds)} deltas=${JSON.stringify(d)}`);

  const bonus = afterDefault['lending.liquidator'] - beforeDefault['lending.liquidator'];
  const bonusBps = BigInt(defaulted.fallbackLenderBonusBpsAtInit);
  expectEq('A3.6', 'the caller earns the stamped forced-close bonus, taken off the top of the proceeds',
    bonus, (proceeds * bonusBps) / 10_000n, `${bonusBps}bps of ${f18(proceeds)} of swap proceeds`);

  // Each side's claim must move exactly the share the default credited to
  // that side's vault out to that side's wallet.
  for (const [side, fn, acct] of [['lender', 'claimAsLender', lender], ['borrower', 'claimAsBorrower', borrower]]) {
    const credited = afterDefault[`lending.${side}Vault`] - beforeDefault[`lending.${side}Vault`];
    const before = await snapshot(tokens, holders);
    const r = await tx(acct, { address: DIAMOND, abi: ABIS.claim, functionName: fn, args: [loanId] }, fn);
    const after = await snapshot(tokens, holders);
    check(`A3.7.${side}`, `after a default the ${side} sweeps exactly their credited share out of their vault`,
      after[`lending.${side}EOA`] - before[`lending.${side}EOA`] === credited && credited > 0n,
      `gas=${r.gasUsed} credited=${f18(credited)} deltas=${JSON.stringify(delta(before, after))}`);
  }

  // ------------------------------------------------------- HF liquidation
  const { loanId: hfLoan } = await openLoan({ lender, borrower });
  const openHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  check('A3.8', 'a fresh loan opens at or above the 1.5 initiation floor', openHf >= 1_500_000_000_000_000_000n,
    `loanId=${hfLoan} HF=${f18(openHf)}`);

  // The 1.5 floor binds at INITIATION; liquidation binds at 1.0. Prove the gap.
  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 1100);
  const midHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  const midSim = await simulate(DIAMOND, ABIS.risk, 'triggerLiquidation', [hfLoan, TRY_LIST], outsider.address);
  check('A3.9', 'below the 1.5 initiation floor but above 1.0 the position is NOT liquidatable',
    midHf < 1_500_000_000_000_000_000n && midHf >= 1_000_000_000_000_000_000n && !midSim.ok,
    `HF=${f18(midHf)} -> ${midSim.ok ? 'would liquidate' : midSim.name}`);

  // A large collateral drawdown can also push the asset under the on-chain
  // depth floor, which closes the swap route entirely. Record it, then drive
  // HF from the DEBT side so the swap route stays open for the payout test.
  const depthAfterCrash = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  observe('A3.10', 'a collateral drawdown can itself push the asset below the liquidity-depth floor',
    `checkLiquidity(collateral) after the price drop = ${depthAfterCrash} (0=Liquid, 1=Illiquid) — while Illiquid, the HF-swap route refuses`);

  await setFeedUsd(MOCKS.liquidTokenUsdFeed, 2000);
  await setFeedUsd(MOCKS.liquidToken2UsdFeed, 2.5);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [lending, 250_000_000n]);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [collateral, 200_000_000_000n]);
  const lowHf = await read(ABIS.risk, 'calculateHealthFactor', [hfLoan]);
  const routable = await read(ABIS.oracle, 'checkLiquidity', [collateral]);
  check('A3.11', 'repricing the DEBT asset upward drives HF below 1 while the collateral stays routable',
    lowHf < 1_000_000_000_000_000_000n && Number(routable) === 0, `HF=${f18(lowHf)} checkLiquidity(collateral)=${routable}`);

  await tx(outsider, { address: lending, abi: (await import('../lib/chain.mjs')).ERC20, functionName: 'mint', args: [venue, parseUnits('1000000', 18)] }, 'top up venue');
  const beforeLiq = await snapshot(tokens, holders);
  const liqReceipt = await tx(outsider, { address: DIAMOND, abi: ABIS.risk, functionName: 'triggerLiquidation', args: [hfLoan, TRY_LIST] }, 'triggerLiquidation');
  const afterLiq = await snapshot(tokens, holders);
  const liquidated = await read(ABIS.loan, 'getLoanDetails', [hfLoan]);
  const liqProceeds = beforeLiq['lending.venue'] - afterLiq['lending.venue'];
  const liqLanded = ['lenderVault', 'borrowerVault', 'treasury', 'liquidator']
    .reduce((acc, k) => acc + (afterLiq[`lending.${k}`] - beforeLiq[`lending.${k}`]), 0n);
  check('A3.12', 'HF<1 liquidation is permissionless and settles from the swap proceeds, every unit accounted',
    String(liquidated.status) !== '0' && liqProceeds > 0n && liqLanded === liqProceeds,
    `caller=outsider gas=${liqReceipt.gasUsed} status=${liquidated.status} proceeds=${f18(liqProceeds)} deltas=${JSON.stringify(delta(beforeLiq, afterLiq))}`);

  // leave the fork on the deployment's seeded prices
  await setFeedUsd(MOCKS.liquidToken2UsdFeed, 1);
  await sendAsOwner(venue, MOCK_ADAPTER_ABI, 'setTokenPrice', [lending, 100_000_000n]);
}
