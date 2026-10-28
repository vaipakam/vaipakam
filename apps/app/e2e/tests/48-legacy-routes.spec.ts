/** #2076 — every path the retired app served lands somewhere that does what
 *  the bookmark was for.
 *
 *  The mappings are unit-tested in `src/lib/legacyRoutes.test.ts`; this
 *  drives them through the real router, because the failures that matter
 *  live between the mapping and the page: a redirect that never runs (held
 *  by the Terms gate, shadowed by another route), a card anchor nothing
 *  scrolls to, or a Basic-mode page that hides the card a bookmark named.
 *
 *  Asserted contract:
 *  1. `/offers/:id` opens the flow that takes that offer, with its chain.
 *  2. `/loans/:id/early-withdrawal` and `/loans/:id/preclose` land on the
 *     position, at the lender's and the borrower's exit chooser, scrolled
 *     into view. `/loans/:id/refinance` lands on the borrower's chooser
 *     too, in BASIC mode, where the refinance form itself is not shown:
 *     the chooser names refinance and offers the switch to Advanced.
 *  3. `/allowances` reaches the approvals card in BASIC mode, where that
 *     card is otherwise not shown.
 *  4. `/create-offer` goes to the form its side names.
 *  5. `/auto-lend` says the feature is not here, rather than not-found.
 *  6. An offer id the chain does not have says so, naming the network.
 */
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect } from '../lib/desk';
import { CHAIN_ID } from '../lib/chain';
import { copySource as copy } from '../../src/content/copy';

test('retired app links land on the page that does what they were for', async ({ launchWallet }) => {
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 900,
    amountWeth: '0.01',
    collateralTliq: '150',
    days: 30,
  });

  // 1 — the old offer detail page opens the borrow flow on that offer.
  const borrower = await launchWallet('borrower');
  let page = borrower.page;
  await page.goto(`/offers/${offerId}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/borrow\\?offer=${offerId}&chain=${CHAIN_ID}$`), {
    timeout: 30_000,
  });

  const loanId = await acceptOfferDirect('borrower', offerId);

  // 2 — the borrower's old preclose page lands on their exit chooser.
  await page.goto(`/loans/${loanId}/preclose`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/positions/${loanId}#early-repay-options$`));
  await expect(page.locator('#early-repay-options')).toBeInViewport({ timeout: 60_000 });

  // 2, refinance — lands on the same chooser in Basic mode, which names
  // refinance and offers the mode switch (the refinance form is not shown).
  await page.goto(`/loans/${loanId}/refinance`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/positions/${loanId}#early-repay-options$`));
  const chooser = page.locator('#early-repay-options');
  await expect(chooser).toBeInViewport({ timeout: 60_000 });
  await expect(chooser.getByText(copy.earlyRepay.options.refinance, { exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: copy.earlyRepay.switchToAdvanced })).toBeVisible();
  await expect(page.locator('#refinance-card')).toHaveCount(0);

  // 3 — the old allowances page reaches the approvals card in Basic mode.
  await page.goto('/allowances', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/settings#approvals$/);
  await expect(page.getByRole('heading', { name: copy.approvals.title })).toBeVisible();

  // 4 — the old create page goes to the form its side names.
  await page.goto('/create-offer?side=borrower', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/borrow$/);

  // 5 — the retired auto-lend page explains itself.
  await page.goto('/auto-lend', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: copy.legacyRoutes.autoLendTitle })).toBeVisible();

  // 6 — an offer the chain does not have is named as not found HERE.
  await page.goto('/offers/987654321', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Offer #987654321 wasn’t found on / })).toBeVisible({
    timeout: 30_000,
  });

  // 2, lender side — the old early-withdrawal page lands on the chooser.
  const lender = await launchWallet('lender');
  page = lender.page;
  await page.goto(`/loans/${loanId}/early-withdrawal`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(`/positions/${loanId}#lender-exit-options$`));
  await expect(page.locator('#lender-exit-options')).toBeInViewport({ timeout: 60_000 });
});
