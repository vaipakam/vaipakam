/**
 * The self-custody wallet notice (#3671, RB-WALLET-KEYS): the wallet picker
 * and Home (with no wallet) say a self-custody wallet is needed and that
 * its keys cannot be recovered here, linked to the key-safety page; that
 * page is one tap from the footer with no wallet and names no wallet brand;
 * and a connect left pending when the picker closes never leaves the
 * connect button stuck. Runs on the desktop and the phone project.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const NEEDED = 'You need a self-custody wallet';

test('the key-safety page is one tap from the footer, with no wallet, and names no wallet brand', async ({ page }) => {
  await page.goto('/');
  await page.locator('footer').getByRole('link', { name: 'Your wallet and its keys' }).click();
  await expect(page).toHaveURL(/\/wallet-keys$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your wallet and its keys' })).toBeVisible();
  const page_ = page.getByTestId('wallet-keys-page');
  await expect(page_).toContainText('This platform does not create or hold wallets.');
  await expect(page.getByTestId('wallet-keys-points').locator('li')).toHaveCount(6);
  await expect(page_).toContainText('No one from this platform will ever ask for it.');
  await expect(page_).not.toContainText(/metamask|coinbase|rabby|ledger|trezor|phantom|trust wallet/i);
  await expect(page_.getByRole('link', { name: 'All key risks' })).toHaveAttribute('href', '/risks');
  await fitsWidth(page);
});

test('Home and the wallet picker say a self-custody wallet is needed before anything connects', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/');
  const home = page.getByTestId('home-wallet-needed');
  await expect(home).toContainText(NEEDED);
  await expect(home).toContainText('cannot recover them');
  await expect(home.getByRole('link', { name: 'Keeping your keys safe' })).toHaveAttribute('href', '/wallet-keys');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  // The picker renders its disclaimer twice (one copy only measures the
  // sheet's height), so the visible one is the one read.
  const picker = page.getByTestId('picker-wallet-needed').filter({ visible: true });
  await expect(picker).toBeVisible();
  await expect(picker).toContainText(NEEDED);
  const link = picker.getByRole('link', { name: 'Keeping your keys safe' });
  await expect(link).toHaveAttribute('href', '/wallet-keys');
  await expect(link).toHaveAttribute('target', '_blank');
  await fitsWidth(page);
});

test('a connect still pending when the picker closes leaves the connect button pressable', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  // The wallet never answers the connection request, as a phone connection
  // that was never completed does.
  await page.addInitScript(() => {
    const w = window as unknown as { __walletRequest: (p: { method: string }) => Promise<unknown> };
    const answer = w.__walletRequest;
    w.__walletRequest = (p) => (p.method === 'eth_requestAccounts' || p.method === 'wallet_requestPermissions' ? new Promise(() => {}) : answer(p));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /vaipakam test wallet/i })
    .first()
    .click();
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const connect = page.locator('.wallet').getByRole('button', { name: 'Connect wallet' });
  await expect(connect).toBeEnabled();
  await expect(page.locator('.wallet').getByText('Connecting…')).toHaveCount(0);
  await connect.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
