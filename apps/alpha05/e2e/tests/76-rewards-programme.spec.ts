/**
 * Rewards, whether the reward programme runs on the network (matrix RW-43)
 * and the network's reward role (RW-44), from the Diamond's own views at
 * one block. On the bare fixture chain, as the lender in Advanced:
 *
 *   1. no start time is set: the programme has no start date, no role is
 *      set (it works as a home network), custody is not switched on, the
 *      claim horizon is off, and no VPFI token is set;
 *   2. a start two days ahead is stated with its time;
 *   3. once started, with no VPFI token, nothing is held to pay rewards;
 *   4. with a VPFI token and VPFI in the Diamond, the programme runs and
 *      the delivered VPFI ready to pay is stated;
 *   5. a global pause is stated by name with what stays open;
 *   6. reporting to another network names that network as the home network,
 *      and the VPFI held there is not payable until it is delivered;
 *   7. detached, the network has left the reward network and nothing new
 *      becomes claimable.
 *
 * Runs on the desktop and the phone project; the chain is reverted after
 * each test.
 */
import { parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const DAY = 86_400;

async function fitsWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the Rewards page says whether the reward programme runs here, never calling it running without a start, a paying role and VPFI to pay', async ({
  launchWallet,
}) => {
  test.setTimeout(300_000);
  const sc = scenario();
  expect(await sc.read<bigint>('getInteractionLaunchTimestamp')).toBe(0n);
  expect(await sc.read<number>('getRewardRole')).toBe(2);
  expect(await sc.read<boolean>('rewardCustodyActivated')).toBe(false);

  const { page } = await launchWallet('lender', { advanced: true });
  await page.goto('/rewards');
  await connectWallet(page);
  const now = page.getByTestId('rewards-programme-now');
  const role = page.getByTestId('rewards-programme-role');
  const fresh = page.getByTestId('rewards-programme-fresh');
  const reopen = async () => {
    await page.reload();
    await connectWallet(page);
  };

  // 1. Nothing set.
  await expect(now).toHaveAttribute('data-programme', 'not-started', { timeout: 60_000 });
  await expect(now).toContainText('The reward programme has no start date on Base Sepolia, so activity here earns no rewards.');
  await expect(role).toHaveAttribute('data-role', 'unconfigured');
  await expect(role).toHaveText('No reward role is set, so this network works as a home network for rewards.');
  await expect(page.getByTestId('rewards-programme-custody')).toHaveText('In the protocol’s own balance; the separate reward custody is not switched on here.');
  await expect(page.getByTestId('rewards-programme-horizon')).toHaveText('Off: unclaimed rewards are not removed on this network.');
  await expect(fresh).toHaveText('None: no VPFI token is set on this network.');
  await expect(page.getByTestId('rewards-programme')).toContainText('Not read here, and anyone may run it.');
  await expect(page.getByTestId('rewards-programme-pause')).toHaveCount(0);
  await fitsWidth(page);

  // 2. A start two days ahead.
  const block = await sc.pub.getBlock();
  await sc.diamondWrite('admin', 'setInteractionLaunchTimestamp', [block.timestamp + BigInt(2 * DAY)]);
  await reopen();
  await expect(now).toHaveAttribute('data-programme', 'starts', { timeout: 60_000 });
  await expect(now).toContainText('The reward programme starts on Base Sepolia at');
  await expect(now).toContainText('activity before then earns no rewards.');

  // 3. Started, but there is no VPFI token: nothing is held to pay.
  await increaseTime(3 * DAY);
  await mine();
  await reopen();
  await expect(now).toHaveAttribute('data-programme', 'unfunded', { timeout: 60_000 });
  await expect(now).toContainText('The reward programme runs on Base Sepolia, but no VPFI is held here to pay rewards right now.');

  // 4. A VPFI token and VPFI in the Diamond: the programme runs.
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  await sc.write('lender', token, TOKEN_ABI, 'mint', [sc.diamond, parseEther('50')]);
  await reopen();
  await expect(now).toHaveAttribute('data-programme', 'live', { timeout: 60_000 });
  await expect(now).toContainText('The reward programme runs on Base Sepolia: your activity here earns rewards, and VPFI is held to pay them.');
  await expect(fresh).toContainText('50');
  await expect(page.getByTestId('rewards-programme-recycled')).toContainText('0');
  await fitsWidth(page);

  // 5. A global pause, by name, with what stays open.
  await sc.diamondWrite('admin', 'pause');
  await reopen();
  const pause = page.getByTestId('rewards-programme-pause');
  await expect(pause).toHaveAttribute('data-pause', 'paused', { timeout: 60_000 });
  await expect(pause).toContainText('The protocol on Base Sepolia is paused: reward claims and withdrawals are stopped.');
  await expect(pause).toContainText('Full and partial repayment and adding collateral stay open');
  await sc.diamondWrite('admin', 'unpause');

  // 6. Reporting to another network.
  await sc.diamondWrite('admin', 'setBaseChainId', [421614]);
  await reopen();
  await expect(role).toHaveAttribute('data-role', 'mirror', { timeout: 60_000 });
  await expect(role).toHaveText('Reports its activity to Arbitrum Sepolia, which counts the rewards and funds them here.');
  // The 50 VPFI is held, but nothing was delivered for rewards: a mirror's
  // claim charges the delivered allowance first, so nothing is payable.
  await expect(now).toHaveAttribute('data-programme', 'unfunded');
  await expect(now).toContainText('but no VPFI from Arbitrum Sepolia is held here to pay rewards right now.');
  await expect(page.getByTestId('rewards-programme-undelivered')).toContainText('is held, but a claim pays only what was delivered for rewards.');
  await expect(page.getByTestId('rewards-programme-pause')).toHaveCount(0);

  // 7. Detached: nothing new becomes claimable here.
  await sc.diamondWrite('admin', 'setBaseChainId', [0]);
  expect(await sc.read<number>('getRewardRole')).toBe(3);
  await reopen();
  await expect(now).toHaveAttribute('data-programme', 'left', { timeout: 60_000 });
  await expect(now).toHaveText('Base Sepolia has left the reward network: nothing new becomes claimable here.');
  await expect(role).toHaveText('Has left the reward network: nothing new becomes claimable here.');
  await fitsWidth(page);
});
