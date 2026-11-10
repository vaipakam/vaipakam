/**
 * An offer's terms must stand a minimum age before a fill (#3443). A lender
 * posts an offer and the admin raises the minimum age to a minute, so the
 * offer is too new to take. A borrower opening the review is told how long
 * the terms must stand and how long was left at the block the review read,
 * with no step to sign; once the chain moves past that moment the review,
 * which reads the chain each block, lifts the refusal by itself and offers
 * the consent step. Runs on the desktop and the phone; the suite reverts the
 * chain after every test.
 */
import type { Page } from '@playwright/test';
import { parseEther } from 'viem';
import { postLenderOffer } from '@vaipakam/anvil-harness/lending';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a just-changed offer says how long is left before it can be taken, and the refusal lifts by itself', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, `0x${string}`>).liquidToken!;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 520, days: 14 });
  const id = offerId.toString();
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [accountFor('borrower').address, parseEther('400')]);
  // The terms stood the default few seconds; a one-minute minimum makes them
  // too new again.
  await sc.diamondWrite('admin', 'setMinTermsAgeSec', [60]);

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });
  await page.getByTestId('offer-page-take').click();

  const review = page.locator(`.accept-offer[data-offer-id="${id}"]`);
  const wait = review.getByText('An offer can be taken only once its terms have stood 1 min');
  await expect(wait).toBeVisible({ timeout: 60_000 });
  await expect(wait).toContainText(/at the last block read \d+ s was left/);
  await expect(wait).toContainText('this refusal lifts by itself when the time is up. Nothing was sent.');
  await expect(review.getByTestId('accept-consent')).toHaveCount(0);
  await fitsWidth(page);

  // The chain moves past the moment the terms become fillable.
  await increaseTime(61);
  await mine();
  await expect(wait).toHaveCount(0, { timeout: 60_000 });
  await expect(review.getByTestId('accept-consent')).toBeVisible();
  expect(flags.sentTransactions).toBe(0);
});
