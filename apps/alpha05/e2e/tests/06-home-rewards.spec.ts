/**
 * Home's rewards widget (matrix RW-71, RW-24, RW-25, RW-33) on a REAL
 * reward entry: the chain is made a single-chain canonical reward deployment
 * by the operator script the keeper's Anvil scenarios use
 * (`ConfigureKeeperRewardsFixture`), a real loan between the suite's lender
 * and borrower accrues reward days, and the days are
 * closed and finalized through the protocol's permissionless entry points.
 * Then, as the lender, on the page:
 *
 *   1. before the days finalize, the claim waits and names the waiting day;
 *   2. with the claim window off, no removal date is shown;
 *   3. with a window armed and the entry's clock started, the soonest
 *      removal estimate is shown as a date;
 *   4. the headline is the EXACT figure the claim's own preview returns, and
 *      the claim runs through the shared flow: receipt, wallet, measured
 *      outcome (the VPFI that reached the vault, read back from the chain);
 *   5. once claimed, the preview reports nothing left, and the page says
 *      "No rewards available to claim on this chain" with no claim offered.
 *      (A claim that stops at its 30-day bound and offers "claim again" needs
 *      the reward arm date set, which this fixture does not do; the rule
 *      that offers it is unit-tested.)
 *
 * The reward posture cannot be undone through the protocol (custody
 * activation is one-way) and the drive moves the clock about five weeks, so
 * it runs between an `evm_snapshot` and an `evm_revert`: later specs, and the
 * other project's run of this one, find the chain as this one found it.
 */
import { parseAbi, type Hex } from 'viem';
import { compileScript, runForgeScript } from '@vaipakam/anvil-harness/fixture';
import { finalizeThrough, openLoan, repayInFull } from '@vaipakam/anvil-harness';
import { ANVIL_URL, anvilRpc, increaseTime } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';
import type { Page } from '@playwright/test';

const DAY = 86_400;
const REWARDS_SCRIPT = 'script/e2e/ConfigureKeeperRewardsFixture.s.sol';
/** Far above what one loan's reward days can owe, so funding never gates a claim. */
const REWARD_POOL_FUND = 1_000_000n * 10n ** 18n;
/** Days one claim pays at most (`LibVaipakam.MAX_INTERACTION_CLAIM_DAYS`). */
const CLAIM_DAYS = 30;
const ZERO = '0x0000000000000000000000000000000000000000';
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const PREVIEW = parseAbi([
  'function simulateClaimInteractionRewards(address user, uint8 venue)',
  'error InteractionRewardsSimulation(uint256 paid, uint256 fromDay, uint256 toDay)',
  'error NoInteractionRewardsToClaim()',
  'error InteractionDayGlobalNotFinalized(uint256 dayId)',
  'error InteractionDayAwaitingDelivery(uint256 dayId)',
  'error InteractionEmissionsNotStarted()',
]);

/** The claim's own preview, as the protocol answers it: the exact figure it
 *  reverts with; any other answer fails the spec, naming it. */
async function exactPreview(sc: ReturnType<typeof scenario>, user: Hex): Promise<{ amount: bigint; fromDay: bigint; toDay: bigint }> {
  try {
    await sc.pub.simulateContract({ address: sc.diamond, abi: PREVIEW, functionName: 'simulateClaimInteractionRewards', args: [user, 2], account: user });
  } catch (e) {
    // Walked by shape: the harness's viem copy need not be the one whose
    // classes an `instanceof` would test against.
    let node: unknown = e;
    let r: { errorName?: string; args?: readonly unknown[] } | undefined;
    for (let i = 0; node && typeof node === 'object' && i < 8 && !r; i++) {
      const d = (node as { data?: { errorName?: string; args?: readonly unknown[] } }).data;
      if (d && typeof d === 'object' && d.errorName) r = d;
      node = (node as { cause?: unknown }).cause;
    }
    if (r?.errorName !== 'InteractionRewardsSimulation') throw new Error(`the claim preview answered ${r?.errorName ?? String(e).slice(0, 300)}, not a figure`);
    const [amount, fromDay, toDay] = r.args as readonly [bigint, bigint, bigint];
    return { amount, fromDay, toDay };
  }
  throw new Error('the claim preview returned instead of answering');
}

