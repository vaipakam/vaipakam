/** Flow 3.3 — offer cancellation honours the 300 s protocol cooldown,
 *  and time travel (the fork tier's superpower) lets the same test see
 *  both sides of the window in seconds: refused with a named reason
 *  inside it, clean cancel after it. */
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer, newestOfferIdFor } from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('cancel is blocked inside the cooldown and works after it', async ({
  launchWallet,
}) => {
  const lender = await launchWallet('lender');
  const { page, account } = lender;
  await postLenderOffer(page);
  const offerId = await newestOfferIdFor(account.address);

  // Roles are reused across scenarios (and retries), so /positions can
  // hold several open offers — every action below scopes to THIS run's
  // row via its "Offer #<id> ·" sub-line (run 3 hit exactly that: a
  // bare .first() cancel targeted an earlier scenario's row whose
  // cooldown had already lapsed).
  const row = () =>
    page
      .locator('.row-list > div')
      .filter({ has: page.getByText(`Offer #${offerId} ·`) })
      .first();

  const offerCreatorZeroed = async () => {
    const o = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getOffer',
      args: [offerId],
    })) as { creator: string };
    return /^0x0{40}$/i.test(o.creator);
  };

  await page.goto('/positions', { waitUntil: 'domcontentloaded' });
  const cancelBtn = row().getByRole('button', { name: /cancel offer/i });
  await expect(cancelBtn).toBeVisible({ timeout: 30_000 });
  await cancelBtn.click();
  // The row button only opens the six-row receipt — the tx fires on
  // the Confirm button inside it.
  const confirm1 = row().getByRole('button', { name: /confirm.*cancel/i });
  await expect(confirm1).toBeVisible({ timeout: 10_000 });
  await confirm1.click();
  // Inside the window the attempt must fail with the NAMED cooldown
  // reason (decodeContractError's CancelCooldownActive copy), rendered
  // inline in the row — never a silent no-op or an opaque failure.
  await expect(row().getByText(/cooldown/i)).toBeVisible({ timeout: 30_000 });

  // The offer must still be live on-chain after the refused attempt.
  expect(await offerCreatorZeroed()).toBe(false);

  // Past the window: the cancel completes and the offer record clears.
  await increaseTime(301);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const cancelBtn2 = row().getByRole('button', { name: /cancel offer/i });
  await expect(cancelBtn2).toBeVisible({ timeout: 30_000 });
  await cancelBtn2.click();
  const confirm2 = row().getByRole('button', { name: /confirm.*cancel/i });
  await expect(confirm2).toBeVisible({ timeout: 10_000 });
  await confirm2.click();
  await expect.poll(offerCreatorZeroed, { timeout: 90_000 }).toBe(true);
});
