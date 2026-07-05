/** Flows 2.1/2.4 — the faucet page renders on a testnet with mocks
 *  deployed, a mint lands on-chain, and the success banner offers the
 *  wallet watchAsset affordance. */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';
import { pub, MOCKS, ERC20_MIN_ABI } from '../lib/chain';

test('faucet mints a liquid token and offers Add-to-MetaMask', async ({
  launchWallet,
}) => {
  const { page, account } = await launchWallet('newBorrower');
  await page.goto('/faucet', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.waitForTimeout(2000);

  const before = (await pub.readContract({
    address: MOCKS!.liquidToken as `0x${string}`,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;

  const mint = page.getByRole('button', { name: /mint/i }).first();
  await expect(mint).toBeVisible({ timeout: 20_000 });
  await mint.click();

  await expect(page.getByText(/metamask/i)).toBeVisible({ timeout: 90_000 });

  const after = (await pub.readContract({
    address: MOCKS!.liquidToken as `0x${string}`,
    abi: ERC20_MIN_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
  expect(after).toBeGreaterThan(before);
});
