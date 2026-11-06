/**
 * Home (matrix RW-70, RW-72, ACC-05, OFF-44's entry, ACC-31, RB-CONFIDENCE's
 * first-run cards), against loans opened, repaid and paused through the
 * protocol's public entry points on the fixture chain, as the same role
 * wallets the app is connected with. Runs on the desktop and the phone
 * project; each run opens its own loans and asserts on those, so the second
 * project's run never depends on the first.
 */
import { openLoan, postLenderOffer, repayInFull } from '@vaipakam/anvil-harness/lending';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const INTENTS = ['/borrow', '/lend', '/rent', '/rent?side=owner', '/positions'];

test('with no wallet, Home leads with the job chooser and states the protocol is running', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/');
  const chooser = page.getByRole('region', { name: 'I want to…' });
  await expect(chooser).toBeVisible();
  const hrefs = await chooser.locator('a.intent').evaluateAll((links) => links.map((a) => a.getAttribute('href')));
  expect(hrefs).toEqual(INTENTS);
  await expect(page.getByText('Connect a wallet to see your loans, offers and payouts here.')).toBeVisible();
  await expect(page.getByText('Protocol status on Base Sepolia: running.')).toBeVisible({ timeout: 60_000 });
  // The chooser comes before the quiet status line: a newcomer meets a job first.
  const order = await page.locator('main').evaluate((main) => {
    const chooserTop = main.querySelector('#home-intent')!.getBoundingClientRect().top;
    const status = [...main.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Protocol status'))!;
    return chooserTop < status.getBoundingClientRect().top;
  });
  expect(order).toBe(true);
});

test('a wallet with nothing yet sees the first-run cards, "nothing yet" and the job chooser; dismissals persist', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto('/');
  await connectWallet(page);
  const cards = page.getByRole('region', { name: 'Getting started' });
  await expect(cards.locator('[data-card]')).toHaveCount(3);
  await expect(page.getByText('Nothing yet on Base Sepolia: no live loans, open offers or payouts.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'I want to…' })).toBeVisible();
  // The sync chip names how long ago and through which source the book was read.
  // The book's own stamp (a direct child of the page; the rewards section
  // carries its own).
  await expect(page.locator('main > .stamp', { hasText: /^Synced .* ago through (your wallet|the read-only proxy|the public endpoint)\./ })).toBeVisible();

  await cards.locator('[data-card="vault"]').getByRole('button', { name: 'Got it' }).click();
  await expect(cards.locator('[data-card]')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Getting started' }).locator('[data-card]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Hide these' }).click();
  await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);
});

test('each side sees its live loan with its side, terms, due date and a button that opens it; the lender sees the open offer', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '1', collateralTliq: '5000', rateBps: 500, days: 30 });
  // A one-day loan, due within the three days Home calls "soon".
  const left = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.5', collateralTliq: '2500', rateBps: 700, days: 1 });
  // An offer the lender leaves open.
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.3', collateralTliq: '1500', rateBps: 650, days: 14 });

  for (const role of ['lender', 'borrower'] as const) {
    const { page, ctx } = await launchWallet(role);
    await page.goto('/');
    await connectWallet(page);
    const card = page.locator(`[data-loan-id="${loanId}"]`);
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole('heading')).toHaveText(`Loan #${loanId}: you are the ${role}`);
    await expect(card).toContainText('1 WETH at 5% a year, on a 30-day term.');
    await expect(card).toContainText('Collateral: 5,000 tLIQ.');
    await expect(card).toContainText(/Repayment due .* UTC\./);
    await expect(card).toContainText(/Health factor \d/);
    const open = card.getByRole('link', { name: `Open loan #${loanId}` });
    await expect(open).toHaveAttribute('href', `/positions/${loanId}`);

    // A one-day loan is due within three days: the borrower is told, as a
    // consequence, that a late fee follows; the lender is told the date.
    const soon = page.locator(`[data-loan-id="${left.loanId}"]`);
    await expect(soon).toHaveAttribute('data-stage', 'due-soon');
    if (role === 'borrower') await expect(soon.locator('.stage.tier-a')).toContainText('after that, a late fee applies');
    else await expect(soon.locator('.stage')).toContainText(/^Repayment is due .* UTC, in /);

    // The most urgent deadline comes first.
    const ids = await page.locator('.home [data-loan-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-loan-id')));
    expect(ids.indexOf(String(left.loanId))).toBeLessThan(ids.indexOf(String(loanId)));
    await expect(page.getByText(role === 'lender' ? /^You are only lending \(live loans: \d+\)\./ : /^You are only borrowing \(live loans: \d+\)\./)).toBeVisible();

    const offers = page.getByRole('region', { name: 'Your open offers' });
    if (role === 'lender') {
      // Newest first, so this run's offer is among the ones Home lists.
      await expect(offers.locator(`[data-offer-id="${offerId}"]`)).toHaveText(`Offer #${offerId}: lend 0.3 WETH at 6.5% a year, on a 14-day term.`);
      await expect(offers.getByRole('link', { name: 'See your offers' })).toHaveAttribute('href', '/offers');
    } else {
      // The lender's offer is never the borrower's. Other specs may leave the
      // borrower's own requests open, so only this offer is checked.
      await expect(offers.locator(`[data-offer-id="${offerId}"]`)).toHaveCount(0);
    }
    await ctx.close();
  }
});

