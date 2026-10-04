/** #2386 — the Rate Desk says what it is missing from the gasless signed
 *  book instead of rendering a chain-only market as if complete. One note
 *  sits above every view (header, offers list, chart), since each shows
 *  rates drawn from the merged book.
 *
 *  The classifier is pinned by `src/data/signedDepth.test.ts`. What it
 *  cannot show is the surface: that the note reaches the page for each
 *  state the offer-book service can actually produce, and that an empty
 *  on-chain book stops calling the market empty while signed offers are
 *  unknown. The stub
 *  serves `/signed-offers` normally, so this drives three states on one
 *  market by intercepting only that route's GET:
 *
 *   1. untouched — the stub answers, nothing is missing, NO note;
 *   2. 503       — the "couldn’t load signed offers" note, and the empty
 *                  state names only on-chain offers;
 *   3. a body flagged `truncated` — the "not every signed offer may be
 *      loaded" note, which claims no level complete, the best included.
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
  await expect(page.getByText(/signed offers aren’t included right now/i)).toBeVisible();
  await expect(empty).toHaveCount(0);

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
  await expect(note).toContainText(/not every signed offer may be loaded/i, { timeout: 30_000 });
  await expect(note).toContainText(/even at the best rate/i);
});
