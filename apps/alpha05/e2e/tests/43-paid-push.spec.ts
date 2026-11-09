/**
 * Alerts › Paid push alerts (#3180 Alerts slice 3, ACC-53; RB-PAID-PUSH),
 * against the suite's chain. The card states the fee per loan side the
 * protocol holds on this network and whether the stand-in alert service says
 * it charges here; agreeing records a cap on chain, through the review and a
 * dry run, and the card then reads the cap back with the contract's own word
 * on whether it covers the fee. Withdrawing stays offered whatever the
 * service says. A fee raised after the review was read stops the wallet
 * from opening (RB-REVIEW); a cap below the fee or above the ceiling is
 * refused before the wallet; Terms in force are asked for before agreeing,
 * never before withdrawing. Runs on the desktop and the phone; the chain is
 * reverted after each test.
 */
import { keccak256, toHex, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { controlAgent } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

const BASE_SEPOLIA = 84532;
const VPFI = 10n ** 18n;

let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
  await controlAgent({ reset: true });
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openPaidPush(page: Page): Promise<void> {
  await page.goto('/alerts');
  await connectWallet(page);
  await expect(page.getByTestId('paid-push-fee')).toContainText('The fee is 0.5 VPFI per loan side', { timeout: 60_000 });
}

test('where the service charges, agreeing records a cap on chain and withdrawing clears it', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  await controlAgent({ billed: [BASE_SEPOLIA] });
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const { page, flags } = await launchWallet('freshBorrower');
  await openPaidPush(page);
  const card = page.getByTestId('paid-push');
  await expect(card.getByTestId('paid-push-billing')).toHaveAttribute('data-billing', 'charges');
  await expect(card.getByTestId('paid-push-consent')).toContainText('You have not agreed to pay, so no fee can be charged to you');
  await expect(card).toContainText('Telegram alerts are free.');
  // A fresh wallet has no vault, so no free VPFI: said, never left implied.
  await expect(card.getByTestId('paid-push-low')).toContainText('Your vault holds 0 free VPFI, less than the fee');
  await fitsWidth(page);

  await card.getByTestId('paid-push-agree').click();
  const flow = page.getByTestId('paid-push-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Agree to pay for push alerts', { timeout: 60_000 });
  await expect(receipt).toContainText('0.5 VPFI per loan side');
  await expect(receipt).toContainText('Nothing now; this records your agreement only');
  await expect(receipt).toContainText('A fee rise within your cap is charged without asking you again.');
  await expect(receipt).toContainText('A fee already charged is not refunded.');
  await expect(receipt).toContainText('Your vault holds 0 free VPFI, less than the 0.5 VPFI fee');
  await fitsWidth(page);
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Agreement recorded: up to 0.5 VPFI per loan side.');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read<readonly [bigint, boolean]>('getNotificationFeeConsent', [me])).toEqual([VPFI / 2n, true]);
  await finish.getByRole('button', { name: 'Close' }).click();

  const consent = card.getByTestId('paid-push-consent');
  await expect(consent).toContainText('You agreed to pay up to 0.5 VPFI per loan side. The contract judges that this covers the fee now.', { timeout: 60_000 });
  await expect(card.getByTestId('paid-push-agree')).toHaveCount(0);

  // The service stops answering: agreeing is not offered, withdrawing is.
  await controlAgent({ push: 'down' });
  await page.reload();
  await expect(card.getByTestId('paid-push-billing')).toHaveAttribute('data-billing', 'unknown', { timeout: 60_000 });
  await expect(card.getByTestId('paid-push-billing')).toContainText('could not be checked, so agreeing is not offered until it can');
  await card.getByTestId('paid-push-withdraw').click();
  await expect(receipt).toContainText('Withdraw the paid push agreement', { timeout: 60_000 });
  await expect(receipt).toContainText('From 0.5 VPFI to 0');
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Agreement withdrawn: no new fee can be charged to you.');
  expect(await sc.read<readonly [bigint, boolean]>('getNotificationFeeConsent', [me])).toEqual([0n, false]);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(consent).toHaveAttribute('data-cap', '0', { timeout: 60_000 });
  await expect(card.getByTestId('paid-push-withdraw')).toHaveCount(0);
});

