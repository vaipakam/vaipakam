/** UX2-001 regression guard — the CONNECTED phone header must never
 *  widen the page. The 2026-07-13 second-pass live review found every
 *  route at 390px scrolling ~71px sideways once a wallet connected
 *  (the brand cluster + network dot + wallet chip out-widthed the
 *  viewport; flex items don't shrink below content size by default).
 *  Asserts the whole-document invariant, not a pixel layout, so ANY
 *  future header addition that reintroduces the class fails here.
 *  Also pins UX2-006: the disconnected "Connect wallet" label renders
 *  on one line. */
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import type { Page } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll, `${where}: page must not scroll sideways`).toBeLessThanOrEqual(
    widths.client + 1,
  );
}

test('connected phone header does not overflow the viewport', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.setViewportSize(PHONE);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  // The address chip is the widest connected-header element — wait for
  // it so the assertion measures the post-connect layout.
  await expect(page.locator('.connect-addr')).toBeVisible({ timeout: 15_000 });
  await expectNoHorizontalOverflow(page, '/');
  // A second, denser route: the desk carries the widest content.
  await page.goto('/desk', { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await expectNoHorizontalOverflow(page, '/desk');
});

test('disconnected phone header renders Connect wallet on one line', async ({
  launchWallet,
}) => {
  // preAuthorized:false = a real first visit — without it the fixture
  // wallet reports accounts pre-approval and the app (correctly)
  // treats the provider as already-connected, so the disconnected
  // header would be untestable in this tier.
  const { page } = await launchWallet('newLender', { preAuthorized: false });
  await page.setViewportSize(PHONE);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const label = page.locator('.shell-topbar .connect-label');
  await expect(label).toBeVisible();
  // One rendered line: the box is no taller than ~1.6 line-heights.
  const box = await label.boundingBox();
  expect(box, 'connect label must render').not.toBeNull();
  expect(box!.height, 'label must not wrap to two lines').toBeLessThan(30);
  await expectNoHorizontalOverflow(page, '/ (disconnected)');
});
