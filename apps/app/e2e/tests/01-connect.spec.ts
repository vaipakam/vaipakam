/** Flow 1.1 — connect wallet; the shell recognises the account and
 *  the Basic jobs grid is the first thing a visitor can act on. */
import { test, expect, connectWallet } from '../lib/wallet-fixture';

test('connects the injected wallet and shows the jobs grid', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('lender');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/what would you like to do\?/i)).toBeVisible();
  await connectWallet(page);
  // The address chip renders a shortened form of the connected account.
  const prefix = account.address.slice(0, 6);
  await expect(page.getByText(new RegExp(prefix, 'i')).first()).toBeVisible({
    timeout: 15_000,
  });
});
