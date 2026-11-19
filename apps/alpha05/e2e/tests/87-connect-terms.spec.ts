/**
 * #3734 — the Terms come before the wallet: with Terms in force, Connect
 * opens the Terms step (version, fingerprint, the pinned link, privacy, key
 * risks and a box to tick) and the wallet list opens only from "Agree and
 * connect" once the box is ticked. "Not now" connects nothing. With no Terms
 * in force, Connect opens the wallet list at once. Once connected, the
 * wallet's own paid acceptance is asked at once and the page body waits for
 * it; declining leaves only the close-out actions. A small update is a quiet
 * optional line; a material change is announced with its date, can be put
 * off until then, and a wallet joining during the notice accepts both
 * versions in one transaction. Runs on the desktop and the phone project.
 */
import type { Page } from '@playwright/test';
import { keccak256, toHex } from 'viem';
import { scenario } from '../lib/chain';
import { increaseTime } from '../lib/anvil';
import { acceptTermsAtConnect, closeOutOnly, connectWallet, expect, test } from '../lib/wallet';
import { accountFor } from '../lib/wallets';

const DAY = 24 * 60 * 60;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('with no Terms in force, Connect opens the wallet list at once', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByTestId('connect-terms')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /vaipakam test wallet/i }).first()).toBeVisible({ timeout: 10_000 });
});

test('with Terms in force, Connect shows them first and opens the wallet list only once they are ticked', async ({ launchWallet }) => {
  const sc = scenario();
  // The suite reverts the chain after every test, so later specs start with none.
  const hash = keccak256(toHex('alpha05 e2e Terms v1'));
  await sc.diamondWrite('admin', 'publishTos', [1, hash]);
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/');

  // "Not now" connects nothing and opens no wallet list.
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  const step = page.getByTestId('connect-terms');
  await expect(step).toBeVisible();
  await expect(step.getByRole('heading', { name: 'Before you connect' })).toBeVisible();
  await step.getByRole('button', { name: 'Not now' }).click();
  await expect(step).toHaveCount(0);
  await expect(page.getByRole('button', { name: /vaipakam test wallet/i })).toHaveCount(0);
  await expect(page.locator('.wallet').getByRole('button', { name: 'Connect wallet' })).toBeVisible();

  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByTestId('connect-terms-lead')).toContainText('in force on Base Sepolia, version 1');
  await expect(step.getByRole('link', { name: 'Read the Terms (version 1)' })).toHaveAttribute('href', 'https://vaipakam.com/terms/v1');
  await expect(step.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', 'https://vaipakam.com/privacy');
  // The whole fingerprint, grouped.
  await expect(page.getByTestId('connect-terms-fingerprint')).toContainText(hash.slice(2, 10));
  await expect(page.getByTestId('connect-terms-fingerprint')).toContainText(hash.slice(-8));
  await expect(page.getByTestId('connect-terms-key-risks').locator('li')).not.toHaveCount(0);
  await fitsWidth(page);

  const agree = page.getByTestId('connect-terms-choose');
  await expect(agree).toBeDisabled();
  await page.getByTestId('connect-terms-tick').check();
  await expect(agree).toBeEnabled();
  await agree.click();
  await expect(step).toHaveCount(0);
  await expect(page.getByRole('button', { name: /vaipakam test wallet/i }).first()).toBeVisible({ timeout: 10_000 });
});

test('once connected, the wallet records its own acceptance before the page body is shown', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  await sc.diamondWrite('admin', 'publishTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  await expect(page.getByTestId('terms-hold')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('vault-deposit-open')).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
  await expect(dialog).toContainText('Using this app with your wallet needs the Terms of Service', { timeout: 30_000 });
  await fitsWidth(page);
  const sent = flags.sentTransactions;
  await acceptTermsAtConnect(page);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read('isTermsCurrent', [accountFor('freshLender').address])).toBe(true);
  await expect(page.getByTestId('vault-deposit-open')).toBeVisible({ timeout: 30_000 });
});

test('declining at Connect keeps only the close-out actions, with a standing notice', async ({ launchWallet }) => {
  const sc = scenario({ lender: 'freshLender' });
  await sc.diamondWrite('admin', 'publishTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const sent = flags.sentTransactions;
  await closeOutOnly(page);
  await expect(page.getByTestId('connect-terms-exits')).toContainText('can repay, close, add collateral, claim, withdraw and cancel here');
  expect(flags.sentTransactions).toBe(sent);
  expect(await sc.read('isTermsCurrent', [accountFor('freshLender').address])).toBe(false);
  await fitsWidth(page);
});

test('a material change: shown at Connect with its date, put off until then, and accepted with the latest in one transaction', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ lender: 'freshLender' });
  await sc.diamondWrite('admin', 'publishTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const block = await sc.pub.getBlock({ blockTag: 'latest' });
  const effectiveAt = block.timestamp + BigInt(8 * DAY);
  await sc.diamondWrite('admin', 'announceTos', [2, keccak256(toHex('alpha05 e2e Terms v2')), effectiveAt]);

  const { page, flags } = await launchWallet('freshLender', { preAuthorized: false });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await expect(page.getByTestId('connect-terms-announced')).toContainText('Version 2 of the Terms comes into force on');
  await page.getByTestId('connect-terms-tick').check();
  await page.getByTestId('connect-terms-choose').click();
  await page
    .getByRole('button', { name: /vaipakam test wallet/i })
    .first()
    .click();

  // A first acceptance during the notice records both versions at once.
  const sent = flags.sentTransactions;
  await acceptTermsAtConnect(page);
  expect(flags.sentTransactions).toBe(sent + 1);
  const me = accountFor('freshLender').address;
  expect((await sc.read<readonly number[]>('getUserAcceptedTosVersions', [me])).map(Number)).toEqual([1, 2]);
  await expect(page.getByTestId('terms-update')).toHaveCount(0);
  await fitsWidth(page);
});

test('a current wallet that puts off a material change stays current until its date, then is asked again', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ lender: 'freshLender' });
  await sc.diamondWrite('admin', 'publishTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  await sc.diamondWrite('lender', 'acceptTerms', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const block = await sc.pub.getBlock({ blockTag: 'latest' });
  await sc.diamondWrite('admin', 'announceTos', [2, keccak256(toHex('alpha05 e2e Terms v2')), block.timestamp + BigInt(8 * DAY)]);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/');
  await connectWallet(page);
  const notice = page.getByTestId('terms-update');
  await expect(notice).toHaveAttribute('data-due', 'yes', { timeout: 60_000 });
  await expect(notice).toContainText('Version 2 of the Terms comes into force on Base Sepolia on');
  await expect(page.getByTestId('terms-hold')).toHaveCount(0);
  const sent = flags.sentTransactions;
  await page.getByTestId('terms-update-later').click();
  await expect(notice).toHaveCount(0);
  expect(flags.sentTransactions).toBe(sent);
  expect(await sc.read('isTermsCurrent', [accountFor('freshLender').address])).toBe(true);

  // Past the date the wallet is no longer current, and the page waits again.
  await increaseTime(8 * DAY + 60);
  await page.reload();
  await expect(page.getByTestId('terms-hold')).toBeVisible({ timeout: 60_000 });
  expect(await sc.read('isTermsCurrent', [accountFor('freshLender').address])).toBe(false);
});
