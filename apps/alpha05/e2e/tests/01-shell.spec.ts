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
  await page.goto('/vault');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vault');
  await expect(page.getByText('This page is not built yet in the new app.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open it in the current app' })).toHaveAttribute('href', 'https://app.vaipakam.com/vault');
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
  // Put an info button where the sheet will open, just above the bar.
  const why = page.locator('main .why-link').first();
  await why.evaluate((b) => window.scrollBy(0, b.getBoundingClientRect().top - (window.innerHeight - 56 - 120)));
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  // The open sheet covers the page: the info button behind it does not paint over it.
  const behind = await why.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const sheet = document.querySelector('.site-menu[data-open="true"]')!;
    const s = sheet.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    return { under: y > s.top && y < s.bottom, onTop: sheet.contains(document.elementFromPoint(x, y)) };
  });
  expect(behind).toEqual({ under: true, onTop: true });
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

test('from 720px the navigation is a left column under a one-row header: a rail, then a panel', async ({ launchWallet }, testInfo) => {
  test.skip(onPhone(testInfo.project.name), 'the column exists from 720px only');
  const { page } = await launchWallet('visitor', { advanced: true });
  const header = page.locator('header.topbar');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const column = page.locator('.site-menu');
  for (const [width, kind] of [
    [1280, 'panel'],
    [900, 'rail'],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
    // One row: brand and wallet only; the column starts where the header ends.
    const h = (await header.boundingBox())!;
    const c = (await column.boundingBox())!;
    expect(h.height).toBeLessThanOrEqual(65);
    expect(c.x).toBe(0);
    expect(Math.abs(c.y - (h.y + h.height))).toBeLessThanOrEqual(1);
    // Every destination, each with its hidden place icon; the Advanced pages after the Basic ones, under their label.
    for (const name of [...BASIC_NAV, ...ADVANCED_ONLY]) {
      const link = nav.getByRole('link', { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link.locator('svg.icon-place')).toHaveAttribute('aria-hidden', 'true');
    }
    const advanced = nav.getByRole('group', { name: 'Advanced' });
    for (const name of ADVANCED_ONLY) await expect(advanced.getByRole('link', { name, exact: true })).toBeVisible();
    for (const name of BASIC_NAV) await expect(advanced.getByRole('link', { name, exact: true })).toHaveCount(0);
    // The page sits beside the column, never under it.
    const main = (await page.locator('#main').boundingBox())!;
    expect(main.x).toBeGreaterThanOrEqual(c.x + c.width - 1);
    // Rail: icon above a short name. Panel: icon beside the name.
    const home = nav.getByRole('link', { name: 'Home', exact: true });
    const [i, l] = [(await home.locator('svg').boundingBox())!, (await home.locator('span').boundingBox())!];
    // The main-menu button exists only where the panel can collapse.
    await expect(header.getByRole('button', { name: 'Main menu' })).toBeVisible({ visible: kind === 'panel' });
    if (kind === 'rail') {
      expect(c.width).toBeLessThan(110);
      expect(i.y + i.height).toBeLessThanOrEqual(l.y + 1);
    } else {
      expect(c.width).toBeGreaterThan(200);
      expect(i.x + i.width).toBeLessThanOrEqual(l.x + 1);
    }
    // The mode and theme controls are reachable at the column's foot.
    await expect(column.getByRole('group', { name: 'Mode' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test('from 1024px the panel collapses to its icons, reveals itself over the page on a resting pointer or focus, and remembers the choice', async ({ launchWallet }, testInfo) => {
  test.skip(onPhone(testInfo.project.name), 'the panel exists from 1024px only');
  const { page } = await launchWallet('visitor', { advanced: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const column = page.locator('.site-menu');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const width = async () => (await column.boundingBox())!.width;
  const pageX = async () => (await page.locator('#main').boundingBox())!.x;
  // Every move of the panel animates; measure once the motion has settled.
  const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  // The panel's width and the page beside it slide, on a quarter second.
  expect(await column.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('width');
  expect(await page.locator('.shell').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.25s');
  const expanded = await pageX();
  // The main-menu button: icon only at the far left of the header, named
  // "Main menu" with a hover tip, saying whether the panel shows its names.
  const menu = page.getByRole('banner').getByRole('button', { name: 'Main menu' });
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(menu).toHaveAttribute('title', 'Main menu');
  expect((await menu.innerText()).trim()).toBe('');
  const mb = (await menu.boundingBox())!;
  expect(Math.min(mb.width, mb.height)).toBeGreaterThanOrEqual(44);
  expect(mb.x).toBeLessThan((await page.getByRole('banner').getByRole('link', { name: 'Vaipakam home' }).boundingBox())!.x);
  const iconX = async () => (await nav.getByRole('link', { name: 'Borrow', exact: true }).locator('svg').boundingBox())!.x;
  const iconBefore = await iconX();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  // The icons do not move when the panel folds.
  await settled();
  expect(await iconX()).toBe(iconBefore);
  // Icons only; every destination still a named link; the page takes the room.
  await expect.poll(width).toBeLessThan(80);
  for (const name of [...BASIC_NAV, ...ADVANCED_ONLY]) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Borrow', exact: true }).locator('span')).toHaveCSS('opacity', '0');
  // The button sits over the column of icons.
  const icon = (await nav.getByRole('link', { name: 'Borrow', exact: true }).locator('svg').boundingBox())!;
  expect(Math.abs(mb.x + mb.width / 2 - (icon.x + icon.width / 2))).toBeLessThanOrEqual(4);
  const collapsedX = await pageX();
  expect(collapsedX).toBeLessThan(expanded);
  // A resting pointer reveals the full panel OVER the page, which does not move.
  const box = (await column.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await expect.poll(width).toBeGreaterThan(200);
  await settled();
  expect(await pageX()).toBe(collapsedX);
  await expect(nav.getByRole('link', { name: 'Borrow', exact: true }).locator('span')).toHaveCSS('opacity', '1');
  // Leaving hides it again, unless keyboard focus is inside it: focus a
  // control at its foot, leave, and it stays revealed with the control in view.
  const advancedButton = column.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Advanced' });
  await advancedButton.focus();
  await page.mouse.move(1000, 400);
  await page.waitForTimeout(900);
  expect(await width()).toBeGreaterThan(200);
  await expect(advancedButton).toBeVisible();
  await expect(advancedButton).toBeFocused();
  // Escape folds it and hands focus to the menu button, which stays in view.
  await page.keyboard.press('Escape');
  await expect.poll(width).toBeLessThan(80);
  await expect(menu).toBeFocused();
  await menu.blur();
  // The choice is remembered.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await expect.poll(width).toBeLessThan(80);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  // Keyboard: Tab from the menu button reaches the panel, which reveals
  // itself at once; Escape hides it and returns focus to the button.
  await menu.focus();
  await nav.getByRole('link', { name: 'Home', exact: true }).focus();
  await expect.poll(width).toBeGreaterThan(200);
  await page.keyboard.press('Escape');
  await expect.poll(width).toBeLessThan(80);
  await expect(menu).toBeFocused();
  // Expanding again restores the panel and the page beside it.
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(width).toBeGreaterThan(200);
  await expect.poll(pageX).toBe(expanded);
  // A reader who asks for less motion gets none.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await column.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
});
