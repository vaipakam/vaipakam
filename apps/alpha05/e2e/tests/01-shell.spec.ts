/**
 * The shell (rulebook §3.1 foundations): the page map answers every route,
 * the primary navigation is DERIVED from the page map by mode, a page not
 * built yet says so, and the one help panel opens from a "Why?" and closes
 * from its control, from Escape and from the scrim, returning focus.
 */
import { connectWallet, expect, onPhone, openMenu, test } from '../lib/wallet';

const BASIC_NAV = ['Home', 'Borrow', 'Lend', 'Positions', 'Claims', 'Vault', 'Offers', 'Rent', 'Rewards'];
const ADVANCED_ONLY = ['Protection', 'Desk', 'Console', 'Recover', 'Analytics'];

test('the shell loads with the derived Basic navigation and the under-construction notice', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await expect(page.getByRole('status').filter({ hasText: 'next version of the Vaipakam app' })).toBeVisible();
  await openMenu(page);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  for (const name of BASIC_NAV) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  for (const name of ADVANCED_ONLY) await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
  // The build line states the commit and time the bundle was made from.
  await expect(page.locator('footer').getByText(/^Build \S+ · /)).toBeVisible();
});

test('Advanced mode adds the advanced primary pages and the mode line follows', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { advanced: true });
  await page.goto('/');
  await openMenu(page);
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
  // RB-ICONS: the info button shows the (i) alone, right after its sentence;
  // its name is "Why?", and its tap area is 44 px square whatever its drawn size.
  await expect(why).toHaveText('');
  await expect(why.locator('svg.icon-why')).toHaveAttribute('aria-hidden', 'true');
  const tap = await why.evaluate((b) => {
    const before = getComputedStyle(b, '::before');
    const r = b.getBoundingClientRect();
    const grow = (v: string) => -parseFloat(v) * 2;
    return { w: r.width + grow(before.left), h: r.height + grow(before.top) };
  });
  expect(tap.w).toBeGreaterThanOrEqual(44);
  expect(tap.h).toBeGreaterThanOrEqual(44);
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

test('at phone width the page never scrolls sideways, before and after connecting', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender', { preAuthorized: false });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  expect(await sideways()).toBeLessThanOrEqual(0);
  await connectWallet(page);
  await expect(page.getByTestId('wallet-chip')).toBeVisible();
  expect(await sideways()).toBeLessThanOrEqual(0);
});

test('on a phone the header is one row and a bottom bar carries the first destinations and More', async ({ launchWallet }, testInfo) => {
  test.skip(!onPhone(testInfo.project.name), 'the bottom bar exists at phone width only');
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  const viewportHeight = page.viewportSize()?.height ?? 844;
  // One row: brand and the wallet control. Well under a tenth of the screen.
  expect((await page.locator('header.topbar').boundingBox())?.height ?? Infinity).toBeLessThan(viewportHeight * 0.1);
  const bar = page.getByRole('navigation', { name: 'Quick access' });
  // The bar is derived from the same page map: its first four destinations.
  await expect(bar.getByRole('link')).toHaveText(BASIC_NAV.slice(0, 4));
  // RB-ICONS: each place shows its icon above its name, and the name always shows.
  for (const link of await bar.locator('a, button').all()) {
    const icon = link.locator('svg.icon-place');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
    const [i, l] = [await icon.boundingBox(), await link.locator('span').boundingBox()];
    expect(i && l && i.y + i.height <= l.y + 1).toBe(true);
  }
  const barBox = await bar.boundingBox();
  expect(barBox && barBox.y + barBox.height).toBeCloseTo(viewportHeight, 0);
  // The full navigation is folded into More until asked for.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeHidden();
  const more = bar.getByRole('button', { name: 'More' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  for (const name of BASIC_NAV) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Mode' })).toBeVisible();
  // Choosing a page closes the sheet.
  await nav.getByRole('link', { name: 'Rewards', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rewards');
  await expect(nav).toBeHidden();
  // A bar destination works directly.
  await bar.getByRole('link', { name: 'Borrow', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Borrow');
  // From the keyboard: opening the sheet moves focus into it, onto its first
  // destination, and Tab walks on through the destinations.
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Borrow', exact: true })).toBeFocused();
  // Escape closes the sheet and returns focus to More.
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(more).toBeFocused();
  // Nothing the page ends with sits under the bar: scrolled to the end, the
  // footer finishes at or above the bar's top edge (sub-pixel rounding aside).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const foot = await page.locator('footer').boundingBox();
  const bar2 = await bar.boundingBox();
  expect((foot?.y ?? Infinity) + (foot?.height ?? 0)).toBeLessThanOrEqual((bar2?.y ?? 0) + 2);
});
