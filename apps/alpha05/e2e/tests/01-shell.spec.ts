/**
 * The shell (rulebook §3.1 foundations): the page map answers every route,
 * the primary navigation is DERIVED from the page map by mode, a page not
 * built yet says so, and the one help panel opens from a "Why?" and closes
 * from its control, from Escape and from the scrim, returning focus.
 */
import { expect, test } from '../lib/wallet';

const BASIC_NAV = ['Home', 'Borrow', 'Lend', 'Positions', 'Claims', 'Vault', 'Offers', 'Rent', 'Rewards'];
const ADVANCED_ONLY = ['Protection', 'Desk', 'Console', 'Recover', 'Analytics'];

test('the shell loads with the derived Basic navigation and the under-construction notice', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await expect(page.getByRole('status').filter({ hasText: 'next version of the Vaipakam app' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const name of BASIC_NAV) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  for (const name of ADVANCED_ONLY) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  // The build line states the commit and time the bundle was made from.
  await expect(page.locator('footer').getByText(/^Build \S+ · /)).toBeVisible();
});

test('Advanced mode adds the advanced primary pages and the mode line follows', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { advanced: true });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const name of [...BASIC_NAV, ...ADVANCED_ONLY]) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.locator('footer').getByText('Mode: advanced.')).toBeVisible();
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Basic' }).click();
  for (const name of ADVANCED_ONLY) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(page.locator('footer').getByText('Mode: basic.')).toBeVisible();
});

test('a page not built yet says so and links the current app for the same job', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/positions/7');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Position');
  await expect(page.getByText('This page is not built yet in the new app.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open it in the current app' })).toHaveAttribute('href', 'https://app.vaipakam.com/positions/7');
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No page here');
});

test('"Why?" opens the help panel on the explanation and closes three ways, returning focus', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const why = page.locator('footer').getByRole('button', { name: 'Why?' });
  await why.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Mode: basic.');
  await expect(dialog.getByText('Basic shows the capabilities most people need.', { exact: false })).toBeVisible();
  // The guide deep link follows the reader's mode and the key's anchor.
  await expect(dialog.getByRole('link', { name: 'Read more in the user guide' })).toHaveAttribute('href', 'https://vaipakam.com/help/basic#advanced-mode');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  // 1. the close control
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(why).toBeFocused();
  // 2. Escape
  await why.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(why).toBeFocused();
  // 3. the scrim
  await why.click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('help-scrim').click({ position: { x: 10, y: 10 } });
  await expect(dialog).toHaveCount(0);
});
