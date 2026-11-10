/**
 * Installing the app (#3180; ACC-11, RB-INSTALL). The manifest names the app,
 * its icons and the four shortcuts (Offers, Positions, Vault, Alerts), and
 * every icon it lists is served. Settings › Install the app is Advanced:
 * where the browser has not offered installation it says so instead of
 * showing a button; where it has, the button opens the browser's own prompt
 * and the page states the browser's answer. The service worker is a
 * production-build feature, checked by its unit tests and the live driver;
 * this dev server registers none. Runs on the desktop and the phone.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Stands in for the browser's one-time install offer, answered `outcome`. */
async function offerInstall(page: Page, outcome: 'accepted' | 'dismissed'): Promise<void> {
  await page.evaluate((o) => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(e, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: o }) });
    window.dispatchEvent(e);
  }, outcome);
}

test('the manifest names the app, its icons and the four shortcuts, and every icon is served', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBe('/manifest.webmanifest');
  const manifest = (await (await page.request.get(href!)).json()) as { name: string; display: string; start_url: string; icons: { src: string; purpose: string }[]; shortcuts: { name: string; url: string }[] };
  expect(manifest).toMatchObject({ name: 'Vaipakam', display: 'standalone', start_url: '/' });
  expect(manifest.shortcuts.map((s) => [s.name, s.url])).toEqual([
    ['Offers', '/offers'],
    ['Positions', '/positions'],
    ['Vault', '/vault'],
    ['Alerts', '/alerts'],
  ]);
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const res = await page.request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
});

test('Settings: Advanced only; no button where the browser has not offered, the browser’s answer stated where it has', async ({ page }) => {
  await page.goto('/settings');
  const section = page.getByTestId('settings-install');
  await expect(page.getByTestId('settings-display')).toBeVisible();
  await expect(section).toHaveCount(0);

  await page.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
  await expect(section).toContainText('has not offered to install the app on this page');
  await expect(section).toContainText('never from saved copies');
  await expect(section.getByTestId('settings-install-button')).toHaveCount(0);

  await offerInstall(page, 'dismissed');
  await section.getByTestId('settings-install-button').click();
  await expect(section).toContainText('Not installed. You can install it here at any time.');
  await expect(section.getByTestId('settings-install-button')).toHaveCount(0);

  await offerInstall(page, 'accepted');
  await section.getByTestId('settings-install-button').click();
  await expect(section.getByTestId('settings-install-state')).toHaveAttribute('data-installed', 'yes');
  await expect(section).toContainText('Installed; it is with your other apps now.');
  await fitsWidth(page);
});
