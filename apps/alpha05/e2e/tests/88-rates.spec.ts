/**
 * Observed rates (#3751, RB-RATES): a public page, reached from Analytics,
 * with no wallet. For the network's WETH it shows the index's two halves
 * side by side and labelled apart: the outside source, not published until
 * the protocol's term-average view exists, and the platform's own repaid
 * loans by range, a withheld point saying "not enough loans yet". The rule
 * is stated from the index's answer, the daily history lists only the
 * days the index filled, and a refusal (the request limit) shows no
 * figure. The stand-in index serves the answers the spec stores, in the
 * index's shape; how every state is worded is held by the page's unit test.
 */
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { setRates } from '../lib/stub';
import { expect, test } from '../lib/wallet';
import { curveAnswer, historyAnswer } from '../../src/shared/rates/curveFixture';

const CHAIN = 84532;

async function noOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the page shows both halves apart, labels points by range and states the rule, with no wallet', async ({ launchWallet }) => {
  const now = Math.floor(Date.now() / 1000);
  await setRates({ curve: curveAnswer(CHAIN, WETH, now - 300) });
  await setRates({ history: historyAnswer(CHAIN, WETH, 30, Math.floor(now / 86_400)) });
  const { page } = await launchWallet('visitor', { preAuthorized: false });

  await page.goto(`/analytics?chain=${CHAIN}`);
  await page.getByRole('link', { name: 'See observed loan rates by term' }).click();
  await expect(page).toHaveURL(/\/rates\?chain=84532$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Observed rates' })).toBeVisible();

  await expect(page.getByTestId('rates-as-of')).toContainText('Computed by the index at', { timeout: 30_000 });
  await expect(page.getByTestId('rates-notice')).toContainText('They are not advice, a forecast or an offer');

  const reference = page.getByTestId('rates-reference');
  await expect(reference).toHaveAttribute('data-state', 'not-published');
  await expect(reference).toContainText('Not available yet. The protocol’s contract view for this average does not exist yet');

  const own = page.getByTestId('rates-own');
  const shown = own.locator('[data-testid="rates-own-term"][data-days="30"]');
  await expect(shown).toHaveAttribute('data-state', 'shown');
  await expect(shown).toContainText('15–60 days');
  await expect(shown).toContainText('5.2%');
  await expect(shown).toContainText('4.8% to 5.75%');
  await expect(shown).toContainText('From 14 loans, 6 lenders and 9 borrowers.');
  const short = own.locator('[data-testid="rates-own-term"][data-days="7"]');
  await expect(short).toContainText('Up to 14 days');
  await expect(short).toContainText('Not enough loans yet');
  await expect(own.locator('[data-testid="rates-own-term"][data-days="365"]')).toContainText('Over 270 days');

  await page.getByTestId('rates-how').locator('summary').click();
  await expect(page.getByTestId('rates-rule')).toContainText('Largest share one wallet may carry, per side');
  await expect(page.getByTestId('rates-rule-excludes')).toContainText('loans whose rate followed a link');
  await expect(page.getByTestId('rates-rule-points')).toContainText('Over 270 days: loans started in the last 730 days');

  await page.getByTestId('rates-history-term').selectOption('30');
  await expect(page.getByTestId('rates-history')).toContainText('a missing day is not a zero');
  await expect(page.getByTestId('rates-history-rows').locator('tbody tr')).toHaveCount(3);
  await noOverflow(page);
});

test('an index refusing for its request limit shows no figure, and an uncomputed asset says so', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await setRates({ status: 429 });
  await page.goto(`/rates?chain=${CHAIN}`);
  await expect(page.getByTestId('rates-failed')).toContainText('too many requests right now', { timeout: 30_000 });
  await expect(page.getByTestId('rates-own')).toHaveCount(0);

  await setRates({ status: null });
  await page.reload();
  await expect(page.getByTestId('rates-as-of')).toContainText('has not computed rates for WETH yet', { timeout: 30_000 });
  await expect(page.locator('[data-testid="rates-own-term"][data-state="not-computed"]')).toHaveCount(5);
  await noOverflow(page);
});
