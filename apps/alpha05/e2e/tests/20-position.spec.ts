/**
 * Position, one loan read-only (matrix LN-04, LN-07, LN-08, LN-09, LN-10,
 * LN-11, LN-12), against loans opened and repaid through the protocol's
 * public entry points on the fixture chain. Runs on the desktop and the phone
 * project; each run opens its own loans.
 */
import type { Locator } from '@playwright/test';
import { parseAbi, zeroAddress, type Hex } from 'viem';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';
import { accountFor } from '../lib/wallets';

/** The value beside a fact's label (exact label match). */
const fact = (section: Locator, label: string) =>
  section
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('xpath=following-sibling::dd[1]');

test('an address that names no loan says so', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/positions/abc');
  await expect(page.getByText('This address does not name a loan.')).toBeVisible();
});

test('a live loan states its status, the reader’s role, its dates, terms, health and collateral; a loan that does not exist says so', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.6', collateralTliq: '3000', rateBps: 525, days: 30 });

  for (const [role, expected] of [
    ['borrower', 'borrower'],
    ['lender', 'lender'],
    ['visitor', 'none'],
  ] as const) {
    const { page, ctx } = await launchWallet(role);
    await page.goto(`/positions/${loanId}`);
    await connectWallet(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Loan #${loanId}`);
    const status = page.getByTestId('position-status');
    await expect(status).toHaveText('Active: the loan is running.', { timeout: 60_000 });
    await expect(page.getByTestId('position-role')).toHaveAttribute('data-role', expected);

    const dates = page.getByRole('region', { name: 'Dates' });
    await expect(fact(dates, 'Due date of this term, before pause credit')).toHaveText(/UTC/);
    await expect(fact(dates, 'Pause credit')).toHaveText('None');
    await expect(fact(dates, 'Grace period ends')).toHaveText(/UTC/);
    await expect(fact(dates, 'Date the loan falls due')).toHaveText(/UTC/);

    // #3763 §6.1 — what the loan is, said to the side the reader holds, in
    // the variant every loan takes today; a viewer is told neither.
    if (expected === 'none') await expect(page.getByTestId('position-statement')).toHaveCount(0);
    else await expect(page.getByTestId(`position-statement-${expected}`)).toContainText('for 30 days. It does not renew.');
    // The cash-out door is the lender holder's alone, and Leave it comes first.
    if (expected === 'lender') {
      await page.getByTestId('get-cash-open').click();
      await expect(page.getByTestId('get-cash').locator('li').first()).toHaveAttribute('data-testid', 'get-cash-leave');
      await expect(page.getByTestId('get-cash-leave')).toContainText('The loan runs to the date it falls due');
      await expect(page.getByTestId('get-cash-now-none')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('get-cash-list-go')).toBeVisible();
      await page.getByTestId('get-cash-hide').click();
    } else await expect(page.getByTestId('get-cash')).toHaveCount(0);

    const terms = page.getByRole('region', { name: 'Terms' });
    await expect(fact(terms, 'Principal still owed')).toHaveText('0.6 WETH');
    await expect(fact(terms, 'Interest rate')).toHaveText('5.25% a year');
    await expect(fact(terms, 'Term')).toHaveText('30 days');
    await expect(fact(terms, 'Interest')).toHaveText(/^(Full term|Pro rata)/);
    await expect(fact(terms, 'Interest schedule')).toHaveText('All at repayment');
    await expect(fact(terms, "Protocol's share of interest")).toHaveText(/%, fixed when the loan opened$/);
    await expect(fact(terms, 'Collateral')).toHaveText('3,000 tLIQ');

    const health = page.getByRole('region', { name: 'Health' });
    await expect(fact(health, 'Health factor')).toHaveText(/^\d/);
    await expect(fact(health, 'Liquidation threshold')).toHaveText(/% loan-to-value, fixed when the loan opened$/);
    // The internal-match band is stated from the protocol: a band, or that matching is off or holds none.
    await expect(fact(health, 'Held for an internal match')).toHaveText(/^(From \d.*% loan-to-value; an outside sale opens at .*%|No: .*)$/);

    const held = page.getByRole('region', { name: 'Collateral held' });
    await expect(fact(held, 'Amount')).toHaveText('3,000 tLIQ');
    await expect(fact(held, 'Where it is')).toHaveText(/^Held for this loan in the vault of 0x/);
    await expect(page.getByTestId('position-actions-later')).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    if (role === 'visitor') {
      await page.goto('/positions/999999999');
      await expect(page.getByText(/^No loan #999999999 exists on /)).toBeVisible({ timeout: 60_000 });
    }
    await ctx.close();
  }
});

test('a repaid loan states it, with no dates to meet and its collateral held until its claim is collected', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.15', collateralTliq: '750', rateBps: 400, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  const { page } = await launchWallet('lender');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await expect(page.getByTestId('position-status')).toHaveText('Repaid.', { timeout: 60_000 });
  await expect(page.getByTestId('position-status')).toHaveAttribute('data-status', 'repaid');
  await expect(page.getByRole('region', { name: 'Dates' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Health' })).toHaveCount(0);
  await expect(fact(page.getByRole('region', { name: 'Terms' }), 'Principal on the loan when it ended')).toHaveText('0.15 WETH');
  await expect(fact(page.getByRole('region', { name: 'Collateral held' }), 'Where it is')).toHaveText(/^Held in the vault of 0x.* until its claim is collected on Claims$/);
});

test('#3721: a position token approved for transfer is named to its holder, with the step that removes it', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.5', collateralTliq: '3000', rateBps: 500, days: 30 });
  const { borrowerTokenId } = await sc.read<{ borrowerTokenId: bigint }>('getLoanDetails', [loanId]);
  const nft = await sc.read<Hex>('positionNFT', []);
  const ABI = parseAbi(['function approve(address to, uint256 tokenId)', 'function getApproved(uint256 tokenId) view returns (address)']);
  const to = accountFor('visitor').address;
  await sc.write('borrower', nft, ABI, 'approve', [to, borrowerTokenId]);

  // A wallet that does not hold the token is not told about it.
  const visitor = await launchWallet('visitor');
  await visitor.page.goto(`/positions/${loanId}`);
  await connectWallet(visitor.page);
  await expect(visitor.page.getByTestId('position-status')).toBeVisible({ timeout: 60_000 });
  await expect(visitor.page.getByTestId('position-approval-borrower')).toHaveCount(0);
  await visitor.ctx.close();

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const card = page.getByTestId('position-approval-borrower');
  await expect(card).toContainText(`approved for transfer to ${to}`, { timeout: 60_000 });
  await expect(page.getByTestId('position-approval-lender')).toHaveCount(0);
  await card.getByTestId('position-approval-remove-borrower').click();
  const flow = page.getByTestId('position-approval-review-borrower');
  await expect(flow).toContainText(to);
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  expect(flags.sentTransactions).toBe(sent + 1);
  expect((await sc.pub.readContract({ address: nft, abi: ABI, functionName: 'getApproved', args: [borrowerTokenId] })).toLowerCase()).toBe(zeroAddress);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('position-approval-borrower')).toHaveCount(0, { timeout: 60_000 });
});
