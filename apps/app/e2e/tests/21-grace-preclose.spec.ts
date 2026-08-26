/** #1235/#1236 — grace-window parity. Contract #1189 made
 *  precloseDirect (and refinance acceptance) valid THROUGH the grace
 *  window, charging the repay-parity late fee there. This spec builds
 *  a loan, warps chain time just past maturity (inside grace — every
 *  bucket is ≥ 1 hour), and asserts the borrower can still reach BOTH
 *  surfaces: the close-early card renders with the in-grace late-fee
 *  note and settles the loan, and the refinance form is still offered
 *  (not hidden at the old pre-#1235 maturity gate). */
import { test, expect } from '../lib/wallet-fixture';
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('borrower can close early inside the grace window (late fee disclosed)', async ({
  launchWallet,
}) => {
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet('borrower');
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');
  await borrower.ctx.close();

  // Warp to 10 minutes past maturity — inside every grace bucket
  // (the smallest, sub-7-day loans, is 1 hour).
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { startTime: bigint; durationDays: bigint };
  const endTime = loan.startTime + loan.durationDays * 86_400n;
  const now = (await pub.getBlock()).timestamp;
  await increaseTime(Number(endTime - now) + 600);

  // The strategy cards are advanced-mode surfaces.
  const adv = await launchWallet('borrower', { advanced: true });
  const { page } = adv;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });

  // Close-early card still renders in grace, with the late-fee note.
  const precloseCard = page
    .locator('section.card')
    .filter({ hasText: 'Close this loan early' });
  await expect(precloseCard).toBeVisible({ timeout: 30_000 });
  await expect(
    precloseCard.getByText(/past its due date/i),
  ).toBeVisible({ timeout: 30_000 });

  // Refinance form is still offered in grace too (#1236) — with its
  // own past-due banner.
  const refinanceCard = page
    .locator('section.card')
    .filter({ hasText: 'Refinance this loan' });
  await expect(refinanceCard).toBeVisible({ timeout: 30_000 });
  await expect(
    refinanceCard.getByText(/past its due date/i),
  ).toBeVisible({ timeout: 30_000 });

  // Drive the in-grace close to settlement.
  await precloseCard.getByRole('button', { name: /close early/i }).click();
  const confirm = precloseCard.getByRole('button', {
    name: /pay and close now/i,
  });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(page.getByText(/loan closed early/i)).toBeVisible({
    timeout: 120_000,
  });

  const settled = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { status: number };
  expect(Number(settled.status)).toBe(1); // Repaid
});
