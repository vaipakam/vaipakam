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
 * is closed and says why. On Positions, money is added (an exact approval),
 * money not lent is taken back (more than waits is refused in the review),
 * and the Auto-lend is stopped with the rest taken back in the same
 * transaction, each measured and checked against the chain. Runs on the desktop and the phone project; the
 * suite reverts the chain after every test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario, txDeadline } from '../lib/chain';
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
  await expect(receipt).toContainText('take back money that is not lent at any time while it is not paused');
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
  const intent = await sc.read<StoredIntent>('getLenderIntent', [lender, WETH, tliq, 0]);
  expect(intent.active).toBe(true);
  expect(intent.maxExposure).toBe(parseEther('0.5'));
  expect(intent.minRateBps).toBe(500n);
  expect(intent.maxInitLtvBps).toBe(5000);
  expect(intent.maxDurationDays).toBe(30);
  expect(intent.minFillAmount > 0n).toBe(true);
  expect(intent.requiresKeeperAuth).toBe(false);
  expect(intent.lendUntil).toBe(0n);
  expect(intent.acceptsProRata).toBe(true);
  expect(await sc.read<bigint>('getLenderIntentCapital', [lender, WETH, tliq, 0])).toBe(parseEther('0.5'));
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] })).toBe(0n);

  // Positions shows it, with the money waiting to be lent.
  await page.goto('/positions');
  const card = page.getByTestId('autolend-card');
  await expect(card).toHaveAttribute('data-state', 'active', { timeout: 60_000 });
  await expect(card).toContainText('Waiting to be lent: 0.5');
  await expect(card).toContainText('Lowest rate 5% a year');
  await expect(card).toContainText('Also lends to borrowers who pay only for the time borrowed');
  await fitsWidth(page);
  // #3664 — how much is in loans, per asset: nothing yet, all 0.5 waiting.
  const share = page.getByTestId('autolend-share-row');
  await expect(share).toHaveAttribute('data-share-bps', '0');
  await expect(share).toContainText('0% counted in loans');
  await expect(share).toContainText('0.5 WETH waiting in your vault');
  await expect(page.getByTestId('autolend-share-idle')).toHaveCount(0);
  await expect(page.getByTestId('autolend-share-scope')).toContainText('its loans run on');

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

  // Stopped with its money still set aside: that money will not be lent, and the share says so.
  await sc.diamondWrite('lender', 'cancelLenderIntent', [WETH, tliq, 0]);
  await page.goto('/positions');
  await expect(page.getByTestId('autolend-card')).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });
  await expect(page.getByTestId('autolend-share-idle')).toContainText('0.5 WETH of the waiting money sits behind a stopped or ended Auto-lend');
  await fitsWidth(page);
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

test('on Positions a lender adds money, takes back money not lent, and stops, each measured against the chain', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const lender = accountFor('lender').address;
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('1'));
  // An Auto-lend already set up and funded with 0.5 WETH, as the setup flow does.
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, 0, parseEther('1'), 500n, 5000, 30, parseEther('0.05'), false, 0n, false, true, await txDeadline(sc)]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, 0, parseEther('0.5')]);
  const capital = () => sc.read<bigint>('getLenderIntentCapital', [lender, WETH, tliq, 0]);
  const allowance = () => sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] });

  const { page, flags } = await launchWallet('lender');
  await page.goto('/positions');
  await connectWallet(page);
  const card = page.getByTestId('autolend-card');
  await expect(card).toHaveAttribute('data-state', 'active', { timeout: 60_000 });

  // Add: an exact approval, then the funding; the chain agrees and the approval is used up.
  await card.getByTestId('autolend-add').click();
  await card.getByTestId('autolend-manage-amount').fill('0.2');
  await card.getByTestId('autolend-manage-review').click();
  const add = card.getByTestId('autolend-manage-add');
  await expect(add.locator('.receipt')).toContainText('Add money to Auto-lend', { timeout: 60_000 });
  await expect(add.locator('.receipt')).toContainText('Waiting to be lent after this');
  await expect(add.locator('.receipt')).toContainText('does not promise a fill');
  await fitsWidth(page);
  let sent = flags.sentTransactions;
  await add.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(add.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(flags.sentTransactions).toBe(sent + 2);
  expect(await capital()).toBe(parseEther('0.7'));
  expect(await allowance()).toBe(0n);
  await add.getByRole('button', { name: 'Close' }).click();

  // Take back: more than waits is refused in the review; less goes back to the wallet.
  await expect(card).toContainText('Waiting to be lent: 0.7', { timeout: 60_000 });
  await card.getByTestId('autolend-takeBack').click();
  await card.getByTestId('autolend-manage-amount').fill('0.8');
  await card.getByTestId('autolend-manage-review').click();
  const back = card.getByTestId('autolend-manage-takeBack');
  await expect(back).toContainText('Only 0.7', { timeout: 60_000 });
  await expect(back.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await back.getByTestId('autolend-manage-edit').click();
  await card.getByTestId('autolend-manage-amount').fill('0.3');
  await card.getByTestId('autolend-manage-review').click();
  await expect(back.locator('.receipt')).toContainText('Take back money not lent', { timeout: 60_000 });
  await expect(back.locator('.receipt')).toContainText('Your wallet, at once');
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lender] });
  sent = flags.sentTransactions;
  await back.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(back.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(back.locator('[data-phase="measured"]')).toContainText('received in your wallet');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await capital()).toBe(parseEther('0.4'));
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lender] })).toBe(before + parseEther('0.3'));
  await back.getByRole('button', { name: 'Close' }).click();

  // Stop, taking back the rest in the same transaction.
  await expect(card).toContainText('Waiting to be lent: 0.4', { timeout: 60_000 });
  await card.getByTestId('autolend-stop').click();
  await expect(card.getByTestId('autolend-stop-takeback')).toBeChecked();
  await card.getByTestId('autolend-manage-review').click();
  const stop = card.getByTestId('autolend-manage-stop');
  await expect(stop.locator('.receipt')).toContainText('No new loans from this Auto-lend', { timeout: 60_000 });
  await expect(stop.locator('.receipt')).toContainText('Loans already made run to their end');
  await fitsWidth(page);
  sent = flags.sentTransactions;
  await stop.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(stop.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(stop.locator('[data-phase="measured"]')).toContainText('Auto-lend stopped on this pair');
  expect(flags.sentTransactions).toBe(sent + 1);
  const intent = await sc.read<StoredIntent>('getLenderIntent', [lender, WETH, tliq, 0]);
  expect(intent.active).toBe(false);
  expect(await capital()).toBe(0n);
  // Stopped with nothing set aside, the protocol drops it from the wallet's
  // list; the finish card stays until it is closed, then the card is gone.
  await expect(card).toHaveAttribute('data-state', 'gone', { timeout: 60_000 });
  await expect(card).toContainText('leaves this list once you close this');
  await stop.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('autolend-card')).toHaveCount(0, { timeout: 60_000 });
});

