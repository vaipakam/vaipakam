/** #2643 — the Activity page shows a repaired loan's ending as an
 *  observation, and says so when it cannot know.
 *
 *  A repaired ending comes from the indexer's reconciliation pass, which no
 *  fork-tier scenario can trigger (it needs a terminal event the indexer
 *  missed for good). So the indexer's `/activity` answer is replaced in the
 *  page with the exact shape the Worker serves (`repairObservationToJson`,
 *  pinned by apps/indexer's own tests), and the wallet's participation ids
 *  with one loan of its own.
 *
 *  Asserted contract:
 *  1. The page ASKS for the entries (`repairObservations=1`); the fulfilled
 *     answer is served only to a request that does.
 *  2. An entry for the wallet's own loan renders as an observation: the
 *     loan, the status and the block it was seen by, no transaction link.
 *     An entry for a loan the wallet never touched is not shown.
 *  3. `repairObservations: null` (not known) is stated on the page, not
 *     read as "none".
 */
import type { Page } from '@playwright/test';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { CHAIN_ID } from '../lib/chain';

const MY_LOAN = 4242;
const NOT_MY_LOAN = 5555;
const BASE = 1_000_000_000;
const cors = { 'access-control-allow-origin': '*' };

function observation(loanId: number, observedBlock: number) {
  return {
    chainId: CHAIN_ID,
    loanId,
    observedStatus: 'repaid',
    observedBlock,
    observedAt: null,
    feedLogIndex: BASE + loanId,
    provenance: 'reconciliation',
  };
}

async function stubFeed(page: Page, repairObservations: unknown) {
  // The wallet's permanent participation ids: one loan of its own.
  await page.route('**/loans/by-participant?**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('fields') !== 'ids') return route.continue();
    return route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({ chainId: CHAIN_ID, loanIds: [MY_LOAN], truncated: false }),
    });
  });
  await page.route('**/activity?**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('repairObservations') !== '1') return route.continue();
    return route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({ chainId: CHAIN_ID, events: [], repairObservations, nextBefore: null }),
    });
  });
}

test('a repaired loan of the wallet shows as an observation, without a transaction', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await stubFeed(page, [observation(NOT_MY_LOAN, 1300), observation(MY_LOAN, 1234)]);
  await page.goto('/activity', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  const rows = page.getByTestId('activity-repair-observation');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toContainText(`Loan #${MY_LOAN} has ended`);
  await expect(rows.first()).toContainText('repaid by block 1234');
  await expect(rows.first()).toContainText('no transaction to show');
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', `/positions/${MY_LOAN}`);
  await expect(page.getByRole('link', { name: /view transaction/i })).toHaveCount(0);
  await expect(page.getByText(`Loan #${NOT_MY_LOAN}`)).toHaveCount(0);
  await expect(page.getByText(/may be missing the ending of a loan/i)).toHaveCount(0);
});

test('an unknown repaired-loan record is stated, not read as none', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  await stubFeed(page, null);
  await page.goto('/activity', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  await expect(page.getByText(/may be missing the ending of a loan/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('activity-repair-observation')).toHaveCount(0);
});
