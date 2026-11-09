/**
 * Settings (#3180; ACC-06, ACC-13, ACC-14, ACC-15 status, ACC-35, ACC-61;
 * RB-SETTINGS), against the suite's chain. Settings is reached from the
 * navigation on every width; mode, theme and language need no wallet, apply
 * at once and survive a reload; a language not yet translated is said to
 * show English. A connected wallet sees which Terms it has accepted on its
 * network (none in force, then a version in force not yet accepted, asked at
 * the first action that needs it), and the fee-discount setting. The page
 * says this build sends no diagnostics. Your data (ACC-55): the count an
 * erasure would remove is stated before confirming; the download carries the
 * app's records and names the connected wallet; erasure disconnects the
 * wallet, resets every preference after the reload and reports what it
 * removed. Runs on the desktop and the phone; the chain is reverted.
 */
import { readFile } from 'node:fs/promises';
import { keccak256, toHex, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, openMenu, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Click the download button and parse the file it saves. */
async function download(page: Page): Promise<{ records: Record<string, unknown>; walletAddresses: string[]; notIncluded: Record<string, unknown> }> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByTestId('settings-data-download').click()]);
  expect(file.suggestedFilename()).toMatch(/^vaipakam-app-data-\d{4}-\d{2}-\d{2}\.json$/);
  return JSON.parse(await readFile((await file.path())!, 'utf8'));
}

/** Erase after reading the stated count; returns that count. */
async function erase(page: Page): Promise<number> {
  const data = page.getByTestId('settings-data');
  await data.getByTestId('settings-data-erase').click();
  const confirm = data.getByTestId('settings-data-confirm');
  await expect(confirm).toContainText('cannot be undone');
  await expect(confirm).toContainText('Your positions and history on chain are public and cannot be erased from here.');
  const count = Number(await data.getByTestId('settings-data-count').getAttribute('data-count'));
  expect(count).toBeGreaterThan(0);
  await expect(confirm).toContainText(`This erases ${count} items`);
  await confirm.getByTestId('settings-data-erase-confirm').click();
  await expect(page.getByTestId('settings-data-report')).toContainText('Erased at', { timeout: 15_000 });
  return count;
}

test('without a wallet: reached from the navigation; mode, theme and language apply at once and persist', async ({ page }) => {
  await page.goto('/');
  await openMenu(page);
  await page.getByTestId('nav-settings').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

  // Mode: the page's switch and the reader's choice agree after a reload.
  const mode = page.getByTestId('settings-mode');
  await mode.getByRole('button', { name: 'Advanced' }).click();
  await expect(mode).toContainText('Advanced adds exit and settlement tools');
  await page.reload();
  await expect(mode.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-pressed', 'true');
  await mode.getByRole('button', { name: 'Basic' }).click();
  await expect(mode).toContainText('Basic shows what most people need');

  // Theme: a choice stamps the page and is kept; System follows the device.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByTestId('settings-theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('settings-theme-state')).toContainText('Dark, chosen here');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('settings-theme-system').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('settings-theme-state')).toContainText('Following your device, which is in Light mode now.');

  // Language: ten offered; one not translated yet says it shows English.
  const select = page.getByTestId('settings-language-select');
  await expect(select.locator('option')).toHaveCount(10);
  await expect(page.getByTestId('settings-language-state')).toContainText('This app is translated into the language chosen.');
  await select.selectOption('es');
  await expect(page.getByTestId('settings-language-state')).toContainText('not translated into that language yet, so it shows English');
  // The page declares the language its text is in, which is still English.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByTestId('settings-language-select')).toHaveValue('es');
  await page.getByTestId('settings-language-select').selectOption('en');
  await expect(page.getByTestId('settings-language-state')).toContainText('This app is translated into the language chosen.');

  // Without a wallet: no Terms read, no fee setting; privacy said plainly.
  await expect(page.getByTestId('settings-legal')).toContainText('Connect a wallet to see which Terms it has accepted.');
  await expect(page.getByTestId('settings-fees')).toHaveCount(0);
  await expect(page.getByTestId('settings-diagnostics')).toContainText('sends no error reports or diagnostics to any server');

  // Your data: choose a dark theme and Advanced, download, then erase; after
  // the reload every preference is back to its default and the report stays.
  await page.getByTestId('settings-theme-dark').click();
  await mode.getByRole('button', { name: 'Advanced' }).click();
  const body = await download(page);
  expect(body.records['app.theme']).toBe('dark');
  expect(body.records['app.mode']).toBe('advanced');
  expect(body.walletAddresses).toEqual([]);
  expect(Object.keys(body.records).every((k) => k.startsWith('app.') || k.startsWith('alpha05.') || k.startsWith('vaipakam:language'))).toBe(true);
  await erase(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('settings-theme-state')).toContainText('Following your device');
  await expect(page.getByTestId('settings-mode').getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('app.')))).toEqual([]);
  await fitsWidth(page);
});

test('with a wallet: the Terms state on this network and the fee-discount setting', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    const { page, account } = await launchWallet('freshLender');
    await page.goto('/settings');
    await connectWallet(page);
    const terms = page.getByTestId('settings-terms');
    await expect(terms).toHaveAttribute('data-terms', 'none', { timeout: 30_000 });
    await expect(terms).toContainText('No Terms of Service are in force on');
    await expect(page.getByTestId('settings-fees').getByTestId('consent-toggle')).toBeVisible({ timeout: 30_000 });

    await sc.diamondWrite('admin', 'setCurrentTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
    await page.reload();
    await expect(terms).toHaveAttribute('data-terms', 'needed', { timeout: 30_000 });
    await expect(terms).toContainText('Version 1 is in force on');
    await expect(terms).toContainText('Repaying, claiming and withdrawing never do.');
    await expect(terms.getByRole('link', { name: 'Read the Terms (version 1)' })).toBeVisible();
    await fitsWidth(page);

    // The download names the connected wallet and leaves the wallet
    // connection's own items out; erasure ends the connection.
    const body = await download(page);
    expect(body.walletAddresses).toContain(account.address.toLowerCase());
    expect(Number(body.notIncluded.walletConnectionItems)).toBeGreaterThan(0);
    await erase(page);
    await expect(page.getByTestId('settings-data-report')).toContainText('Your wallet was disconnected.');
    await expect(page.getByTestId('settings-legal')).toContainText('Connect a wallet to see which Terms it has accepted.');
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
    await anvilRpc('evm_mine');
  }
});
