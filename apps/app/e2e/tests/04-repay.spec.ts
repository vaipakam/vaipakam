/** Flow 5.1 — borrower repays in full from the position page; the
 *  loan settles Repaid on-chain. Builds its own loan first (post +
 *  DEEP-LINK accept through the UI — the Offer Book "?offer=<id>"
 *  journey, complementing 03's guided-match path) so the scenario is
 *  self-contained.
 *
 *  Then the LENDER's side of the same repaid loan (2026-10-03 live
 *  review):
 *  - UX3-004 — the loan page states the claim's exact payout above the
 *    claim button, and the Positions row says what is ready to claim;
 *  - UX3-001 — the lender's forced close-out card does not render on a
 *    repaid loan. This half is a BOUNDS GUARD, not the regression test:
 *    on Anvil the page's status sources may resolve in a different order
 *    from the live deploy, so it can pass without the fix. The
 *    mutation-checked proof is `resolveForcedCloseActive` in
 *    `src/data/forcedClose.test.ts`. */
import { test, expect } from '../lib/wallet-fixture';
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('borrower repays a loan in full', async ({ launchWallet }) => {
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet('borrower');
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');

  const { page } = borrower;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const repayBtn = page.getByRole('button', { name: /^repay/i }).first();
  await expect(repayBtn).toBeVisible({ timeout: 30_000 });
  await expect(repayBtn).toBeEnabled({ timeout: 30_000 });
  await repayBtn.click();
  await page.waitForTimeout(1200);
  const confirm = page.getByRole('button', { name: /confirm/i }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByText(/repayment confirmed/i)).toBeVisible({
    timeout: 120_000,
  });

  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { status: number };
  expect(Number(loan.status)).toBe(1); // Repaid

  // ── The lender's view of the repaid loan ─────────────────────────────
  await borrower.ctx.close();
  const lenderAgain = await launchWallet('lender');
  const lp = lenderAgain.page;
  await lp.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  // UX3-004 — an exact amount and symbol, not "Claim my funds" alone.
  const payout = lp.locator('#claim-payout');
  await expect(payout).toBeVisible({ timeout: 60_000 });
  await expect(payout).toHaveText(/You will receive: [\d.,]+ \S+/);
  // UX3-001 — no forced close-out card on a settled loan (bounds guard;
  // see the header). Asserted after the payout line, so the page has had
  // time to resolve the claim reads the card would sit beside.
  await expect(lp.getByText(/if this loan is not repaid/i)).toHaveCount(0);
  await expect(lp.getByText(/still checking whether this loan can be closed out/i)).toHaveCount(0);

  // UX3-004 — the Positions row states what is waiting.
  await lp.goto('/positions', { waitUntil: 'domcontentloaded' });
  await expect(lp.getByText(/ready to claim: [\d.,]+ \S+/i).first()).toBeVisible({
    timeout: 60_000,
  });
});