/** The preview reports nothing to claim. */
async function expectNothingLeft(sc: ReturnType<typeof scenario>, user: Hex): Promise<void> {
  await expect(exactPreview(sc, user)).rejects.toThrow(/answered NoInteractionRewardsToClaim/);
}

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the rewards widget: a waiting day, the removal estimate, an exact claim measured in the vault, then nothing left', async ({ launchWallet }) => {
  // A cold compile of the reward script, ~70 day closes and two claims.
  test.setTimeout(900_000);
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    const lender = accountFor('lender').address;

    // ---- the canonical reward posture, by the operator's script ----
    expect(await sc.read<Hex>('getVPFIToken'), 'the fixture starts with no VPFI token').toBe(ZERO);
    compileScript(REWARDS_SCRIPT);
    runForgeScript(REWARDS_SCRIPT, ANVIL_URL, {
      ADMIN_PRIVATE_KEY: sc.fixture.adminKey,
      DIAMOND_ADDRESS: sc.diamond,
      REWARD_POOL_FUND_WEI: REWARD_POOL_FUND.toString(),
    });
    sc.fixture.rewards.interactionLaunchTimestamp = Number(await sc.read<bigint>('getInteractionLaunchTimestamp'));
    const vpfi = await sc.read<Hex>('getVPFIToken');

    // ---- a loan that accrues more reward days than one claim pays ----
    const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5', rateBps: 1000, days: 60 });
    await increaseTime((CLAIM_DAYS + 5) * DAY);
    await repayInFull(sc, 'borrower', loanId);
    await increaseTime(DAY + 60);
    await anvilRpc('evm_mine');

    // 1. Nothing finalized yet: the claim waits, and the day is named.
    const { page, flags } = await launchWallet('lender');
    await page.goto('/');
    await connectWallet(page);
    const widget = page.getByTestId('rewards-widget');
    const pending = widget.getByTestId('rewards-pending');
    await expect(pending).toHaveAttribute('data-figure', 'waiting', { timeout: 60_000 });
    await expect(pending).toContainText(/Your next rewards wait on reward day \d+/);
    await expect(widget.getByTestId('claim-interaction')).toHaveCount(0);
    // 2. The claim window is off on this chain: no date.
    await expect(widget.getByTestId('rewards-expiry')).toHaveAttribute('data-expiry', 'dark');
    await expect(widget).toContainText('Unclaimed rewards are not removed on this network');
    // The tier line reads through the public getter (consent-gated: 0 here).
    await expect(widget).toContainText('Fee-discount tier applied to your fees now: 0');
    await expect(widget).not.toContainText('could not be read');
    await fitsWidth(page);

    await finalizeThrough(sc, (await sc.rewardDay()) - 1);

    // 3. A claim window armed, and a touch starts the entry's clock.
    const entries = await sc.read<readonly bigint[]>('getUserRewardEntryIds', [lender]);
    expect(entries.length).toBeGreaterThan(0);
    await sc.diamondWrite('admin', 'setRewardClaimHorizonDays', [180]);
    await increaseTime(12 * 3600);
    await sc.diamondWrite('other', 'sweepExpiredInteractionRewards', [entries]);

    // 4. The exact figure, as the claim's own preview returns it.
    const exact = await exactPreview(sc, lender);
    expect(exact.toDay - exact.fromDay + 1n).toBe(BigInt(CLAIM_DAYS));
    await page.reload();
    await expect(pending).toHaveAttribute('data-figure', 'exact', { timeout: 60_000 });
    await expect(pending).toContainText('exactly what a claim made now pays');
    await expect(widget).toContainText(`Reward days ${exact.fromDay} to ${exact.toDay}.`);
    await expect(widget.getByTestId('rewards-expiry')).toHaveAttribute('data-expiry', 'date');
    await expect(widget).toContainText('Your soonest unclaimed reward is estimated to be removed after');

    const vaultVpfi = async () => (await sc.read<readonly [number, bigint, bigint]>('getVPFIDiscountTier', [lender]))[1];
    const walletVpfi = () => sc.pub.readContract({ address: vpfi, abi: ERC20, functionName: 'balanceOf', args: [lender] });
    const [vaultBefore, walletBefore] = await Promise.all([vaultVpfi(), walletVpfi()]);
    const sent = flags.sentTransactions;
    await widget.getByTestId('claim-interaction').click();
    const receipt = widget.locator('.receipt');
    await expect(receipt).toContainText('Claim rewards');
    await expect(receipt).toContainText(`${exact.fromDay} to ${exact.toDay}`);
    await expect(receipt).toContainText('Your vault, ready to use; your wallet if the vault cannot take it.');
    await expect(receipt).toContainText('Wallet prompts: 1.');
    await fitsWidth(page);
    await widget.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = widget.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
    await expect(finish).toContainText('delivered to your vault');
    expect(flags.sentTransactions).toBe(sent + 1);
    expect((await vaultVpfi()) - vaultBefore).toBe(exact.amount);
    expect(await walletVpfi()).toBe(walletBefore);

    // 5. On this deployment the days before the reward arm date are paid
    //    per entry in one claim, so the preview now answers that nothing is
    //    left: the page says so and offers no second claim (the bounded
    //    day walk that leaves a remainder runs only past the arm date).
    await expectNothingLeft(sc, lender);
    await widget.getByRole('button', { name: 'Close' }).click();
    await expect(pending).toHaveAttribute('data-figure', 'none', { timeout: 60_000 });
    await expect(pending).toContainText('No rewards available to claim on this chain.');
    await expect(widget.getByTestId('claim-interaction')).toHaveCount(0);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});