test('where the service does not charge nothing is offered; a fee raised after the review stops the wallet', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const { page, flags } = await launchWallet('freshBorrower');
  await openPaidPush(page);
  const card = page.getByTestId('paid-push');
  await expect(card.getByTestId('paid-push-billing')).toContainText('does not charge for push alerts, so no agreement is needed here', { timeout: 30_000 });
  await expect(card.getByTestId('paid-push-agree')).toHaveCount(0);
  await expect(card.getByTestId('paid-push-low')).toHaveCount(0);

  await controlAgent({ billed: [BASE_SEPOLIA] });
  await page.reload();
  await card.getByTestId('paid-push-agree').click();
  const flow = page.getByTestId('paid-push-panel');
  await expect(flow.locator('.receipt')).toContainText('0.5 VPFI per loan side', { timeout: 60_000 });
  // Governance raises the fee while the review is open. Either the open
  // review re-reads it on its own and blocks the button, or the re-read
  // before the wallet opens catches it; either way it is said and nothing is
  // sent.
  await sc.diamondWrite('admin', 'setNotificationFee', [VPFI]);
  const sent = flags.sentTransactions;
  await flow
    .getByRole('button', { name: 'Confirm in wallet' })
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await expect(flow).toContainText(/The fee moved from 0\.5 to 1 VPFI|The cap must be at least the fee now, 1 VPFI/, { timeout: 60_000 });
  expect(flags.sentTransactions).toBe(sent);
  await fitsWidth(page);
});

test('in Advanced a cap is typed: below the fee or above the ceiling is refused, the ceiling is said to accept any fee', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  await controlAgent({ billed: [BASE_SEPOLIA] });
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const { page } = await launchWallet('freshBorrower', { advanced: true });
  await openPaidPush(page);
  const card = page.getByTestId('paid-push');
  const form = card.getByTestId('paid-push-cap-form');
  await expect(form).toContainText('From the fee now (0.5) up to the ceiling (50).');
  await form.getByTestId('paid-push-cap').fill('two');
  await form.getByTestId('paid-push-cap-agree').click();
  await expect(form).toContainText('Type a VPFI amount, like 2 or 2.5.');

  const flow = page.getByTestId('paid-push-panel');
  await form.getByTestId('paid-push-cap').fill('0.25');
  await form.getByTestId('paid-push-cap-agree').click();
  await expect(flow).toContainText('The cap must be at least the fee now, 0.5 VPFI.', { timeout: 60_000 });
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await flow
    .getByRole('button', { name: /^(Close|Cancel)$/ })
    .first()
    .click();

  await form.getByTestId('paid-push-cap').fill('51');
  await form.getByTestId('paid-push-cap-agree').click();
  await expect(flow).toContainText('The cap can be at most the protocol’s ceiling, 50 VPFI.', { timeout: 60_000 });
  await flow
    .getByRole('button', { name: /^(Close|Cancel)$/ })
    .first()
    .click();

  await form.getByTestId('paid-push-cap').fill('50');
  await form.getByTestId('paid-push-cap-agree').click();
  await expect(flow.locator('.receipt')).toContainText('50 VPFI is the ceiling: agreeing to it accepts any fee governance can set.', { timeout: 60_000 });
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toContainText('Agreement recorded: up to 50 VPFI per loan side.', { timeout: 90_000 });
  expect(await sc.read<readonly [bigint, boolean]>('getNotificationFeeConsent', [me])).toEqual([50n * VPFI, true]);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(card).toContainText('50 VPFI is the protocol’s ceiling, so this agreement accepts any fee governance can set.', { timeout: 60_000 });
  await fitsWidth(page);
});

test('with Terms in force, agreeing asks for them first; withdrawing never does', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  await controlAgent({ billed: [BASE_SEPOLIA] });
  const sc = scenario({ borrower: 'freshBorrower' });
  // A cap stored before the Terms were published.
  await sc.diamondWrite('borrower', 'setNotificationFeeConsent', [VPFI / 4n]);
  await sc.diamondWrite('admin', 'setCurrentTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const { page } = await launchWallet('freshBorrower');
  await openPaidPush(page);
  const card = page.getByTestId('paid-push');
  await expect(card.getByTestId('paid-push-consent')).toContainText('does not cover the fee now, so no fee can be charged until you agree again', { timeout: 30_000 });

  // Withdrawing opens its review at once: no Terms asked.
  await card.getByTestId('paid-push-withdraw').click();
  const flow = page.getByTestId('paid-push-panel');
  await expect(flow.locator('.receipt')).toContainText('Withdraw the paid push agreement', { timeout: 60_000 });
  await expect(page.getByRole('dialog', { name: 'Terms of Service' })).toHaveCount(0);
  await flow
    .getByRole('button', { name: /^(Close|Cancel)$/ })
    .first()
    .click();

  await card.getByTestId('paid-push-agree').click();
  const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
  await expect(dialog).toContainText('Agreeing to pay for push alerts needs the Terms of Service', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(dialog.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Continue: Agreeing to pay for push alerts' }).click();
  await expect(flow.locator('.receipt')).toContainText('Agree to pay for push alerts', { timeout: 60_000 });
  await fitsWidth(page);
});
