/**
 * Every write is sent with the shared gas margin (RB-GAS): the limit on the
 * mined transaction is the estimate plus 30%, never the node's bare
 * estimate. An estimate is the least gas the call needs in the latest
 * block, and the write mines in a later one, so a call whose cost grows
 * with time could run short at a zero-margin limit.
 *
 * The test wallet passes the app's limit through untouched and, when the
 * app sets none, lets the node estimate, as a real wallet does. So a mined
 * limit at least 30% above the gas the transaction used proves the app set
 * it (the estimate is never below the gas used). One token write and one
 * protocol write are checked, on the desktop and the phone project.
 */
import type { Hex } from 'viem';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

type Sc = ReturnType<typeof scenario>;

/** Every transaction `from` sent in the blocks after `start`, with its
 *  limit and the gas it used. */
async function sentSince(sc: Sc, from: Hex, start: bigint): Promise<{ gas: bigint; gasUsed: bigint; ok: boolean }[]> {
  const head = await sc.pub.getBlockNumber();
  const out: { gas: bigint; gasUsed: bigint; ok: boolean }[] = [];
  for (let n = start + 1n; n <= head; n++) {
    const block = await sc.pub.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      if (tx.from.toLowerCase() !== from.toLowerCase()) continue;
      const r = await sc.pub.getTransactionReceipt({ hash: tx.hash });
      out.push({ gas: tx.gas, gasUsed: r.gasUsed, ok: r.status === 'success' });
    }
  }
  return out;
}

function expectMargined(tx: { gas: bigint; gasUsed: bigint; ok: boolean }): void {
  expect(tx.ok).toBe(true);
  // limit >= 1.3 x gas used, in whole numbers.
  expect(tx.gas * 100n >= tx.gasUsed * 130n, `limit ${tx.gas} vs used ${tx.gasUsed}`).toBe(true);
}

test('a token write and a protocol write each mine with the margin over their estimate', async ({ launchWallet }) => {
  const sc = scenario();
  await sc.diamondWrite('lender', 'setVPFIDiscountConsent', [false]);
  const account = accountFor('lender').address as Hex;
  const { page } = await launchWallet('lender');
  await page.goto('/');
  await connectWallet(page);

  // A token write: the faucet's mint.
  const faucet = page.getByRole('region', { name: /Get test assets/ });
  await expect(faucet).toBeVisible({ timeout: 60_000 });
  let start = await sc.pub.getBlockNumber();
  await faucet.locator('[data-asset="liquidToken"]').getByRole('button', { name: 'Get 1000' }).click();
  await faucet.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(faucet.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  const minted = await sentSince(sc, account, start);
  expect(minted).toHaveLength(1);
  expectMargined(minted[0]!);
  await faucet.getByRole('button', { name: 'Close' }).click();

  // A protocol write: turning the fee discount on.
  const section = page.getByRole('region', { name: 'Fee discount' });
  await expect(section).toHaveAttribute('data-consent', 'off', { timeout: 60_000 });
  start = await sc.pub.getBlockNumber();
  await section.getByRole('button', { name: 'Turn on' }).click();
  await section.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(section.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  const consented = await sentSince(sc, account, start);
  expect(consented).toHaveLength(1);
  expectMargined(consented[0]!);
});
