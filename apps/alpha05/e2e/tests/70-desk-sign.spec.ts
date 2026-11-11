/**
 * Signing a new order from the rate desk's ticket (matrix OFF-59). A lender's
 * offer opens the WETH against tLIQ 30-day market. On its desk the lender
 * switches the ticket to "signed without gas": the fill choice gives way to
 * the signed order's one shape, and an order that never lapses is refused.
 * The review states the order, when it lapses, that nothing is set aside,
 * what a fill draws from the lender's own vault and what the vault holds free
 * of it now (nothing, so the shortfall is named). One consent, one wallet
 * signature and no transaction later, the stand-in offer book lists the
 * order, and it shows under Your signed orders as open on the chain. The
 * chain itself confirms the signature: its order hash is the one the book
 * stores, and the protocol's own digest recovers to the lender. Runs on the
 * desktop and the phone project; the chain is reverted after each test.
 */
import { recoverAddress, type Hex } from 'viem';
import { postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { typedMessage, type SignedOrderWire } from '../../src/shared/desk/signedOrder';
import { scenario } from '../lib/chain';
import { STUB_ORIGIN } from '../lib/stub';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a lender signs an order from the ticket: one shape, a stated review, no gas, listed on the book', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await postLenderOffer(sc, { lender: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const lender = accountFor('lender').address.toLowerCase();
  const market = `${WETH.toLowerCase()}-${tliq.toLowerCase()}-30`;

  const { page, flags } = await launchWallet('lender', { advanced: true });
  await page.goto(`/desk?market=${market}`);
  await connectWallet(page);
  const ticket = page.getByTestId('desk-ticket');
  await expect(ticket).toHaveAttribute('data-market', market);

  // Signed mode: the vault line and the one shape replace the balance and the fill choice.
  const mode = ticket.getByTestId('desk-ticket-mode');
  await mode.getByRole('radio', { name: /Signed without gas/ }).check();
  await expect(ticket.getByTestId('desk-ticket-sign-vault')).toContainText('at a fill, the amount comes from your own vault');
  await expect(ticket.getByTestId('desk-ticket-balance')).toHaveCount(0);
  await expect(ticket.getByTestId('desk-ticket-fill')).toHaveCount(0);
  await expect(ticket.getByTestId('desk-ticket-sign-shape')).toContainText('fills whole or not at all');
  await expect(ticket.getByTestId('desk-ticket-review')).toHaveText('Review signed order');

  await ticket.getByTestId('desk-ticket-amount').fill('0.05');
  await ticket.getByTestId('desk-ticket-collateral').fill('250');
  await ticket.getByTestId('desk-ticket-rate').fill('6');
  const blocker = ticket.getByTestId('desk-ticket-blocker');
  await expect(blocker).toHaveCount(0, { timeout: 60_000 });
  // An order that never lapses is refused: only a cancel on the chain would stop it.
  await ticket.getByTestId('desk-ticket-expiry').getByRole('radio', { name: 'Until taken or cancelled' }).check();
  await expect(blocker).toHaveText('A signed order must lapse: choose how long it stays open. Only a cancel on the chain would stop one that never lapses.');
  await expect(ticket.getByTestId('desk-ticket-review')).toBeDisabled();
  await ticket.getByTestId('desk-ticket-expiry').getByRole('radio', { name: '7 days' }).check();
  await expect(blocker).toHaveCount(0);
  await fitsWidth(page);

  // The review: what the wallet signs, and what a fill would draw.
  await ticket.getByTestId('desk-ticket-review').click();
  const review = ticket.getByTestId('desk-sign-review');
  const receipt = review.locator('.receipt');
  await expect(receipt).toContainText('Review your signed order', { timeout: 60_000 });
  await expect(receipt).toContainText('at 6% a year for 30 days');
  await expect(receipt).toContainText('Fillable until');
  await expect(receipt).toContainText('Whole or not at all: one taker fills the whole amount.');
  await expect(receipt).toContainText('Nothing. Signing costs no gas and moves nothing.');
  await expect(receipt).toContainText('At a fill, from your own vault');
  await expect(receipt).toContainText('Free in your vault now');
  await expect(receipt).toContainText('The protocol checks this order only when someone fills it');
  await expect(receipt).toContainText('The only way to stop one before it lapses is a cancel on the chain');
  await expect(receipt).toContainText('The signature can be filled only on this network');
  // The vault holds none of it free, so a fill now would fail: said, not blocked.
  await expect(receipt).toContainText('Your vault holds less of it free than a fill needs');
  const submit = review.getByTestId('desk-sign-submit');
  await expect(submit).toBeDisabled();
  await review.getByTestId('desk-sign-consent').check();
  await expect(submit).toBeEnabled();
  await fitsWidth(page);

  // One signature, no transaction, then the book's answer.
  const sent = flags.sentTransactions;
  await submit.click();
  const result = ticket.getByTestId('desk-sign-result');
  await expect(result).toHaveAttribute('data-kind', 'listed', { timeout: 60_000 });
  await expect(result).toContainText('Listed on the offer book');
  await expect(result).toContainText('The offer book lists your order. Nothing has moved.');
  expect(flags.sentTransactions).toBe(sent);

  // The book holds it, and the chain agrees on its hash and its signer.
  const book = await fetch(
    `${STUB_ORIGIN}/signed-offers?chainId=${sc.chain.id}&lendingAsset=${WETH.toLowerCase()}&collateralAsset=${tliq.toLowerCase()}&durationDays=30&signer=${lender}`,
  );
  const listed = ((await book.json()) as { offers: { orderHash: Hex; order: SignedOrderWire; signature: Hex }[] }).offers;
  expect(listed).toHaveLength(1);
  const { orderHash, order, signature } = listed[0]!;
  expect(order.fillMode).toBe('1');
  expect(order.amount).toBe(order.amountMax);
  expect(order.deadline).toBe(order.expiresAt);
  expect(order.interestRateBps).toBe('600');
  expect(await sc.read<Hex>('signedOfferOrderHash', [typedMessage(order)])).toBe(orderHash);
  const digest = await sc.read<Hex>('hashSignedOffer', [typedMessage(order)]);
  expect((await recoverAddress({ hash: digest, signature })).toLowerCase()).toBe(lender);

  // It shows under Your signed orders, open on the chain.
  const panel = page.getByTestId('desk-signed');
  await expect(panel.locator(`[data-order-hash="${orderHash}"]`)).toHaveAttribute('data-standing', 'open', { timeout: 60_000 });
  await fitsWidth(page);

  // Done starts the ticket afresh, still in signed mode.
  await result.getByTestId('desk-sign-done').click();
  await expect(ticket.getByTestId('desk-ticket-amount')).toHaveValue('');
  await expect(mode.getByRole('radio', { name: /Signed without gas/ })).toBeChecked();
});
