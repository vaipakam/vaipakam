/** #2391 — a refinance request made on another device is found on chain.
 *
 *  Until #2391 the loan page learned of a request only from a marker in
 *  the posting device's localStorage, so a second device saw nothing and
 *  let the borrower take collateral back (or repay part, or close early)
 *  — stranding the request. The discovery rule (the current holder's own
 *  open offers tagged for the loan; an incomplete or failed scan is
 *  unknown) is pinned by `src/data/refinanceDiscovery.test.ts`. What this
 *  drive shows is the surface: a SECOND browser context — a fresh profile
 *  with an empty localStorage, which is what another device is to the app —
 *  names the live request and holds the take-back-collateral card back.
 *
 *  The second context's lack of a marker is ASSERTED, not assumed: if the
 *  fixture ever shared storage between contexts, the spec would pass on
 *  the marker it set out to do without. */
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect } from '../lib/desk';

test('a refinance request posted elsewhere is found and interlocks this page', async ({
  launchWallet,
}) => {
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 880,
    amountWeth: '0.02',
    collateralTliq: '150',
    days: 30,
  });
  const loanId = await acceptOfferDirect('borrower', offerId);

  // Device A posts the request through the real form.
  const a = await launchWallet('borrower', { advanced: true });
  await a.page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const card = a.page.locator('section.card').filter({ hasText: 'Refinance this loan' });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByLabel(/highest yearly rate/i).fill('12');
  await card.getByLabel(/new loan length/i).fill('30');
  const review = card.getByRole('button', { name: /review refinance request/i });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  await card.locator('input[type="checkbox"]').check();
  const confirm = card.getByRole('button', { name: /confirm — post refinance request/i });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  const livePattern = /refinance request #(\d+) is live/i;
  await expect(a.page.getByText(livePattern)).toBeVisible({ timeout: 120_000 });
  const requestId = (await a.page.getByText(livePattern).textContent())!.match(livePattern)![1];

  // Device B: a fresh context with no marker of its own.
  const b = await launchWallet('borrower');
  await b.page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const markers = await b.page.evaluate(() =>
    Object.keys(window.localStorage).filter((k) => k.includes('refinanceOffer')),
  );
  expect(markers, 'device B must start with no refinance marker').toEqual([]);

  // The request is named from chain, and the take-back-collateral card
  // holds back rather than offering a withdrawal that would strand it.
  await expect(
    b.page.getByText(new RegExp(`refinance request #${requestId} is live`, 'i')),
  ).toBeVisible({ timeout: 90_000 });
  await expect(
    b.page.getByText(/a refinance request is open on this loan, and it was made for the collateral as it stands now/i),
  ).toBeVisible({ timeout: 30_000 });
});
