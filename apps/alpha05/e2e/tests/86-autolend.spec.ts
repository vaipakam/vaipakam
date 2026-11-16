/**
 * Lend: Auto-lend setup (#3624, matrix row "Auto-lend setup"). The Lend
 * page asks once how the lend should run: a one-time offer, or "keep
 * lending when repaid", which sets up Auto-lend. The Auto-lend form takes
 * the limits with exact parsing; the review is the protocol's own dry run
 * of the setup with every figure it binds and every consequence, including
 * that nothing promises a fill; the wallet approves exactly the amount
 * funded, and the terms and the funding are sent as ONE transaction. The
 * outcome is measured from that transaction's logs, the chain agrees, and
 * Positions shows the Auto-lend. With the network's switch off the option
 * is closed and says why. Runs on the desktop and the phone project; the
 * suite reverts the chain after every test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function openPair(page: Page, tliq: Hex): Promise<void> {
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
}

interface StoredIntent {
  active: boolean;
  maxExposure: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
  minFillAmount: bigint;
  requiresKeeperAuth: boolean;
  termsSetAt: bigint;
  lendUntil: bigint;
  acceptsProRata: boolean;
}

test('a lender sets up Auto-lend: one choice, an exact approval, terms and funding in one transaction, and a measured outcome', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const lender = accountFor('lender').address;
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.5'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('lender');
  await openPair(page, tliq);

  // One question, two answers; the one-time offer is the default.
  const choice = page.getByTestId('lend-choice');
  await expect(choice).toHaveAttribute('data-autolend', 'open', { timeout: 60_000 });
  await expect(page.getByTestId('lend-choice-once')).toBeChecked();
  await page.getByTestId('lend-choice-keep').check();
  await page.getByTestId('lend-offer-open').click();

  const form = page.getByTestId('autolend-form');
  await expect(form).toBeVisible();
  // Exact parsing: more decimals than the token has are refused, not rounded.
  await page.getByTestId('autolend-amount').fill('0.1234567890123456789');
  await page.getByTestId('autolend-amount').blur();
  await expect(form).toContainText('takes at most 18 decimals.');
  await page.getByTestId('autolend-amount').fill('0.5');
  await page.getByTestId('autolend-rate').fill('5');
  // Below the about 53% this pair's floor allows on the test chain; a higher
  // ceiling is refused in the review (unit-tested in autoLend.test.ts).
  await page.getByTestId('autolend-ltv').fill('50');
  await page.getByTestId('autolend-days').fill('30');
  await page.getByTestId('autolend-prorata').check();
  // Basic carries no exposure or smallest-loan fields.
  await expect(page.getByTestId('autolend-advanced')).toHaveCount(0);
  await fitsWidth(page);
  await page.getByTestId('autolend-review').click();

  const setup = page.getByTestId('autolend-setup');
  const receipt = setup.locator('.receipt');
  await expect(receipt).toContainText('Set up Auto-lend', { timeout: 60_000 });
  await expect(receipt).toContainText('a standing instruction, not an offer');
  await expect(receipt).toContainText('Moves from your wallet to your own vault');
  await expect(receipt).toContainText('Most lent out at once');
  await expect(receipt).toContainText('5% a year');
  await expect(receipt).toContainText('50% of the collateral’s value');
  await expect(receipt).toContainText('30 days');
  await expect(receipt).toContainText('Smallest loan');
  await expect(receipt).toContainText('No end date: it lends until you stop it');
  await expect(receipt).toContainText('and those who pay only for the time borrowed');
  await expect(receipt).toContainText('Any matching service, within your limits');
  await expect(receipt).toContainText('First loan possible from');
  await expect(receipt).toContainText('Lets the protocol take from your wallet');
  // What it does not promise, and what it does with repaid money.
  await expect(receipt).toContainText('nothing promises a fill');
  // Relending repaid money needs the protocol's keeper allowed to roll it;
  // this wallet has not allowed it, so the review says the money comes back
  // as a claim instead.
  await expect(receipt).toContainText('comes back to you as a claim instead of being lent again');
  await expect(receipt).toContainText('take back money that is not lent at any time');
  await expect(receipt).toContainText('Wallet prompts: 2');
  await fitsWidth(page);

  const confirm = setup.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await setup.getByTestId('autolend-consent').check();
  await expect(confirm).toBeEnabled();
  const sent = flags.sentTransactions;
  await confirm.click();
  const finish = setup.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Auto-lend set up on this pair');
  await expect(finish).toContainText('set aside for Auto-lend in your vault');
  // The approval, then the setup as one transaction.
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: the terms as typed, the funding behind them, the approval used up.
  const intent = await sc.read<StoredIntent>('getLenderIntent', [lender, WETH, tliq]);
  expect(intent.active).toBe(true);
  expect(intent.maxExposure).toBe(parseEther('0.5'));
  expect(intent.minRateBps).toBe(500n);
  expect(intent.maxInitLtvBps).toBe(5000);
  expect(intent.maxDurationDays).toBe(30);
  expect(intent.minFillAmount > 0n).toBe(true);
  expect(intent.requiresKeeperAuth).toBe(false);
  expect(intent.lendUntil).toBe(0n);
  expect(intent.acceptsProRata).toBe(true);
  expect(await sc.read<bigint>('getLenderIntentCapital', [lender, WETH, tliq])).toBe(parseEther('0.5'));
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] })).toBe(0n);

  // Positions shows it, with the money waiting to be lent.
  await page.goto('/positions');
  const card = page.getByTestId('autolend-card');
  await expect(card).toHaveAttribute('data-state', 'active', { timeout: 60_000 });
  await expect(card).toContainText('Waiting to be lent: 0.5');
  await expect(card).toContainText('Lowest rate 5% a year');
  await expect(card).toContainText('Also lends to borrowers who pay only for the time borrowed');
  await fitsWidth(page);

  // Back on Lend, the pair already carries an Auto-lend, so the option is closed and says where it is.
  await openPair(page, tliq);
  await expect(page.getByTestId('lend-choice')).toHaveAttribute('data-autolend', 'has', { timeout: 60_000 });
  await expect(page.getByTestId('lend-choice-has')).toContainText('It is shown on Positions');
  await expect(page.getByTestId('lend-choice-keep')).toBeDisabled();

  // A switch turned off after setup stops every new loan; the card says so.
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [false]);
  await page.goto('/positions');
  await expect(page.getByTestId('autolend-posture')).toHaveAttribute('data-posture', 'off', { timeout: 60_000 });
  await expect(page.getByTestId('autolend-posture')).toContainText('switched off on this network now');
});

test('with Auto-lend switched off on the network, the option is closed and says why', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [false]);

  const { page } = await launchWallet('lender');
  await openPair(page, tliq);
  await expect(page.getByTestId('lend-choice')).toHaveAttribute('data-autolend', 'off', { timeout: 60_000 });
  await expect(page.getByTestId('lend-choice-off')).toContainText('Auto-lend is switched off on this network now');
  await expect(page.getByTestId('lend-choice-keep')).toBeDisabled();
  // The one-time offer still opens.
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your lending offer' })).toBeVisible();
  await fitsWidth(page);
});
