/**
 * Loan payouts (matrix LN-48, LN-49, LN-50; RB-CLAIM), against loans opened
 * and repaid through the protocol's public entry points on the fixture chain.
 * Once a loan ends, the holder of each position collects that side's payout,
 * from the loan's page or from Claims, through one flow: the review names
 * every payout, where it goes and what collecting closes, with one wallet
 * prompt; the finish card reports what the transaction's own logs show was
 * paid, and that the loan is settled once both sides have collected. A
 * running loan offers no payout. Runs on the desktop and the phone project;
 * each run opens its own loans, and the chain is reverted after each test,
 * so what a claim pays a wallet never reaches a later spec.
 */
import { erc20Abi } from 'viem';
import { openLoan, repayInFull, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Claimable = readonly [Hex, bigint, boolean, number, bigint, bigint, bigint, boolean];

// The chain as each test found it: later specs (the phone project's
// included) count on the lender holding no WETH and the borrower none of the
// collateral token beyond what they hold now. A revert leaves the head at the
// snapshot's timestamp while the next block mines at the wall clock, so a
// block is mined at once: a later repay estimated in the stale head would
// mine short of gas, since interest accrues per second.
let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

/** Move within the app without reloading it, as a link would. */
async function softNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('each side collects its payout of a repaid loan: the lender from the loan page, the borrower from Claims, and the loan settles', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  const lenderAddr = sc.address('lender');
  const borrowerAddr = sc.address('borrower');
  const { collateralAsset } = await sc.read<{ collateralAsset: Hex }>('getLoanDetails', [loanId]);
  const [, owedLender] = await sc.read<Claimable>('getClaimable', [loanId, true]);
  expect(owedLender).toBeGreaterThan(0n);

  // The lender, on the loan's page.
  {
    const { page, flags, ctx } = await launchWallet('lender');
    const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lenderAddr] });
    const freeBefore = await sc.read<bigint>('withdrawableNow', [lenderAddr, 0, WETH, 0n]);
    await page.goto(`/positions/${loanId}`);
    await connectWallet(page);
    const section = page.getByRole('region', { name: 'Your payout' });
    await section.getByTestId('loan-claim-open-lender').click({ timeout: 60_000 });
    // The borrower's side belongs to another wallet: not offered here.
    await expect(section.getByTestId('loan-claim-open-borrower')).toHaveCount(0);

    const flow = page.getByTestId('loan-claim-panel-lender');
    const receipt = flow.locator('.receipt');
    await expect(receipt).toContainText(`Collect the lender payout of loan #${loanId}`, { timeout: 60_000 });
    await expect(receipt).toContainText('Your payout');
    // Principal and interest, less the treasury's cut of the interest.
    await expect(receipt).toContainText(/0\.05\d* WETH/);
    await expect(receipt).toContainText('Your vault, as your own funds, free to withdraw');
    await expect(receipt).toContainText('Withdraw it to your wallet from your vault page whenever you choose.');
    await expect(receipt).toContainText('Collecting closes your side of the loan: the protocol burns your position token.');
    await expect(receipt).toContainText('If the protocol pauses before this confirms, it is refused and nothing moves.');
    await expect(receipt).toContainText('Wallet prompts: 1');
    await fitsWidth(page);

    const sent = flags.sentTransactions;
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    await expect(finish).toContainText(`Payout collected from loan #${loanId}`);
    await expect(finish).toContainText(/credited to your vault, free to withdraw/);
    await expect(finish).not.toContainText('Both sides have collected');
    await expect(finish.getByRole('link', { name: 'Withdraw from your vault' })).toHaveAttribute('href', '/vault');
    expect(flags.sentTransactions).toBe(sent + 1);
    // The chain agrees: the payout is the lender's own in its vault, free to
    // withdraw, and nothing reached the wallet.
    expect((await sc.read<bigint>('withdrawableNow', [lenderAddr, 0, WETH, 0n])) - freeBefore).toBe(owedLender);
    expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lenderAddr] })).toBe(before);

    // Closing the card leaves nothing to collect for this wallet: its
    // position token is burnt.
    await finish.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('region', { name: 'Your payout' })).toHaveCount(0, { timeout: 60_000 });
    await ctx.close();
  }

  // The borrower, from Claims.
  {
    const { page, flags } = await launchWallet('borrower');
    const freeBefore = await sc.read<bigint>('withdrawableNow', [borrowerAddr, 0, collateralAsset, 0n]);
    await page.goto('/claims');
    await connectWallet(page);
    // Every kind of payout Claims lists is on the page: nothing points elsewhere.
    await expect(page.getByTestId('claims-not-yet')).toHaveCount(0);
    const card = page.locator(`[data-claim="borrower:${loanId}"]`);
    await expect(card).toContainText('Collateral back to you', { timeout: 60_000 });
    await expect(card).toContainText('1,500 tLIQ');
    await fitsWidth(page);
    await card.getByTestId(`claims-open-borrower-${loanId}`).click();

    const flow = card.getByTestId('loan-claim-panel-borrower');
    const receipt = flow.locator('.receipt');
    await expect(receipt).toContainText(`Collect the borrower payout of loan #${loanId}`, { timeout: 60_000 });
    await expect(receipt).toContainText('Collateral back to you');
    await expect(receipt).toContainText('1,500 tLIQ');
    await expect(receipt).toContainText('Wallet prompts: 1');
    await fitsWidth(page);

    const sent = flags.sentTransactions;
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    await expect(finish).toContainText(`Payout collected from loan #${loanId}`);
    await expect(finish).toContainText('1,500 tLIQ credited to your vault, free to withdraw');
    await expect(finish).toContainText('Both sides have collected: the loan is settled');
    expect(flags.sentTransactions).toBe(sent + 1);

    // The chain agrees: settled, and the collateral is the borrower's own in
    // its vault again, free to withdraw.
    const after = await sc.read<{ status: number }>('getLoanDetails', [loanId]);
    expect(Number(after.status)).toBe(3);
    expect((await sc.read<bigint>('withdrawableNow', [borrowerAddr, 0, collateralAsset, 0n])) - freeBefore).toBe(1500n * 10n ** 18n);

    // Leaving for Home and coming back within the app keeps the finish card,
    // though the burnt position no longer lists the payout.
    await softNavigate(page, '/');
    await expect(page.locator(`[data-claim="borrower:${loanId}"]`)).toHaveCount(0);
    await softNavigate(page, '/claims');
    const kept = page.locator(`[data-claim="borrower:${loanId}"] [data-phase="measured"]`);
    await expect(kept).toContainText('Both sides have collected: the loan is settled', { timeout: 60_000 });
    await kept.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator(`[data-claim="borrower:${loanId}"]`)).toHaveCount(0, { timeout: 60_000 });
  }
});

test('a running loan offers no payout, on its page or on Claims', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });

  const { page } = await launchWallet('lender');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await expect(page.getByTestId('position-status')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Actions' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Your payout' })).toHaveCount(0);

  await page.goto('/claims');
  await expect(page.getByRole('heading', { level: 2, name: 'Loan payouts' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('claims-loan-rows').or(page.getByTestId('claims-empty'))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-claim="lender:${loanId}"]`)).toHaveCount(0);
  await fitsWidth(page);
});
