/** The lender exit chooser and the instant-sale tool read ONE candidate list (#1849).
 *
 *  A lender can sell a position straight into a standing lending offer.
 *  In Advanced the page derives the compatible offers once and hands the
 *  same list to the "sell now" row of the exit chooser and to the sale
 *  tool below it, so the two cannot disagree: with an empty market the
 *  row says so and offers no jump, and once a compatible offer appears
 *  both surfaces show it. Basic mode keeps the row neutral and runs no
 *  active-offers walk at all.
 *
 *  The loan uses an unusual principal so no offer left by an earlier spec
 *  can match it: the empty market is this spec's own, not an assumption.
 *  Both offers it creates are gone when it ends: the loan's offer is
 *  consumed whole at accept, and the buy offer is cancelled by
 *  `withDeskOffer` however the body ends.
 */
import { test, expect } from '../lib/wallet-fixture';
import { acceptOfferDirect, seedDeskOffer, withDeskOffer } from '../lib/desk';

/** Nothing else on the e2e chain lends exactly this much. */
const PRINCIPAL_WETH = '0.00449';
const COLLATERAL_TLIQ = '100';
const DAYS = 30;
const RATE_BPS = 500;

test('chooser and sale tool agree on the instant-sale candidates', async ({
  launchWallet,
}) => {
  const lenderOfferId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: RATE_BPS,
    amountWeth: PRINCIPAL_WETH,
    // Single-value, so the accept consumes the offer whole.
    minAmountWeth: PRINCIPAL_WETH,
    collateralTliq: COLLATERAL_TLIQ,
    days: DAYS,
  });
  const loanId = await acceptOfferDirect('borrower', lenderOfferId);

  // Basic: the row stays available ('unknown') and no walk runs. Counted
  // from the first request the page makes, so a walk at any point fails.
  const basic = await launchWallet('lender');
  const walks: string[] = [];
  basic.page.on('request', (r) => {
    if (r.url().includes('/offers/active')) walks.push(r.url());
  });
  await basic.page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const basicCard = basic.page.locator(
    '[data-testid="lender-exit-card"][data-chooser-ready="ready"]',
  );
  await expect(basicCard).toBeVisible({ timeout: 60_000 });
  await expect(
    basicCard.getByText(/no lending offer on the book matches this position/i),
  ).toHaveCount(0);
  expect(walks, 'Basic mode must not walk the active offers').toEqual([]);
  await basic.ctx.close();

  // Advanced, empty market: the row and the tool both say "none".
  const lender = await launchWallet('lender', { advanced: true });
  const { page } = lender;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const card = page.locator(
    '[data-testid="lender-exit-card"][data-chooser-ready="ready"]',
  );
  const sellNowRow = card
    .locator('.item-row')
    .filter({ hasText: /sell your position now/i });
  const tool = page.locator('#early-exit-card');
  await expect(tool.getByText(/no matching lending offers right now/i)).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    sellNowRow.getByText(/no lending offer on the book matches this position/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(sellNowRow.getByRole('button', { name: /go to this option/i })).toHaveCount(0);

  // A compatible buy offer from another lender: both surfaces see it.
  await withDeskOffer(
    {
      role: 'newLender',
      side: 'lend',
      rateBps: RATE_BPS,
      amountWeth: PRINCIPAL_WETH,
      minAmountWeth: PRINCIPAL_WETH,
      collateralTliq: COLLATERAL_TLIQ,
      days: DAYS,
    },
    async (buyOfferId) => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(tool.getByText(`Offer #${buyOfferId} ·`)).toBeVisible({
        timeout: 60_000,
      });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(
        sellNowRow.getByText(/no lending offer on the book matches this position/i),
      ).toHaveCount(0);
      await expect(
        sellNowRow.getByRole('button', { name: /go to this option/i }),
      ).toBeVisible();
    },
  );
  await lender.ctx.close();
});
