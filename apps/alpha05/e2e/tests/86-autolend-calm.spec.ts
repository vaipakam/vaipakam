/**
 * Auto-lend's pause for a moving price, on Positions, against the suite's
 * chain. A new Auto-lend starts with the pause on. The test chain has no
 * hourly price checks, so the card says fills are paused and start after two
 * of them; once two exist it says the price is steady. The owner switches
 * the pause off through a reviewed, dry-run flow measured from the
 * transaction's own log, the chain agrees, and the card then says fills go
 * ahead however fast the price moves; switched back on, it is on again.
 * Runs on the desktop and the phone; the suite reverts the chain after every
 * test.
 */
import type { Page } from '@playwright/test';
import { erc20Abi, parseAbi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { anvilRpc } from '../lib/anvil';
import { scenario, txDeadline } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

type Scenario = ReturnType<typeof scenario>;
const CHECKPOINT = parseAbi(['function checkpointHourlyPrices(address[] assets)']);
const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** This hour's price checkpoints for both tokens, at a fixed gas limit
 *  (the price read inside catches running out of gas, #3504). */
async function checkpoint(sc: Scenario, assets: Hex[]): Promise<void> {
  const w = sc.wallet('lender');
  const hash = await w.writeContract({
    address: sc.diamond,
    abi: CHECKPOINT,
    functionName: 'checkpointHourlyPrices',
    args: [assets],
    gas: 1_000_000n,
    chain: null,
    account: w.account!,
  });
  expect((await sc.pub.waitForTransactionReceipt({ hash })).status).toBe('success');
}

/** Sign the open pause review and wait for the measured outcome. */
async function sign(page: Page, rowValue: string, outcome: string): Promise<void> {
  const flow = page.getByTestId('autolend-calm-review');
  await expect(flow.locator('.receipt')).toContainText(rowValue, { timeout: 60_000 });
  await expect(flow.locator('.receipt')).toContainText('This moves no money');
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(outcome);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(flow).toHaveCount(0);
}

test('an Auto-lend says when a moving price pauses it, and its owner switches the pause off and on', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const lender = accountFor('lender').address;
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('1'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, 0, parseEther('1'), 500n, 5000, 30, parseEther('0.05'), false, 0n, false, true, { linkKind: 0, linkMarginBps: 0, rateFarFromAverageAcknowledged: false }, await txDeadline(sc)]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, 0, parseEther('0.5')]);
  const status = () => sc.read<number>('intentCalmStatus', [lender, WETH, tliq, 0]);

  const { page } = await launchWallet('lender');
  await page.goto('/positions');
  await connectWallet(page);
  const calm = page.getByTestId('autolend-calm');
  // No hourly price checks yet: paused, and the card says when fills start.
  await expect(calm).toHaveAttribute('data-status', 'no-checkpoint', { timeout: 60_000 });
  await expect(calm.getByTestId('autolend-calm-status')).toContainText('Fills start after two hourly price checks.');
  await expect(calm).toContainText('Switched off, a loan can open while the price moves fast');
  await fitsWidth(page);

  // Two hourly checks for both tokens: the price is steady.
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await page.reload();
  await connectWallet(page);
  await expect(calm).toHaveAttribute('data-status', 'clear', { timeout: 60_000 });
  await expect(calm.getByTestId('autolend-calm-status')).toContainText('The price is steady');

  // Switched off, measured, and the chain agrees.
  await calm.getByTestId('autolend-calm-off').click();
  await sign(page, 'Off', 'Pause for a moving price switched off');
  expect(await status()).toBe(0);
  await expect(calm).toHaveAttribute('data-status', 'off', { timeout: 60_000 });
  await expect(calm.getByTestId('autolend-calm-status')).toContainText('Fills go ahead however fast the collateral price moves.');

  // Back on.
  await calm.getByTestId('autolend-calm-on').click();
  await sign(page, 'On', 'Pause for a moving price switched on');
  expect(await status()).not.toBe(0);
  await expect(calm).not.toHaveAttribute('data-status', 'off', { timeout: 60_000 });
});
