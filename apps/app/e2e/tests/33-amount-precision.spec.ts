/** #2390 — a typed amount finer than its token can carry is refused and
 *  named, never rounded into a different figure.
 *
 *  The parse rule itself is pinned by `src/lib/parseExactUnits.test.ts`,
 *  the offer schema's use of it by `src/lib/offerSchemaPrecision.test.ts`,
 *  and the ban on viem's rounding `parseUnits` by
 *  `src/lib/exactAmountGuard.test.ts`. What those cannot show is the
 *  SURFACE: that the shared hint appears under a real money input once the
 *  token's decimals have loaded from chain, and that the step cannot be
 *  continued while it shows. The guided borrow form is the drive — its
 *  amount field is the first money input a new user meets.
 *
 *  The verdict is a PAIR on each side: with 19 decimals of WETH (which has
 *  18) the hint is visible AND "See matching offers" is disabled; with the
 *  amount fixed the hint is gone AND the button enables. A hint with an
 *  enabled button, or a disabled button with no reason, would each fail. */
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { pickCuratedAsset } from '../lib/flows';
import { WETH } from '../lib/chain';

test('a too-precise amount is named and blocks the step until fixed', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('borrower');
  await page.goto('/borrow', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await pickCuratedAsset(page, 'lending-asset', WETH);

  const amount = page.locator('#amount');
  const see = page.getByRole('button', { name: /see matching offers/i });
  const hint = page.getByTestId('amount-too-precise');

  await amount.fill('1.0000000000000000001');
  await expect(hint).toBeVisible({ timeout: 30_000 });
  await expect(hint).toContainText('18');
  await expect(see).toBeDisabled();

  await amount.fill('1.5');
  await expect(hint).toHaveCount(0);
  await expect(see).toBeEnabled({ timeout: 30_000 });
});
