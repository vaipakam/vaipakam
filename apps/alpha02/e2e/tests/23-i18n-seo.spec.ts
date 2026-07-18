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
 *     declares the CONTENT language. With Spanish now a TRANSLATED
 *     locale, picking es re-renders the catalog in Spanish AND flips
 *     `<html lang>` to es — the "lang follows shipped translations"
 *     half COVERAGE.md flagged as unassertable until a real bundle
 *     landed.
 *   - placeholder locales (bundle still `{}`, e.g. te) render
 *     ENGLISH fallback text — the fallback chain, not raw keys or a
 *     crash — and `<html lang>` honestly stays `en` until that
 *     locale's translation ships, no matter how the preference
 *     arrived (Codex #1309 r5). Asserted via a seeded
 *     `vaipakam_lang` cookie: on the CI origin the cookie is
 *     host-scoped (writeCookie omits Domain on an IP), so the real
 *     cookie-authoritative seed path runs end-to-end. te (Telugu)
 *     has no scheduled bundle, so this leg stays valid as further
 *     locales promote (ta itself ships in this PR).
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

test('language preference persists; translated es flips content + <html lang>; placeholders stay honest', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });

  const picker = page.getByLabel('Display language');
  await expect(picker).toBeVisible();
  // Exactly the PICKER_VISIBLE set: wave-1 (en/es/zh/hi/ja) + ta.
  // Grows by one with every locale promoted into PICKER_VISIBLE —
  // bump this count in the same diff as the promotion.
  await expect(picker.locator('option')).toHaveCount(6);

  await picker.selectOption('es');
  // es is a TRANSLATED locale now: the catalog re-resolves in Spanish
  // (the picker's own aria-label included — re-query by the Spanish
  // label, which doubles as proof the chrome strings switched), the
  // Language card heading renders localized, and <html lang> flips to
  // the content language.
  const pickerEs = page.getByLabel('Idioma de visualización');
  await expect(pickerEs).toHaveValue('es');
  await expect(
    page.getByRole('heading', { name: 'Idioma', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');

  // Same-origin persistence (the pre-paint bootstrap in index.html
  // reads this key before React mounts) — preference AND stamp
  // survive a reload.
  expect(
    await page.evaluate(() => localStorage.getItem('vaipakam:language')),
  ).toBe('es');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Idioma de visualización')).toHaveValue('es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');

  // And back to English (via the Spanish-labelled picker).
  await page.getByLabel('Idioma de visualización').selectOption('en');
  await expect(page.getByLabel('Display language')).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(
    await page.evaluate(() => localStorage.getItem('vaipakam:language')),
  ).toBe('en');

  // Placeholder honesty, via the COOKIE leg: a `vaipakam_lang`
  // cookie carrying a locale alpha02 hasn't translated (te — no
  // Telugu bundle is scheduled, so this leg stays stable as more
  // locales promote; a sibling surface writing the cookie is how
  // such a preference arrives). The cookie is authoritative by
  // design, and on the CI origin writeCookie emits it host-scoped
  // (no Domain on an IP), so the exact seed path runs: the factory
  // copies the cookie into localStorage, the text renders as
  // English fallback (not raw keys), `<html lang>` honestly stays
  // `en`, and the preference is preserved — not scrubbed to en.
  await page.evaluate(() => {
    document.cookie = 'vaipakam_lang=te; Path=/; SameSite=Lax';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: 'Language', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(
    await page.evaluate(() => localStorage.getItem('vaipakam:language')),
  ).toBe('te');
});
