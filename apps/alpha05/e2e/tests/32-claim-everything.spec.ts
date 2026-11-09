/**
 * Claim everything (matrix LN-51; RB-CLAIM), against loans opened and repaid
 * through the protocol's public entry points on the fixture chain. Claims
 * lists every payout the wallet can collect now, each with a switch to
 * include it or leave it out; the reader leaves one out, and one
 * transaction collects the rest: the review names exactly the payouts it
 * sends, the finish card reports each from the transaction's own logs, and
 * what was left out stays listed for the next batch. While the protocol is
 * paused, the batch is not offered and the pause is named. Runs on the
 * desktop and the phone project; the chain is reverted after each test.
 */
import { erc20Abi } from 'viem';
import { openLoan, repayInFull, WETH } from '@vaipakam/anvil-harness/lending';
import type { Locator, Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Claimable = readonly [Hex, bigint, boolean, number, bigint, bigint, bigint, boolean];

// See 26-loan-claims: a revert leaves the head at the snapshot's timestamp,
// so a block is mined at once.
let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Pick exactly the legs in `keep`, leaving every other leg listed out. */
async function pickOnly(section: Locator, keep: readonly string[]): Promise<void> {
  const legs = section.locator('[data-claim-leg]');
  for (let n = 0; n < (await legs.count()); n++) {
    const key = (await legs.nth(n).getAttribute('data-claim-leg'))!;
    const box = legs.nth(n).getByRole('checkbox');
    if (keep.includes(key)) await box.check();
    else await box.uncheck();
  }
}

test('Claim everything collects the payouts picked in one transaction and leaves the rest listed', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const a = (await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 })).loanId;
  const b = (await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.04', collateralTliq: '1500', rateBps: 500, days: 30 })).loanId;
  await repayInFull(sc, 'borrower', a);
  await repayInFull(sc, 'borrower', b);
  const lenderAddr = sc.address('lender');
  const [, owedA] = await sc.read<Claimable>('getClaimable', [a, true]);
  const [, owedB] = await sc.read<Claimable>('getClaimable', [b, true]);
  // A loan claim credits the lender's own vault: what it may withdraw now.
  const balance = () => sc.read<bigint>('withdrawableNow', [lenderAddr, 0, WETH, 0n]);
  const wallet = () => sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lenderAddr] });

  const { page, flags } = await launchWallet('lender');
  await page.goto('/claims');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Claim everything' });
  const legA = section.locator(`[data-claim-leg="loan:lender:${a}"]`);
  const legB = section.locator(`[data-claim-leg="loan:lender:${b}"]`);
  await expect(legA).toContainText(`Loan #${a}, lender payout`, { timeout: 60_000 });
  await expect(legB).toContainText(`Loan #${b}, lender payout`);
  // Both are on by default.
  await expect(legA.getByRole('checkbox')).toBeChecked();
  await expect(legB.getByRole('checkbox')).toBeChecked();
  await fitsWidth(page);

  // Loan B is left out; the batch collects loan A alone.
  await pickOnly(section, [`loan:lender:${a}`]);
  await expect(section.getByTestId('claim-all-review')).toHaveText('Review and collect 1 payout');
  await section.getByTestId('claim-all-review').click();
  const flow = section.getByTestId('claim-all-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Collect 1 payout in one transaction', { timeout: 60_000 });
  await expect(receipt).toContainText(`Loan #${a}, lender payout`);
  await expect(receipt).not.toContainText(`Loan #${b}`);
  await expect(receipt).toContainText('Each payout runs on its own inside this one transaction');
  await expect(receipt).toContainText('Your vault, as your own funds, free to withdraw');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  const before = await balance();
  const walletBefore = await wallet();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(`Loan #${a}, lender payout: collected`);
  await expect(finish).toContainText(/credited to your vault, free to withdraw/);
  await expect(finish.getByRole('link', { name: 'Withdraw from your vault' })).toHaveAttribute('href', '/vault');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await balance()).toBe(before + owedA);
  expect(await wallet()).toBe(walletBefore);
  expect((await sc.read<Claimable>('getClaimable', [a, true]))[2]).toBe(true);
  expect((await sc.read<Claimable>('getClaimable', [b, true]))[2]).toBe(false);

  // Closed, the list no longer has loan A; loan B waits, still left out.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(legA).toHaveCount(0, { timeout: 60_000 });
  await expect(legB.getByRole('checkbox')).not.toBeChecked();

  // The next batch collects it.
  await pickOnly(section, [`loan:lender:${b}`]);
  await section.getByTestId('claim-all-review').click();
  await expect(receipt).toContainText(`Loan #${b}, lender payout`, { timeout: 60_000 });
  const mid = await balance();
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(await balance()).toBe(mid + owedB);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(legB).toHaveCount(0, { timeout: 60_000 });
});

test('while the protocol is paused, Claim everything names the pause and offers no batch', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  await sc.diamondWrite('admin', 'pause');

  const { page } = await launchWallet('lender');
  await page.goto('/claims');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Claim everything' });
  await expect(section.locator(`[data-claim-leg="loan:lender:${loanId}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(section.getByTestId('claim-all-stop')).toHaveAttribute('data-code', 'EnforcedPause');
  await expect(section.getByTestId('claim-all-stop')).toContainText('a pause stops every claim and withdrawal');
  await expect(section.getByTestId('claim-all-review')).toHaveCount(0);
  await fitsWidth(page);
});
