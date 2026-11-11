/**
 * The rate desk's order ticket (matrix OFF-74). A lender's offer opens a
 * WETH against tLIQ 30-day market. On that market's desk a lender types an
 * offer on the ticket: only the first thing in the way shows beneath the
 * action, "fill to balance" types the wallet's whole WETH balance exactly,
 * the terms the ticket does not let the reader change and the fees at
 * today's list rates are stated, and signed orders are named as not
 * available. The guided flows' own review then posts it, and the chain
 * holds it as typed at the market's term. Switching to the borrower side
 * relabels the ticket and opens the request review. Runs on the desktop and
 * the phone project; the chain is reverted after each test.
 */
import { erc20Abi, formatEther, parseEther, type Hex } from 'viem';
import { postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

interface StoredOffer {
  creator: Hex;
  offerType: number;
  fillMode: number;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAmount: bigint;
  durationDays: bigint;
  expiresAt: bigint;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  periodicInterestCadence: number;
}

test('a lender posts from the order ticket: first blocker, fill to balance, stated terms and fees, and the shared review', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const lender = accountFor('lender').address;
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.2'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);
  const held = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lender] });
  const market = `${WETH.toLowerCase()}-${tliq.toLowerCase()}-30`;

  const { page, flags } = await launchWallet('lender', { advanced: true });
  await page.goto(`/desk?market=${market}`);
  await connectWallet(page);
  const ticket = page.getByTestId('desk-ticket');
  await expect(ticket).toHaveAttribute('data-market', market);
  await expect(ticket).toContainText('Post a limit-rate offer or request on WETH against');
  await expect(ticket).toContainText('30-day term');

  // Nothing typed: the first thing in the way, beneath the action.
  const blocker = ticket.getByTestId('desk-ticket-blocker');
  await expect(blocker).toHaveText('Enter an amount.', { timeout: 60_000 });
  await expect(ticket.getByTestId('desk-ticket-review')).toBeDisabled();

  // The terms the ticket fixes, and the mode it posts in.
  await expect(ticket.getByTestId('desk-ticket-fixed')).toContainText('a 30-day term, interest for the full term even if repaid early');
  await expect(ticket.getByTestId('desk-ticket-mode')).toContainText('Posted on the chain: you pay gas, and the amount waits in your own vault.');
  await expect(ticket.getByTestId('desk-ticket-mode').getByRole('radio', { name: /Signed without gas/ })).toBeDisabled();

  // Fill to balance types the wallet's whole balance, every digit.
  await expect(ticket.getByTestId('desk-ticket-balance')).toContainText('Your wallet holds');
  await ticket.getByTestId('desk-ticket-fill-balance').click();
  await expect(ticket.getByTestId('desk-ticket-amount')).toHaveValue(formatEther(held));

  // Each field in turn becomes the first blocker until it is right.
  await ticket.getByTestId('desk-ticket-amount').fill('0.1');
  await expect(blocker).toHaveText('Enter a collateral amount.');
  await ticket.getByTestId('desk-ticket-collateral').fill('500');
  await expect(blocker).toHaveText('Enter a rate.');
  await ticket.getByTestId('desk-ticket-rate').fill('101');
  await expect(blocker).toHaveText('The highest rate is 100% a year.');
  await ticket.getByTestId('desk-ticket-rate').fill('6.25');
  // A fill below the whole amount needs a smallest single fill below it:
  // one size only ever fills whole.
  await expect(ticket.getByTestId('desk-ticket-min-fill')).toHaveCount(0);
  await ticket
    .getByTestId('desk-ticket-fill')
    .getByRole('radio', { name: /Immediate or cancel/ })
    .check();
  await expect(blocker).toHaveText('Enter a smallest single fill.');
  await ticket.getByTestId('desk-ticket-min-fill').fill('0.1');
  await expect(blocker).toHaveText(
    'A partial or immediate-or-cancel fill needs a smallest fill below the whole amount. For one fill of the whole amount, choose All or none.',
  );
  await ticket.getByTestId('desk-ticket-min-fill').fill('0.04');
  await ticket.getByTestId('desk-ticket-expiry').getByRole('radio', { name: 'Until taken or cancelled' }).check();
  await expect(blocker).toHaveText('Immediate or cancel needs a lapse: choose how long it stays open.');
  await ticket
    .getByTestId('desk-ticket-fill')
    .getByRole('radio', { name: /All or none/ })
    .check();
  await ticket.getByTestId('desk-ticket-expiry').getByRole('radio', { name: '30 days' }).check();
  await expect(blocker).toHaveCount(0);
  await expect(ticket.getByTestId('desk-ticket-min-fill')).toHaveCount(0);
  await expect(ticket.getByTestId('desk-ticket-fixed')).toContainText('no collateral range, no fee tariff and no price guard');
  await expect(ticket.getByTestId('desk-ticket-fees')).toContainText('Fees at today’s list rates: the borrower pays 0.2% of the amount');
  await expect(ticket.getByTestId('desk-ticket-fees')).toContainText('you get back');
  await fitsWidth(page);

  // The guided flows' own review posts it.
  await ticket.getByTestId('desk-ticket-review').click();
  const flow = ticket.locator('.post-request');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Post your lending offer', { timeout: 60_000 });
  await expect(receipt).toContainText('6.25% a year');
  await expect(receipt).toContainText('30 days after a borrower takes it');
  await expect(receipt).toContainText('All of it by one borrower, or not at all');
  await expect(receipt).toContainText('Exactly 0.1');
  const confirm = flow.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await flow.getByTestId('request-consent').check();
  const sent = flags.sentTransactions;
  await confirm.click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('posted and open for borrowers');
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain holds it as typed, at the market's term and the ticket's defaults.
  const id = BigInt((await finish.textContent())!.match(/Offer #(\d+)/)![1]!);
  const offer = await sc.read<StoredOffer>('getOffer', [id]);
  expect(offer.creator.toLowerCase()).toBe(lender.toLowerCase());
  expect(offer.offerType).toBe(0);
  expect(offer.fillMode).toBe(1);
  expect([offer.amount, offer.amountMax]).toEqual([parseEther('0.1'), parseEther('0.1')]);
  expect([offer.interestRateBps, offer.interestRateBpsMax]).toEqual([625n, 625n]);
  expect(offer.collateralAmount).toBe(parseEther('500'));
  expect(offer.durationDays).toBe(30n);
  expect(offer.expiresAt > 0n).toBe(true);
  expect(offer.useFullTermInterest).toBe(true);
  expect(offer.allowsPartialRepay).toBe(false);
  expect(offer.periodicInterestCadence).toBe(0);

  // Closing returns a clean ticket on the same side.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(ticket.getByTestId('desk-ticket-amount')).toHaveValue('');
  await expect(ticket.getByTestId('desk-ticket-side').getByRole('radio', { name: 'Lend at a rate' })).toBeChecked();

  // The borrower side relabels the ticket and opens the request review.
  await ticket.getByTestId('desk-ticket-side').getByRole('radio', { name: 'Borrow at a rate' }).check();
  await expect(ticket).toContainText('Collateral you lock');
  await expect(ticket).toContainText('Highest rate you pay, % a year');
  await expect(ticket.getByTestId('desk-ticket-mode')).toContainText('the collateral waits in your own vault');
  await ticket.getByTestId('desk-ticket-amount').fill('0.01');
  await ticket.getByTestId('desk-ticket-collateral').fill('100');
  await ticket.getByTestId('desk-ticket-rate').fill('4.5');
  await expect(ticket.getByTestId('desk-ticket-fees')).toContainText('If taken now, you receive');
  // A partial request posts from its smallest fill to the whole amount.
  await ticket
    .getByTestId('desk-ticket-fill')
    .getByRole('radio', { name: /Partial/ })
    .check();
  await expect(ticket).toContainText('Taken directly, a loan locks all of it. A match locks only what its lender asks for.');
  await ticket.getByTestId('desk-ticket-min-fill').fill('0.005');
  await expect(blocker).toHaveCount(0);
  await ticket.getByTestId('desk-ticket-review').click();
  const request = ticket.locator('.post-request .receipt');
  await expect(request).toContainText('Post your borrow request', { timeout: 60_000 });
  await expect(request).toContainText('4.5% a year');
  await expect(request).toContainText('Smallest amount a lender may lend');
  await expect(request).toContainText('Taken directly: the smallest amount; by matches: up to the largest');
  await fitsWidth(page);
});
