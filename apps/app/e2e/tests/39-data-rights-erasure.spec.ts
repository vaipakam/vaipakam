/** Data Rights erasure in a non-English locale (#2038).
 *
 *  The erasure resets the language to English FIRST, deliberately, so its
 *  own sweep removes what that change persists. `LanguageRemount` replaces
 *  the whole page tree on that event — so for anyone not already in
 *  English, the Data Rights page that started the erasure is swapped out
 *  while the erasure is still running. When the erasure's busy flag and
 *  result lived in that page, the replacement came up idle and the result
 *  went to an instance that no longer existed: the user saw no report at
 *  all. This drives exactly that path in a real browser — the remount is a
 *  rendering-lifecycle event no unit test in this repo can reach — and
 *  asserts the report survives it.
 */
import { test, expect } from '../lib/wallet-fixture';

test('an erasure started in Spanish still reports what it did after the language reset', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender', { preAuthorized: false });
  // A non-English preference, chosen the way a user chooses it (the
  // `vaipakam_lang` cookie the factory writes is authoritative, so seeding
  // localStorage alone is overridden), plus one ordinary record to erase.
  await page.goto('/settings', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Display language').selectOption('es');
  await expect(page.getByLabel('Idioma de visualización')).toHaveValue('es');
  await page.evaluate(() => {
    localStorage.setItem('app.powerSurfaceNoteDismissed', '1');
  });
  await page.goto('/data-rights', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Tus datos' })).toBeVisible();

  await page.getByRole('button', { name: 'Borrar mis datos' }).click();
  await page.getByRole('button', { name: 'Sí, bórralo' }).click();

  // The language is back to English — the page was remounted — and the
  // report from the erasure that page started is shown in the new one.
  const report = page.getByRole('status').filter({ hasText: /Erased \d+ stored items/ });
  await expect(report).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Your data' })).toBeVisible();
  // The confirmation closed with the report rather than staying armed.
  await expect(page.getByRole('button', { name: 'Yes, erase it' })).toHaveCount(0);

  // And the erasure actually ran: both records are gone, the language
  // preference the reset wrote included.
  const left = await page.evaluate(() => ({
    language: localStorage.getItem('vaipakam:language'),
    note: localStorage.getItem('app.powerSurfaceNoteDismissed'),
  }));
  expect(left).toEqual({ language: null, note: null });
});
