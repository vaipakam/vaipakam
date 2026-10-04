/** #2386 — the Rate Desk ladder says what it is missing from the gasless
 *  signed book instead of rendering a chain-only ladder as if complete.
 *
 *  The classifier is pinned by `src/data/signedDepth.test.ts`. What it
 *  cannot show is the surface: that the note reaches the ladder card for
 *  each state the offer-book service can actually produce. The stub
 *  serves `/signed-offers` normally, so this drives three states on one
 *  market by intercepting only that route's GET:
 *
 *   1. untouched — the stub answers, nothing is missing, NO note;
 *   2. 503       — the "couldn’t load signed offers" note;
 *   3. a body flagged `truncated` — the "more signed offers than we
 *      load" note, which says the best rates are still complete.
 *
 *  State 1 is the control that keeps 2 and 3 honest: a note that showed
 *  on every load would pass both of them.
 *
 *  The market is an empty tenor (freshTenor only READS the chain), so no
 *  resting offer from another spec can change what the ladder shows. */
import { test, expect } from '../lib/wallet-fixture';
import { CHAIN_ID } from '../lib/chain';
import { freshTenor, openMarketViaCustomPair } from '../lib/desk';

test('the ladder discloses an unavailable or truncated signed book', async ({ launchWallet }) => {
  const tenor = await freshTenor();
  const { page } = await launchWallet('newBorrower', { advanced: true });
  const note = page.getByTestId('desk-signed-depth');
  const empty = page.getByText(/no open offers for this pair yet/i);
  // A predicate, not a glob: `?` is a glob metacharacter, and the same
  // reference must be handed to `unroute`.
  const signedBook = (url: URL) => url.pathname.endsWith('/signed-offers');
  // The stub is a different origin from the app, so a fulfilled body
  // needs the CORS header or the browser drops it — which would turn the
  // truncated case into an unavailable one and pass for the wrong reason.
  const cors = { 'access-control-allow-origin': '*' };

  // 1 — the service answers with a complete book: no note.
  await openMarketViaCustomPair(page, tenor);
  await expect(empty).toBeVisible({ timeout: 30_000 });
  await expect(note).toHaveCount(0, { timeout: 30_000 });

  // 2 — the service fails.
  await page.route(signedBook, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, headers: cors, body: '{"error":"down"}' })
      : route.continue(),
  );
  await openMarketViaCustomPair(page, tenor);
  await expect(note).toContainText(/couldn’t load signed offers/i, { timeout: 30_000 });
  await expect(note).toContainText(/only offers posted on the blockchain/i);

  // 3 — the service answers, but a side overflowed its cap.
  await page.unroute(signedBook);
  await page.route(signedBook, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          headers: cors,
          contentType: 'application/json',
          body: JSON.stringify({ chainId: CHAIN_ID, offers: [], truncated: true }),
        })
      : route.continue(),
  );
  await openMarketViaCustomPair(page, tenor);
  await expect(note).toContainText(/more signed offers than we load/i, { timeout: 30_000 });
  await expect(note).toContainText(/best rates are complete/i);
});
