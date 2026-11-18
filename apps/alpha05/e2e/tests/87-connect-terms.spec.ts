/**
 * #3734 — the Terms come before the wallet: with Terms in force, Connect
 * opens the Terms step (version, fingerprint, the pinned link, privacy, key
 * risks and a box to tick) and the wallet list opens only from "Agree and
 * connect" once the box is ticked. "Not now" connects nothing. With no Terms
 * in force, Connect opens the wallet list at once. Runs on the desktop and
 * the phone project.
 */
import type { Page } from '@playwright/test';
import { keccak256, toHex } from 'viem';
import { scenario } from '../lib/chain';
import { expect, test } from '../lib/wallet';

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
  await sc.diamondWrite('admin', 'setCurrentTos', [1, hash]);
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
