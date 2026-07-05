/** Flow 5.1 — borrower repays in full from the position page; the
 *  loan settles Repaid on-chain. Builds its own loan first (post +
 *  accept through the UI) so the scenario is self-contained. */
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
});
