/** Flow 3.3 — offer cancellation honours the 300 s protocol cooldown,
 *  and time travel (the fork tier's superpower) lets the same test see
 *  both sides of the window in seconds: blocked inside it, clean
 *  cancel after it. */
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer } from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('cancel is blocked inside the cooldown and works after it', async ({
  launchWallet,
}) => {
  const lender = await launchWallet('lender');
  const { page, account } = lender;
  await postLenderOffer(page);

  const offerIdOf = async () => {
    const [ids] = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getUserOffersPaginated',
      args: [account.address, 0n, 100n],
    })) as [readonly bigint[], bigint];
    return ids.reduce((a, b) => (b > a ? b : a));
  };
  const offerId = await offerIdOf();

  // Inside the cooldown the manage surface must refuse with a plain
  // reason (button disabled or a named error) — never a silent no-op.
  await page.goto('/positions', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const cancelBtn = page.getByRole('button', { name: /cancel/i }).first();
  if (await cancelBtn.isVisible().catch(() => false)) {
    if (await cancelBtn.isEnabled()) {
      await cancelBtn.click();
      await page.waitForTimeout(6000);
      const errs = await page
        .locator('.banner-danger:visible, .banner-warn:visible')
        .allTextContents()
        .catch(() => []);
      const body = (await page.textContent('body')) ?? '';
      expect(
        errs.length > 0 || /cooldown|few minutes|shortly after/i.test(body),
      ).toBeTruthy();
    }
  }
  // Offer must still be live on-chain either way.
  const stillLive = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOffer',
    args: [offerId],
  })) as { creator: string };
  expect(/^0x0{40}$/i.test(stillLive.creator)).toBe(false);

  // Past the window: the cancel completes and the offer record clears.
  await increaseTime(301);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const cancel2 = page.getByRole('button', { name: /cancel/i }).first();
  await expect(cancel2).toBeVisible({ timeout: 20_000 });
  await cancel2.click();
  const confirm = page.getByRole('button', { name: /confirm/i }).first();
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await confirm.click();
  }
  await expect
    .poll(
      async () => {
        const o = (await pub.readContract({
          address: DIAMOND,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getOffer',
          args: [offerId],
        })) as { creator: string };
        return /^0x0{40}$/i.test(o.creator);
      },
      { timeout: 90_000 },
    )
    .toBe(true);
});
