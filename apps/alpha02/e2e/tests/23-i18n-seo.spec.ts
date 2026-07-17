/** SEO + display-language surface (SEO/multilang batch).
 *
 *  Three load-bearing behaviours:
 *   - per-route head metadata: public routes carry a route-specific
 *     title + production-origin canonical and NO robots restriction;
 *     per-user routes (settings et al.) carry `noindex` and no
 *     canonical — the policy that keeps wallet-scoped pages out of
 *     search indexes while the product surfaces stay indexable.
 *   - the Settings Language picker persists the PREFERENCE
 *     (localStorage — the key the pre-paint bootstrap reads — and
 *     the picker selection survive a reload), while `<html lang>`
 *     declares the CONTENT language: a placeholder locale (bundle
 *     still `{}`) renders English fallback text, so the attribute
 *     stays `en` until the locale's translation actually ships —
 *     no matter how the preference arrived (Codex #1309 r5).
 *   - placeholder locales render ENGLISH text after switching —
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

test('language preference persists; placeholder locales render English with honest <html lang>', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });

  const picker = page.getByLabel('Display language');
  await expect(picker).toBeVisible();
  // Wave 1: English + the four first-wave codes, exactly.
  await expect(picker.locator('option')).toHaveCount(5);

  await picker.selectOption('es');
  // The PREFERENCE took: the picker reflects it immediately…
  await expect(picker).toHaveValue('es');
  // …but es ships as a placeholder bundle ({}), so the rendered text
  // is the English fallback (not raw keys, not a blank remount) and
  // <html lang> keeps declaring the CONTENT language honestly.
  await expect(
    page.getByRole('heading', { name: 'Language', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // Same-origin persistence (the pre-paint bootstrap in index.html
  // reads this key before React mounts) — the preference survives a
  // reload even though the stamp stays English until the translation
  // ships.
  expect(
    await page.evaluate(() => localStorage.getItem('vaipakam:language')),
  ).toBe('es');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Display language')).toHaveValue('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // And back to English.
  await page.getByLabel('Display language').selectOption('en');
  await expect(page.getByLabel('Display language')).toHaveValue('en');
  expect(
    await page.evaluate(() => localStorage.getItem('vaipakam:language')),
  ).toBe('en');
});
