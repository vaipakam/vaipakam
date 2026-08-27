/** Asset picker — faucet test tokens as first-class rows (user
 *  directive 2026-07-06), on the SelectMenu dropdown that replaced
 *  native <select>.
 *
 *  The faucet page mints tLIQ / mUSDC / mWETH / tILQ / tILQ2 so people
 *  can try the flows, but the pickers used to make them paste those
 *  addresses back by hand. On a testnet chain the picker must list
 *  every faucet ERC-20 (badged as a test token), selecting one must
 *  fill the form like a curated pick, and the paste escape hatch must
 *  survive the dropdown swap (specs 02/03/08 exercise it end-to-end;
 *  this one pins the picker surface itself).
 */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';
import { chooseMenuValue } from '../lib/flows';
import { MOCKS } from '../lib/chain';

test('picker lists faucet tokens, selects one, and keeps the paste branch', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/lend', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);

  // Open the lending-asset menu: every faucet ERC-20 must be a row,
  // badged so it can't be mistaken for a real asset.
  await page.locator('#lending-asset').click();
  const listbox = page.locator('[role="listbox"]');
  const faucetAddresses = [
    MOCKS!.liquidToken,
    MOCKS!.liquidToken2,
    MOCKS!.mWeth,
    MOCKS!.illiquidToken,
    MOCKS!.illiquidToken2,
  ] as string[];
  for (const addr of faucetAddresses) {
    await expect(
      listbox.locator(`[data-value="${addr}" i]`),
      `faucet token ${addr} listed`,
    ).toBeVisible({ timeout: 30_000 });
  }
  await expect(
    listbox.getByText('Faucet test token').first(),
  ).toBeVisible();
  // The paste escape hatch is still a row.
  await expect(listbox.locator('[data-value="__custom__"]')).toBeVisible();

  // Selecting a faucet token closes the menu and shows it on the
  // control (symbol resolved live from the fork).
  await listbox.locator(`[data-value="${MOCKS!.liquidToken as string}" i]`).click();
  await expect(page.locator('#lending-asset')).toContainText('tLIQ');
  // The form accepted it: the amount step's CTA is reachable (enabled
  // state needs an amount too, so just assert the control kept focus
  // flow and no paste input appeared).
  await expect(
    page.locator('.field:has(#lending-asset) input[placeholder="0x…"]'),
  ).toHaveCount(0);

  // Paste branch still works after the swap.
  await chooseMenuValue(page, 'lending-asset', '__custom__');
  const pasteInput = page.locator(
    '.field:has(#lending-asset) input[placeholder="0x…"]',
  );
  await expect(pasteInput).toBeVisible();
  await pasteInput.fill(MOCKS!.illiquidToken as string);
  await expect(pasteInput).toHaveValue(MOCKS!.illiquidToken as string);
});
