/**
 * The summary over a wallet's live loans on Positions (#3320; rulebook
 * RB-POSITIONS-SUMMARY), against loans opened through the protocol's public
 * entry points on the fixture chain. Each test opens its own loans; the
 * fixture reverts the chain after every test, so the counts are exact.
 *
 * The stage of each loan is read against the device clock, so once the chain
 * clock moves the browser clock is set to the chain's latest block.
 */
import { openLoan } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc, increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

async function chainNow(): Promise<number> {
  const block = await anvilRpc<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
  return Number(BigInt(block.timestamp));
}

async function noOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('with one live loan there is no summary; the row already says it all', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 500, days: 30 });
  const { page, ctx } = await launchWallet('borrower');
  await page.goto('/positions');
  await connectWallet(page);
  await expect(page.locator(`[data-loan-id="${loanId}"]`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('positions-summary')).toHaveCount(0);
  await ctx.close();
});

test('two live loans: each side sees its principal per token, the next date with its loan, and the side choice narrows the card', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId: longer } = await openLoan(sc, {
    lender: 'lender',
    borrower: 'borrower',
    principalWeth: '0.4',
    collateralTliq: '2000',
    rateBps: 550,
    days: 30,
  });
  const { loanId: sooner } = await openLoan(sc, {
    lender: 'lender',
    borrower: 'borrower',
    principalWeth: '0.2',
    collateralTliq: '1000',
    rateBps: 400,
    days: 7,
  });

  for (const role of ['borrower', 'lender'] as const) {
    const { page, ctx } = await launchWallet(role);
    await page.goto('/positions');
    await connectWallet(page);

    const card = page.getByTestId('positions-summary');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole('heading', { level: 2 })).toHaveText('All your live loans together');
    const side = card.locator(`.summary-side[data-side="${role === 'borrower' ? 'borrowed' : 'lent'}"]`);
    await expect(side).toContainText(
      role === 'borrower' ? 'Borrowed, principal still owed: 0.6 WETH (live loans: 2).' : 'Lent, principal still out: 0.6 WETH (live loans: 2).',
    );
    // The sooner loan's repayment is the next date, and it links to that loan.
    const next = side.getByTestId('summary-next');
    await expect(next).toContainText(
      role === 'borrower'
        ? new RegExp(`Next repayment due .* UTC, on loan #${sooner}\\.`)
        : new RegExp(`Next repayment expected .* UTC, on loan #${sooner}\\.`),
    );
    await expect(next.getByRole('link', { name: `Open loan #${sooner}` })).toHaveAttribute('href', `/positions/${sooner}`);
    // The other side has no loans, so it has no block; interest is stated as outside the totals.
    await expect(card.locator('.summary-side')).toHaveCount(1);
    await expect(card).toContainText('Interest is not in these totals');
    await expect(page.locator(`[data-loan-id="${longer}"]`)).toHaveCount(1);
    await noOverflow(page);

    // The side choice that hides both loans hides the card too.
    const sideGroup = page.getByRole('group', { name: 'Which positions to show' });
    await sideGroup.getByRole('button', { name: role === 'lender' ? 'Borrowed' : 'Lent' }).click();
    await expect(card).toHaveCount(0);
    await sideGroup.getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId('positions-summary')).toBeVisible();
    await ctx.close();
  }
});

test('a loan past its date is named under the grace period and the next date moves to the other loan', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId: longer } = await openLoan(sc, {
    lender: 'lender',
    borrower: 'borrower',
    principalWeth: '0.4',
    collateralTliq: '2000',
    rateBps: 550,
    days: 30,
  });
  const { loanId: sooner } = await openLoan(sc, {
    lender: 'lender',
    borrower: 'borrower',
    principalWeth: '0.2',
    collateralTliq: '1000',
    rateBps: 400,
    days: 7,
  });
  await increaseTime(7 * 24 * 60 * 60 + 600);
  await mine();
  const now = await chainNow();

  const { page, ctx } = await launchWallet('borrower');
  await page.clock.setFixedTime(new Date(now * 1000));
  await page.goto('/positions');
  await connectWallet(page);

  const card = page.getByTestId('positions-summary');
  await expect(card).toBeVisible({ timeout: 60_000 });
  const inGrace = card.getByTestId('summary-in-grace');
  await expect(inGrace).toContainText('Past due, in the grace period (1):');
  await expect(inGrace.getByRole('link', { name: `loan #${sooner}` })).toHaveAttribute('href', `/positions/${sooner}`);
  await expect(card.getByTestId('summary-past-grace')).toHaveCount(0);
  await expect(card.getByTestId('summary-next')).toContainText(new RegExp(`on loan #${longer}\\.`));
  await noOverflow(page);
  await ctx.close();
});