test('a repaid loan is a payout ready to collect, listed before the live loans, pointing at Claims', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.2', collateralTliq: '1000', rateBps: 400, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  // One loan left live, so the order of the two sections is observable.
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.2', collateralTliq: '1000', rateBps: 400, days: 30 });

  const { page } = await launchWallet('lender');
  await page.goto('/');
  await connectWallet(page);
  const payouts = page.getByRole('region', { name: 'Ready to collect' });
  const row = payouts.locator(`[data-payout="lender:${loanId}"]`);
  await expect(row).toHaveText(`Loan #${loanId}, as lender: a payout is ready.`, { timeout: 60_000 });
  await expect(payouts.getByRole('link', { name: 'Open in Claims' })).toHaveAttribute('href', '/claims');
  // Home names the payout and leaves its amounts to Claims: no figure here.
  await expect(payouts.getByText('Amounts, and how each payout is paid, are on Claims', { exact: false })).toBeVisible();
  const before = await page.locator('main').evaluate((main) => {
    const p = main.querySelector('#home-payouts')!;
    const l = main.querySelector('#home-loans')!;
    return Boolean(p.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  // The repaid loan is no longer live.
  await expect(page.locator(`[data-loan-id="${loanId}"]`)).toHaveCount(0);
});

test('a position follows its NFT: a lender who transferred it no longer sees the loan, the borrower still does', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 450, days: 30 });
  const [view] = await sc.read<readonly { loan: { lenderTokenId: bigint } }[]>('getLoansBatch', [[loanId]]);
  // The lender position moves to a wallet this suite does not drive; the
  // loan's recorded lender is unchanged, which is what an index walk would read.
  await sc.diamondWrite('lender', 'transferFrom', [accountFor('lender').address, '0x000000000000000000000000000000000000dEaD', view!.loan.lenderTokenId]);

  const borrower = await launchWallet('borrower');
  await borrower.page.goto('/');
  await connectWallet(borrower.page);
  await expect(borrower.page.locator(`[data-loan-id="${loanId}"]`)).toBeVisible({ timeout: 60_000 });
  await borrower.ctx.close();

  const { page } = await launchWallet('lender');
  await page.goto('/');
  await connectWallet(page);
  await expect(page.locator('main > .stamp', { hasText: /^Synced .* ago through / })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-loan-id="${loanId}"]`)).toHaveCount(0);
});

test('a paused protocol is stated at the top of Home with what stays open', async ({ launchWallet }) => {
  const sc = scenario();
  await sc.diamondWrite('admin', 'pause');
  try {
    const { page } = await launchWallet('visitor', { preAuthorized: false });
    await page.goto('/');
    const paused = page.getByText('The protocol on Base Sepolia is paused', { exact: false });
    await expect(paused).toBeVisible({ timeout: 60_000 });
    await expect(paused).toContainText('Full and partial repayment and adding collateral stay open');
    await expect(page.getByText('Protocol status on Base Sepolia: running.')).toHaveCount(0);
    const top = await page.locator('main').evaluate((main) => {
      const status = [...main.querySelectorAll('p')].find((p) => p.textContent?.includes('is paused'))!;
      return status.getBoundingClientRect().top < main.querySelector('#home-intent')!.getBoundingClientRect().top;
    });
    expect(top).toBe(true);
  } finally {
    await sc.diamondWrite('admin', 'unpause');
  }
});
