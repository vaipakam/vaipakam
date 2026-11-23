/** #3922 option A — an unavailable read says which source failed and
 *  quotes the indexer's request reference, or says plainly there is none.
 *
 *  The indexer's answer for one loan is replaced in the page: a 503 that
 *  carries a reference in `x-request-ref` (exposed through CORS, the way
 *  the Worker serves it), or no answer at all. The chain fallback runs
 *  against the fork-tier Anvil, where the loan does not exist, so the
 *  chain ANSWERS (no such loan) and the verdict stays the indexer's.
 *
 *  Asserted contract:
 *  1. A failed indexer read that carried a reference shows it beside the
 *     unavailable state.
 *  2. A read nothing answered says there is no reference, never a blank.
 *  3. Neither lands in browser storage.
 */
import type { Page } from '@playwright/test';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { copySource as copy } from '../../src/content/copy';

const LOAN = 987_654;
const REF = 'ABCDEFGHJK';

async function stubLoan(page: Page, answer: 'refused' | 'silent') {
  await page.route(`**/loans/${LOAN}?**`, (route) => {
    if (answer === 'silent') return route.abort('failed');
    return route.fulfill({
      status: 503,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-request-ref',
        'x-request-ref': REF,
      },
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    });
  });
}

async function storageText(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
}

test('a refused loan read quotes the indexer reference', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  await stubLoan(page, 'refused');
  await page.goto(`/positions/${LOAN}`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  const note = page.getByTestId('failed-read');
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toHaveAttribute('data-source', 'indexer');
  await expect(note).toContainText(REF);
  expect(await storageText(page)).not.toContain(REF);
});

test('a loan read nothing answered says there is no reference', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  await stubLoan(page, 'silent');
  await page.goto(`/positions/${LOAN}`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  const note = page.getByTestId('failed-read');
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toHaveAttribute('data-source', 'indexer');
  await expect(note).toContainText(copy.common.readNoAnswer);
});
