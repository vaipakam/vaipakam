/** #3411 — the Activity page shows the wallet's actions above the chain's
 *  safe block at once, as pending, and says when it cannot know them.
 *
 *  The pending lane is filled by the indexer from blocks the chain has not
 *  yet called safe, which the fork tier's anvil (no indexer, instant blocks)
 *  cannot stage. So the indexer's `/activity` answer is replaced in the page
 *  with the exact shape the Worker serves (`pendingLane.ts`, pinned by
 *  apps/indexer's own tests), and the wallet's participation ids with one
 *  loan of its own.
 *
 *  Asserted contract:
 *  1. The page ASKS for the lane (`pending=1`); the fulfilled answer is
 *     served only to a request that does.
 *  2. A pending event on the wallet's own loan renders under "Not final yet"
 *     with the pending badge in place of a time; one on a loan the wallet
 *     never touched is not shown. With no final events, the page shows the
 *     pending section rather than its empty state.
 *  3. `pending: null` (not known) is stated on the page, not read as "none".
 */
import type { Page } from '@playwright/test';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { CHAIN_ID } from '../lib/chain';

const MY_LOAN = 4242;
const NOT_MY_LOAN = 5555;
const cors = { 'access-control-allow-origin': '*' };

function pendingEvent(loanId: number, blockNumber: number) {
  return {
    chainId: CHAIN_ID,
    blockNumber,
    logIndex: 0,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    txHash: `0x${(blockNumber * 7).toString(16).padStart(64, '0')}`,
    kind: 'LoanKeeperEnabled',
    loanId,
    offerId: null,
    actor: null,
    args: {},
    blockAt: null,
    final: false,
    asset: null,
    assetType: null,
    amount: null,
    amountMax: null,
    tokenId: null,
    quantity: null,
  };
}

async function stubFeed(page: Page, pending: unknown) {
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
    if (url.searchParams.get('pending') !== '1') return route.continue();
    return route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({ chainId: CHAIN_ID, events: [], repairObservations: [], pending, nextBefore: null }),
    });
  });
}

test('a pending action of the wallet shows at once, marked not final', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  await stubFeed(page, {
    events: [pendingEvent(NOT_MY_LOAN, 2001), pendingEvent(MY_LOAN, 2000)],
    finalThrough: 1990,
    throughBlock: 2010,
    latestBlock: 2010,
    readAt: Math.floor(Date.now() / 1000),
    complete: true,
  });
  await page.goto('/activity', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  await expect(page.getByRole('heading', { name: 'Not final yet' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Pending, not final yet')).toHaveCount(1);
  await expect(page.getByText(`Loan #${MY_LOAN}`)).toBeVisible();
  await expect(page.getByText(`Loan #${NOT_MY_LOAN}`)).toHaveCount(0);
  await expect(page.getByText(/may not be listed yet/i)).toHaveCount(0);
});

test('an unknown pending lane is stated, not read as none', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  await stubFeed(page, null);
  await page.goto('/activity', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  // No final and no known pending events: the empty state, plus the note.
  await expect(page.getByText(/may not be listed yet/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Not final yet' })).toHaveCount(0);
});