test('on Positions a lender changes the limits, stops keeping money set aside, and starts again with more', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const lender = accountFor('lender').address;
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('1'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, 0, parseEther('1'), 500n, 5000, 30, parseEther('0.05'), false, 0n, false, true, await txDeadline(sc)]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, 0, parseEther('0.5')]);
  const capital = () => sc.read<bigint>('getLenderIntentCapital', [lender, WETH, tliq, 0]);
  const stored = () => sc.read<StoredIntent>('getLenderIntent', [lender, WETH, tliq, 0]);
  const firstSetAt = (await stored()).termsSetAt;

  const { page, flags } = await launchWallet('lender');
  await page.goto('/positions');
  await connectWallet(page);
  const card = page.getByTestId('autolend-card');
  await expect(card).toHaveAttribute('data-state', 'active', { timeout: 60_000 });

  // Change: the form opens on the recorded limits; only the rate moves.
  await card.getByTestId('autolend-change').click();
  const form = card.getByTestId('autolend-form');
  await expect(form).toContainText('Change Auto-lend');
  await expect(card.getByTestId('autolend-rate')).toHaveValue('5');
  await expect(card.getByTestId('autolend-ltv')).toHaveValue('50');
  await expect(card.getByTestId('autolend-days')).toHaveValue('30');
  await expect(card.getByTestId('autolend-amount')).toHaveValue('');
  await card.getByTestId('autolend-rate').fill('6');
  await fitsWidth(page);
  await card.getByTestId('autolend-review').click();
  const setup = card.getByTestId('autolend-setup');
  const receipt = setup.locator('.receipt');
  await expect(receipt).toContainText('Change Auto-lend', { timeout: 60_000 });
  await expect(receipt).toContainText('Nothing: no money is added');
  await expect(receipt).toContainText('6% a year');
  await expect(receipt).toContainText('this change restarts that wait');
  await expect(receipt).toContainText('Loans already made keep the terms they were made on');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);
  await setup.getByTestId('autolend-consent').check();
  let sent = flags.sentTransactions;
  await setup.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(setup.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(flags.sentTransactions).toBe(sent + 1);
  // The chain agrees: the new rate, the limits not typed kept as recorded,
  // the money untouched and the wait restarted.
  let intent = await stored();
  expect(intent.minRateBps).toBe(600n);
  expect(intent.maxExposure).toBe(parseEther('1'));
  expect(intent.minFillAmount).toBe(parseEther('0.05'));
  expect(intent.termsSetAt > firstSetAt).toBe(true);
  expect(await capital()).toBe(parseEther('0.5'));
  await setup.getByRole('button', { name: 'Close' }).click();

  // Stop, keeping the money set aside: the card stays, stopped.
  await card.getByTestId('autolend-stop').click();
  await card.getByTestId('autolend-stop-takeback').uncheck();
  await card.getByTestId('autolend-manage-review').click();
  const stop = card.getByTestId('autolend-manage-stop');
  sent = flags.sentTransactions;
  await stop.getByRole('button', { name: 'Confirm in wallet' }).click({ timeout: 60_000 });
  await expect(stop.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await stop.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

  // Start again, adding money in the same step.
  await card.getByTestId('autolend-change').click();
  await expect(card.getByTestId('autolend-form')).toContainText('Start Auto-lend again');
  await card.getByTestId('autolend-amount').fill('0.1');
  await card.getByTestId('autolend-review').click();
  const again = card.getByTestId('autolend-setup');
  await expect(again.locator('.receipt')).toContainText('This starts the Auto-lend again', { timeout: 60_000 });
  await expect(again.locator('.receipt')).toContainText('Added from your wallet to your own vault');
  await expect(again.locator('.receipt')).toContainText('Wallet prompts: 2');
  await again.getByTestId('autolend-consent').check();
  sent = flags.sentTransactions;
  await again.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(again.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(flags.sentTransactions).toBe(sent + 2);
  intent = await stored();
  expect(intent.active).toBe(true);
  expect(intent.minRateBps).toBe(600n);
  expect(await capital()).toBe(parseEther('0.6'));
  await again.getByRole('button', { name: 'Close' }).click();
  await expect(card).toHaveAttribute('data-state', 'active', { timeout: 60_000 });
});
