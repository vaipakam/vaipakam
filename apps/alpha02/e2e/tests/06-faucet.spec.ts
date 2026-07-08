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

/** #1103 — the second-liquid slot is the one that gets RELABELLED
 *  (tLQ2 → mUSDC), so its row/button is the one that could advertise the
 *  wrong ticker during a redeploy-transition window. Its label must reflect
 *  the token's LIVE on-chain symbol(), not a hard-coded "mUSDC".
 *
 *  SMOKE-level: on the fork the slot's symbol IS "mUSDC", so this proves the
 *  read is wired + the label carries the chain value but can't by itself
 *  distinguish dynamic from a hard-coded "mUSDC" (Codex #1109 P3). Forcing a
 *  non-mUSDC / errored symbol needs symbol-read mocking that JSON-RPC batching
 *  (wagmi `http({ batch: true })`) makes impractical against the fork, and
 *  alpha02 has no component-test harness to mock `useReadContract` — tracked
 *  as a follow-up. The generic-fallback path (unresolved → "test stablecoin")
 *  is code-reviewed. */
test('the second-liquid faucet row labels its Mint button with the token live on-chain symbol', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('newBorrower');
  await page.goto('/faucet', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.waitForTimeout(2000);

  const symbol = (await pub.readContract({
    address: MOCKS!.liquidToken2 as `0x${string}`,
    abi: [
      {
        name: 'symbol',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'string' }],
      },
    ] as const,
    functionName: 'symbol',
  })) as string;
  expect(symbol.length).toBeGreaterThan(0);

  // "Mint 10,000 <live-symbol>" — the button text carries the chain-read
  // ticker (proves the read is wired; a hard-coded label that diverged from
  // on-chain would fail here).
  await expect(
    page.getByRole('button', { name: new RegExp(`mint[\\d,\\s]*${symbol}`, 'i') }),
  ).toBeVisible({ timeout: 20_000 });
});
