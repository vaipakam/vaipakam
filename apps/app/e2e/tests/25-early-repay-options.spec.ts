/** Early-repayment options surface (FunctionalSpecs §8) — the
 *  borrower chooser card names every way out of an active loan in
 *  BOTH modes, and the two previously-unexposed preclose paths work
 *  end-to-end:
 *   - Option 2 (obligation handover): a matching standing borrow
 *     request is listed with the borrower's cost, and confirming it
 *     rewrites the loan to the new borrower atomically.
 *   - Option 3 (offset): posting the linked lender offer locks the
 *     borrower position (PrecloseOffset), the pending card takes over
 *     the page's story, and cancel (after the protocol cooldown)
 *     releases the lock.
 */
import { formatEther } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { seedDeskOffer } from '../lib/desk';
import { accountFor } from '../lib/wallets';
import { increaseTime } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

async function loanDetails(loanId: bigint): Promise<{
  borrower: `0x${string}`;
  borrowerTokenId: bigint;
  principal: bigint;
  status: number;
}> {
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as {
    borrower: `0x${string}`;
    borrowerTokenId: bigint;
    principal: bigint;
    status: number | bigint;
  };
  return { ...loan, status: Number(loan.status) };
}

async function positionLockOf(tokenId: bigint): Promise<number> {
  return Number(
    await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'positionLock',
      args: [tokenId],
    }),
  );
}

test('chooser surfaces every path; obligation handover completes (Option 2)', async ({
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

  // A replacement borrower's standing borrow request matching the
  // loan exactly: same assets, the loan's outstanding principal,
  // ≥ collateral, and a term that ends before the loan's due date.
  const loan = await loanDetails(loanId);
  const seededOfferId = await seedDeskOffer({
    role: 'newBorrower',
    side: 'borrow',
    rateBps: 900,
    amountWeth: formatEther(loan.principal),
    collateralTliq: '150',
    days: 1,
  });

  // BASIC mode: the chooser names the paths and offers the explicit
  // switch — the discoverability half of this feature.
  const basic = await launchWallet('borrower');
  const { page } = basic;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const chooser = page
    .locator('section.card')
    .filter({ hasText: 'Ways to repay or exit early' });
  await expect(chooser).toBeVisible({ timeout: 30_000 });
  await expect(
    chooser.getByText(/hand the loan to another borrower/i),
  ).toBeVisible();
  await expect(
    chooser.getByText(/exit by becoming a lender/i),
  ).toBeVisible();
  await chooser
    .getByRole('button', { name: /show these tools/i })
    .click();

  // Advanced tools reveal in place; the transfer card lists the
  // seeded request with the borrower's cost quote.
  const transferCard = page
    .locator('section.card')
    .filter({ hasText: 'Hand this loan to another borrower' });
  await expect(transferCard).toBeVisible({ timeout: 60_000 });
  // Pinned to the SEEDED request — the fork inherits Base Sepolia's
  // whole open book, so "first row" could be an inherited stranger.
  const candidate = transferCard
    .locator('.item-row')
    .filter({ hasText: `Request #${seededOfferId} —` })
    .first();
  await expect(candidate).toBeVisible({ timeout: 60_000 });
  await expect(
    candidate.getByText(/your cost today/i),
  ).toBeVisible();
  await candidate.getByRole('button', { name: /^choose$/i }).click();
  const confirm = transferCard.getByRole('button', {
    name: /confirm — hand over loan/i,
  });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(page.getByText(/loan handed over/i)).toBeVisible({
    timeout: 120_000,
  });
  await basic.ctx.close();

  // The loan continues under the replacement borrower.
  const after = await loanDetails(loanId);
  expect(after.status).toBe(0); // still Active
  expect(after.borrower.toLowerCase()).toBe(
    accountFor('newBorrower').address.toLowerCase(),
  );
});

test('offset posts, locks the position, and cancel releases it (Option 3)', async ({
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
  const loan = await loanDetails(loanId);

  const adv = await launchWallet('borrower', { advanced: true });
  const { page } = adv;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });

  // "(offset)" disambiguates from the chooser card's identically-named
  // option row (both are section.card containing the phrase).
  const offsetCard = page
    .locator('section.card')
    .filter({ hasText: 'Exit by becoming a lender (offset)' });
  await expect(offsetCard).toBeVisible({ timeout: 60_000 });
  // The MUST-SURFACE transfer-lock disclosure renders before review.
  await expect(offsetCard.getByText(/transfer-locked/i)).toBeVisible();
  const review = offsetCard.getByRole('button', {
    name: /review offset offer/i,
  });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  const consent = offsetCard.locator('input[type="checkbox"]');
  await consent.check();
  const confirm = offsetCard.getByRole('button', {
    name: /confirm — fund and post offer/i,
  });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();

  // The pending card takes over and the chain confirms the lock.
  await expect(
    page.getByText(/offset in progress/i).first(),
  ).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(() => positionLockOf(loan.borrowerTokenId), { timeout: 30_000 })
    .toBe(1); // LibERC721.LockReason.PrecloseOffset

  // Past the protocol-wide cancel cooldown (300 s), cancel unwinds:
  // lock released, escrow back to the vault.
  await increaseTime(360);
  const cancel = page.getByRole('button', { name: /cancel offset offer/i });
  await expect(cancel).toBeEnabled({ timeout: 90_000 });
  await cancel.click();
  await expect(page.getByText(/offset offer cancelled/i)).toBeVisible({
    timeout: 120_000,
  });
  await expect
    .poll(() => positionLockOf(loan.borrowerTokenId), { timeout: 30_000 })
    .toBe(0);
  await adv.ctx.close();
});
