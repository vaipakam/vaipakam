/**
 * Borrow: "Borrow now" (#3761, `DefaultPathsDesign.md` §4, matrix row
 * "Borrow now"). The Borrow page opens on a form that borrows from the
 * lenders standing ready on the pair in one step. Its review is the
 * protocol's own `borrowInstant` asked from the borrower's wallet in this
 * block, labelled as what this block gives, with each loan at its own
 * source's rate, the approval for exactly the wallet's part naming the
 * contract it is given to, and the statement that every loan ends on its due
 * date (renewal is not built, #3763 §4.1). Where the lenders ready cover
 * none, the review says nothing is borrowed now and offers a request; where
 * they cover part, the borrower borrows that part and then posts a request
 * for exactly the rest. Runs on the desktop and the phone project.
 */
import { parseAbi, parseEther, type Hex } from 'viem';
import { WETH, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const MINT_ABI = parseAbi(['function mint(address to, uint256 amount)']);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openPair(page: Page, tliq: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
}

async function fillForm(page: Page, amount: string, collateral: string, rate: string): Promise<void> {
  const form = page.getByTestId('borrownow-form');
  await expect(form).toBeVisible({ timeout: 60_000 });
  await expect(form).toContainText('Every loan ends on its due date: it does not renew.');
  await expect(page.getByTestId('borrownow-rate')).toHaveValue('');
  await page.getByTestId('borrownow-amount').fill(amount);
  await page.getByTestId('borrownow-collateral').fill(collateral);
  await page.getByTestId('borrownow-rate').fill(rate);
  await page.getByTestId('borrownow-review').click();
}

test('with the instant market off, Borrow now says so and offers a request for all of it', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const { page } = await launchWallet('borrower');
  await openPair(page, tliq);
  await fitsWidth(page);
  await fillForm(page, '0.3', '1500', '8');

  const flow = page.getByTestId('borrownow-flow');
  await expect(flow).toContainText('switched off on this network', { timeout: 60_000 });
  await expect(flow.getByTestId('borrownow-consent')).toHaveCount(0);
  await fitsWidth(page);
  await flow.getByTestId('borrownow-request-all').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
  await expect(page.getByTestId('request-amount')).toHaveValue('0.3');
});

test('with lenders covering part, the review shows what this block gives, borrows it, and offers a request for exactly the rest', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('admin', 'setInstantMarketEnabled', [true]);
  const offerId = await postLenderOffer(sc, {
    lender: 'lender',
    principalWeth: '0.2',
    collateralTliq: '1000',
    rateBps: 400,
    days: 30,
    fullTermInterest: false,
    allowsPartialRepay: true,
  });

  // The borrower's collateral: tLIQ is the fixture's freely mintable faucet.
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [sc.address('borrower'), parseEther('1500')]);

  const { page } = await launchWallet('borrower');
  await openPair(page, tliq);
  await fillForm(page, '0.3', '1500', '8');

  const flow = page.getByTestId('borrownow-flow');
  const cover = flow.getByTestId('borrownow-cover');
  await expect(cover).toHaveAttribute('data-cover', 'part', { timeout: 90_000 });
  await expect(flow).toContainText('What this block gives');
  await expect(flow).toContainText(`from lender offer #${offerId}`);
  await expect(flow).toContainText('at 4% a year');
  await expect(flow).toContainText('It does not renew.');
  await expect(flow).toContainText(sc.diamond, { ignoreCase: true });
  await fitsWidth(page);

  await expect(flow).toContainText(/Wallet prompts: [12]/);
  const confirm = flow.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await flow.getByTestId('borrownow-consent').check();
  await confirm.click();
  await expect(flow.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  const rest = page.getByTestId('borrownow-rest');
  await expect(rest).toBeVisible();
  await expect(rest).toContainText('0.1');
  await rest.getByTestId('borrownow-rest-go').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
  await expect(page.getByTestId('request-amount')).toHaveValue('0.1');
});
