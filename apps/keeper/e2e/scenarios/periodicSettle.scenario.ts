/**
 * The periodic-interest settler, end to end on Anvil.
 *
 * The REAL pass (`runPeriodicSettle`, exactly as the scheduler calls it)
 * against the repository's current contracts, deployed from source. What it
 * proves, in order:
 *
 *   1. Before the period's grace is over the pass sends nothing.
 *   2. Once it is over, with the borrower having paid no interest, the pass
 *      sells the borrower's collateral through the fixture's swap venue for
 *      EXACTLY the amount the contract sizes (`previewForcedSale(loanId, 0)`,
 *      #2795), not the whole collateral: the sale's `ForcedSaleSettled`
 *      reports that amount sold, the lender paid the whole shortfall, and the
 *      sale covered. The settlement is the keeper's own transaction, and the
 *      loan stays Active with its next period opened.
 *   3. The next run sends nothing: the period it settled is no longer due.
 *
 * The scenario's own writes are the operator's switch (periodic interest on,
 * the finer-cadence threshold lowered so a 1-WETH loan may take a monthly
 * cadence), the loan, the venue's float, and the clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEther, type Address } from 'viem';
import { runPeriodicSettle } from '../../src/periodicSettle';
import { openScenario, type KeeperChain } from '../harness/chain';
import { keeperEnvFor, tickNow, type KeeperHarness } from '../harness/keeperEnv';
import { collectOpsAlerts, type OpsAlertLog } from '../harness/opsAlerts';
import { openLoan, WETH } from '@vaipakam/anvil-harness/lending';

/** `LibVaipakam.PeriodicInterestCadence.Monthly`. */
const MONTHLY = 1;
/** `ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement`. */
const PERIODIC = 0;
/** The finer-cadence threshold's floor ($1,000), so a 1-WETH loan qualifies. */
const THRESHOLD = 1_000n * 10n ** 18n;

interface Plan {
  debt: bigint;
  need: bigint;
  sell: bigint;
  floor: bigint;
  covered: boolean;
}

let sc: KeeperChain;
let k: KeeperHarness;
let alerts: OpsAlertLog;

beforeAll(async () => {
  sc = await openScenario();
  k = await keeperEnvFor(sc, ['PERIODIC_SETTLE_ENABLED']);
  alerts = collectOpsAlerts();
});

afterAll(async () => {
  await sc?.stop();
});

/** One scheduled run, then wait for anything it broadcast to be mined: the
 *  pass returns once a transaction is SENT (its outcome is "submitted", not
 *  "confirmed"), and the node mines it a moment later. */
async function settlerRun(): Promise<void> {
  await sc.syncClock();
  await runPeriodicSettle(k.env, tickNow(15 * 60_000));
  const keeper = sc.address('keeper');
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [mined, sent] = await Promise.all([
      sc.pub.getTransactionCount({ address: keeper, blockTag: 'latest' }),
      sc.pub.getTransactionCount({ address: keeper, blockTag: 'pending' }),
    ]);
    if (mined === sent) return;
    if (Date.now() > deadline) throw new Error(`keeper tx not mined: latest=${mined} pending=${sent}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function keeperNonce(): Promise<number> {
  return sc.pub.getTransactionCount({ address: sc.address('keeper') });
}

/** The fixture's venue pays from its own float, which holds only the faucet
 *  tokens; the loan lends WETH, so the venue is given WETH to pay with. */
async function fundVenue(): Promise<void> {
  const venue = (sc.fixture.artifact.testnetMocks as Record<string, Address>).mockSwapAdapter;
  expect(venue).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const node = sc.node.control;
  await node.setBalance(venue, parseEther('100'));
  await node.rpc('anvil_impersonateAccount', [venue]);
  await node.rpc('eth_sendTransaction', [
    { from: venue, to: WETH, value: `0x${parseEther('50').toString(16)}`, data: '0xd0e30db0' }, // WETH9.deposit()
  ]);
  await node.rpc('anvil_stopImpersonatingAccount', [venue]);
}

describe('periodicSettle on an Anvil chain', () => {
  let loanId = 0n;
  let collateral = 0n;

  it('sends nothing while the period is not yet settleable', async () => {
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [true]);
    await sc.diamondWrite('admin', 'setMinPrincipalForFinerCadence', [THRESHOLD]);
    await fundVenue();
    const loan = await openLoan(sc, {
      lender: 'lender',
      borrower: 'borrower',
      principalWeth: '1',
      collateralTliq: '5',
      rateBps: 1200,
      days: 90,
      cadence: MONTHLY,
    });
    loanId = loan.loanId;
    const details = await sc.read<{ periodicInterestCadence: number; collateralAmount: bigint }>('getLoanDetails', [loanId]);
    expect(Number(details.periodicInterestCadence)).toBe(MONTHLY);
    collateral = details.collateralAmount;

    const before = await keeperNonce();
    await settlerRun();
    expect(await keeperNonce()).toBe(before);
  });

  it('sells exactly the contract-sized slice once the grace is over, and pays the lender the shortfall', async () => {
    const preview = await sc.read<readonly [number, bigint, bigint, bigint, bigint, bigint, boolean]>(
      'previewPeriodicSettle',
      [loanId],
    );
    const graceEndsAt = Number(preview[2]);
    await sc.warp(graceEndsAt - (await sc.now()) + 60);
    expect(await sc.read<boolean>('isLoanDefaultable', [loanId])).toBe(false);

    const plan = await sc.read<Plan>('previewForcedSale', [loanId, PERIODIC]);
    expect(plan.debt).toBeGreaterThan(0n);
    expect(plan.covered).toBe(true);
    expect(plan.sell).toBeGreaterThan(0n);
    expect(plan.sell).toBeLessThan(collateral);

    const fromBlock = await sc.blockNumber();
    const before = await keeperNonce();
    await settlerRun();
    expect(await keeperNonce()).toBe(before + 1);

    const sold = await sc.diamondEvents('ForcedSaleSettled', fromBlock);
    expect(sold).toHaveLength(1);
    const ev = sold[0].args;
    expect(ev.loanId).toBe(loanId);
    expect(Number(ev.kind)).toBe(PERIODIC);
    expect(ev.debt).toBe(plan.debt);
    expect(ev.collateralSold).toBe(plan.sell);
    expect(ev.lenderPaid).toBe(plan.debt);
    expect(ev.covered).toBe(true);
    expect((ev.keeper as Address).toLowerCase()).toBe(sc.address('keeper').toLowerCase());
    const tx = await sc.pub.getTransaction({ hash: sold[0].transactionHash });
    expect(tx.from.toLowerCase()).toBe(sc.address('keeper').toLowerCase());
    expect(await sc.diamondEvents('PeriodicInterestAutoLiquidated', fromBlock)).toHaveLength(1);

    const after = await sc.read<{ status: number; collateralAmount: bigint }>('getLoanDetails', [loanId]);
    expect(Number(after.status)).toBe(0); // Active
    expect(after.collateralAmount).toBe(collateral - plan.sell);
    const next = await sc.read<readonly [number, bigint, bigint, bigint, bigint, bigint, boolean]>(
      'previewPeriodicSettle',
      [loanId],
    );
    expect(next[1]).toBeGreaterThan(preview[1]); // the next period's end
    expect(next[6]).toBe(false);
  });

  it('sends nothing on the next run, and raised no operator alert', async () => {
    const before = await keeperNonce();
    await sc.warp(60);
    await settlerRun();
    expect(await keeperNonce()).toBe(before);
    expect(alerts.texts).toEqual([]);
  });
});
