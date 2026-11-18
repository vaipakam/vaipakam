/**
 * Key risks (#3661, RB-KEY-RISKS): the short key-risk list is shown with
 * the Terms before the wallet accepts them; every review that opens a loan
 * carries the one "If things go wrong" line for its side and for how the
 * loan settles, linked to the risk page; and the risk page is reachable
 * from the footer with no wallet. Runs on the desktop and the phone
 * project; the chain is reverted after each test.
 */
import { erc20Abi, keccak256, parseEther, toHex, type Hex } from 'viem';
import { WETH, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

test('the risk page is one tap from the footer, with no wallet, and states the short list and the further points', async ({ page }) => {
  await page.goto('/');
  await page.locator('footer').getByRole('link', { name: 'Key risks' }).click();
  await expect(page).toHaveURL(/\/risks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Key risks' })).toBeVisible();
  const list = page.getByTestId('risks-key');
  await expect(list.locator('li')).toHaveCount(6);
  await expect(list).toContainText('You can lose some or all of your funds.');
  await expect(list).toContainText('If it cannot be sold, you receive the collateral itself');
  await expect(page.getByTestId('risks-more')).toContainText('Tax on what you do here is your own responsibility.');
  await fitsWidth(page);
});

test('the Terms prompt shows the key risks above the accept step', async ({ launchWallet }) => {
  const sc = scenario({ lender: 'freshLender' });
  await sc.diamondWrite('admin', 'publishTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const { page, flags } = await launchWallet('freshLender');
  const sent = flags.sentTransactions;
  await page.goto('/vault');
  await connectWallet(page);
  // The acceptance asked as the wallet connects shows them too.
  const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
  await expect(dialog).toContainText('Using this app with your wallet needs the Terms of Service', { timeout: 30_000 });
  const risks = dialog.getByTestId('terms-key-risks');
  await expect(risks.locator('li')).toHaveCount(6);
  await expect(risks).toContainText('You alone control your wallet.');
  await expect(risks).toContainText('This is not financial advice.');
  // Read before accepting: nothing is sent by showing it.
  expect(flags.sentTransactions).toBe(sent);
  await expect(dialog.getByRole('button', { name: 'Confirm in wallet' })).toBeVisible();
  await fitsWidth(page);
});

test('a borrower’s review states what happens to their collateral if things go wrong, linked to the risk page', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.4', collateralTliq: '2000', rateBps: 450, days: 30 });
  const borrower = accountFor('borrower').address;
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('2000')]);
  await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('borrower');
  const sent = flags.sentTransactions;
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  const row = page.getByRole('region', { name: 'Offers you can take' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-takeable', 'true', { timeout: 60_000 });
  await row.getByRole('button', { name: 'Take this offer' }).click();

  const line = page.locator(`.accept-offer[data-offer-id="${offerId}"]`).getByTestId('receipt-if-wrong');
  await expect(line).toContainText('If things go wrong:', { timeout: 60_000 });
  await expect(line).toContainText('Your collateral can be sold if its value falls too far against the loan or you repay late, and you may lose it.');
  await expect(line.getByRole('link', { name: 'All key risks' })).toHaveAttribute('href', '/risks');
  expect(flags.sentTransactions).toBe(sent);
  await fitsWidth(page);
});
