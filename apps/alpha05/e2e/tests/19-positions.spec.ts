/**
 * Positions (matrix LN-05, LN-08, LN-10, LN-11; rulebook §4 list with quick
 * actions), against loans opened and repaid through the protocol's public
 * entry points on the fixture chain, as the same role wallets the app is
 * connected with. Runs on the desktop and the phone project; each run opens
 * its own loans and asserts on those, so the second project's run never
 * depends on the first.
 */
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';
import { accountFor } from '../lib/wallets';

test('with no wallet, Positions asks for one and lists nothing', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/positions');
  await expect(page.getByRole('heading', { level: 1, name: 'Positions' })).toBeVisible();
  await expect(page.getByText('Connect a wallet to see the loans you lent or borrowed in.')).toBeVisible();
  await expect(page.locator('[data-loan-id]')).toHaveCount(0);
});

test('each side sees its live loan and its repaid loan, in the order payouts, live, ended; a side choice narrows the list', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId: live } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.4', collateralTliq: '2000', rateBps: 550, days: 30 });
  const { loanId: repaid } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.2', collateralTliq: '1000', rateBps: 400, days: 30 });
  await repayInFull(sc, 'borrower', repaid);

  for (const role of ['lender', 'borrower'] as const) {
    const { page, ctx } = await launchWallet(role);
    await page.goto('/positions');
    await connectWallet(page);

    // The live loan: its side, terms, due date, and a button that opens it.
    const card = page.getByRole('region', { name: 'Your loans' }).locator(`[data-loan-id="${live}"]`);
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole('heading')).toHaveText(`Loan #${live}: you are the ${role}`);
    await expect(card).toContainText('0.4 WETH at 5.5% a year, on a 30-day term.');
    await expect(card).toContainText(/Repayment due .* UTC\./);
    await expect(card.getByRole('link', { name: `Open loan #${live}` })).toHaveAttribute('href', `/positions/${live}`);

    // The repaid loan is not live: it is listed under Ended with its status,
    // and points at Claims while its payout waits there.
    const ended = page.getByRole('region', { name: 'Ended loans' });
    const done = ended.locator(`[data-loan-id="${repaid}"]`);
    await expect(done).toHaveAttribute('data-status', 'repaid');
    await expect(done.getByRole('heading')).toHaveText(`Loan #${repaid}: you were the ${role}`);
    await expect(done).toContainText('Repaid.');
    await expect(done.getByRole('link', { name: `Open loan #${repaid}` })).toHaveAttribute('href', `/positions/${repaid}`);
    const payouts = page.getByRole('region', { name: 'Ready to collect' });
    await expect(payouts.locator(`[data-payout="${role}:${repaid}"]`)).toBeVisible();
    await expect(done.getByRole('link', { name: 'A payout is ready on this position; collect it on Claims.' })).toHaveAttribute('href', '/claims');

    // Payouts first, then live loans, then ended loans.
    const order = await page.locator('main').evaluate((main) => {
      const ids = ['home-payouts', 'home-loans', 'positions-ended'].map((id) => main.querySelector(`#${id}`)!);
      return ids[0]!.compareDocumentPosition(ids[1]!) & Node.DOCUMENT_POSITION_FOLLOWING && ids[1]!.compareDocumentPosition(ids[2]!) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(Boolean(order)).toBe(true);

    // The side choice: the other side hides both of this run's loans; this
    // role's side shows them again.
    const sideGroup = page.getByRole('group', { name: 'Which positions to show' });
    const other = sideGroup.getByRole('button', { name: role === 'lender' ? 'Borrowed' : 'Lent' });
    await other.click();
    await expect(other).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-loan-id="${live}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-loan-id="${repaid}"]`)).toHaveCount(0);
    await sideGroup.getByRole('button', { name: role === 'lender' ? 'Lent' : 'Borrowed' }).click();
    await expect(page.locator(`[data-loan-id="${live}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-loan-id="${repaid}"]`)).toHaveCount(1);

    // Nothing runs off the side of the page, on a phone or a desktop.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await ctx.close();
  }
});

test('a position received on an ended loan is stated apart under Ready to collect, and the side choice narrows it too', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 400, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  // The lender hands the ended loan's lender position to the visitor, who is
  // not the recorded party: the protocol's pending view does not cover it.
  // The suite reverts the chain after the test, so the visitor still holds
  // nothing for the specs that need a wallet with nothing yet.
  const { lenderTokenId } = await sc.read<{ lenderTokenId: bigint }>('getLoanDetails', [loanId]);
  await sc.positionTransfer('lender', accountFor('visitor').address, lenderTokenId);

  const { page, ctx } = await launchWallet('visitor');
  await page.goto('/positions');
  await connectWallet(page);
  const payouts = page.getByRole('region', { name: 'Ready to collect' });
  await expect(payouts).toContainText(/received from another wallet: \d+\. Claims shows whether they pay\./, { timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Ended loans' }).locator(`[data-loan-id="${loanId}"]`)).toBeVisible();

  // Every position the visitor received is a lender one, so "Borrowed"
  // leaves nothing: not the loan, and not the unverified payout either.
  const sideGroup = page.getByRole('group', { name: 'Which positions to show' });
  await sideGroup.getByRole('button', { name: 'Borrowed' }).click();
  await expect(page.getByText(/None of your positions on .* match this choice\./)).toBeVisible();
  await expect(payouts).toHaveCount(0);
  await expect(page.locator(`[data-loan-id="${loanId}"]`)).toHaveCount(0);
  await sideGroup.getByRole('button', { name: 'Lent' }).click();
  await expect(payouts).toContainText(/received from another wallet: \d+\./);
  await ctx.close();
});
