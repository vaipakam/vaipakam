/** SEO + display-language surface (SEO/multilang batch).
 *
 *  Three load-bearing behaviours:
 *   - per-route head metadata: public routes carry a route-specific
 *     title + production-origin canonical and NO robots restriction;
 *     per-user routes (settings et al.) carry `noindex` and no
 *     canonical — the policy that keeps wallet-scoped pages out of
 *     search indexes while the product surfaces stay indexable.
 *   - the Settings Language picker switches `<html lang>` (and
 *     persists the choice for the next visit via localStorage — the
 *     same key the pre-paint index.html bootstrap reads).
 *   - placeholder locales (wave-1 codes shipped as `{}` bundles
 *     awaiting translation) render ENGLISH text after switching —
 *     the fallback chain, not raw keys or a crash.
 *
 *  The cross-subdomain `vaipakam_lang` cookie half of persistence is
 *  not assertable here (a `.vaipakam.com`-scoped cookie can't exist
 *  on the CI origin); localStorage is the same-origin leg of the same
 *  detection chain and IS asserted.
 */
import { test, expect } from '../lib/wallet-fixture';

test('public routes carry per-route meta; per-user routes are noindex', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle('Vaipakam — P2P lending, borrowing & NFT rental');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://alpha02.vaipakam.com/',
  );
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    /your own on-chain vault/,
  );

  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle('Settings — Vaipakam');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex',
  );
  // A canonical on a noindex page is contradictory — SeoMeta drops it.
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

  // Back to a public route: the noindex tag must NOT linger after a
  // client-side navigation (a stale one would silently deindex).
  await page.goto('/help', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle('Help — Vaipakam');
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});

test('language picker switches <html lang>, persists, and placeholder locales render English', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });

  const picker = page.getByLabel('Display language');
  await expect(picker).toBeVisible();
  // Wave 1: English + the four first-wave codes, exactly.
  await expect(picker.locator('option')).toHaveCount(5);

  await picker.selectOption('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  // es ships as a placeholder bundle ({}) — the UI must fall back to
  // the English copy (not raw keys, not a blank remount).
  await expect(
    page.getByRole('heading', { name: 'Language', exact: true }),
  ).toBeVisible();

  // Same-origin persistence (the pre-paint bootstrap in index.html
  // reads this key before React mounts).
  expect(
    await page.evaluate(() => localStorage.getItem('vaipakam:language')),
  ).toBe('es');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');

  // And back to English.
  await page.getByLabel('Display language').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
