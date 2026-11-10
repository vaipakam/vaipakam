/**
 * RB-CLICKS — the numeraire equivalent beside a typed amount (#3225): the
 * borrow request form states each amount's value as the protocol itself
 * values it now (the same rule as loan-to-value: a debt leg rounded up,
 * collateral rounded down), says "no price" for an asset the protocol values
 * at nothing, and the take-an-offer review states the principal's and the
 * collateral's value. Every expected figure is read from the chain, never
 * assumed. Runs on the desktop and the phone project; the suite reverts the
 * chain after every test, so no offer a test posts outlives it.
 */
import { parseAbi, parseEther, type Hex } from 'viem';
import { WETH, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const VALUE_ABI = parseAbi(['function getNumeraireValue(address asset, uint256 amount, bool roundUp) view returns (uint256)']);
const MINT_ABI = parseAbi(['function mint(address to, uint256 amount)']);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A 1e18 figure cut to cents with digit groups, as the app writes it. */
function cents(value: bigint): string {
  const unit = 10n ** 18n;
  const whole = (value / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${((value % unit) / 10n ** 16n).toString().padStart(2, '0')}`;
}

async function valueOf(asset: Hex, amount: bigint, debt: boolean): Promise<string> {
  const sc = scenario();
  return cents(await sc.pub.readContract({ address: sc.diamond, abi: VALUE_ABI, functionName: 'getNumeraireValue', args: [asset, amount, debt] }));
}

async function openRequest(page: Page, collateral: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('request-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
}

test('the request form states each typed amount’s value as the protocol values it now, and no price for an unpriced asset', async ({ launchWallet }) => {
  const sc = scenario();
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  const { page } = await launchWallet('borrower');
  await openRequest(page, mocks.liquidToken!);
  // Nothing is shown until an amount is typed.
  await expect(page.getByTestId('request-amount-value')).toHaveCount(0);

  await page.getByTestId('request-amount').fill('0.25');
  const principal = page.getByTestId('request-amount-value');
  await expect(principal).toHaveAttribute('data-equivalent', 'value', { timeout: 60_000 });
  await expect(principal).toContainText(`About ${await valueOf(WETH, parseEther('0.25'), true)}`);
  await expect(principal).toContainText('at the protocol’s price now');

  await page.getByTestId('request-collateral').fill('2000');
  const collateral = page.getByTestId('request-collateral-value');
  await expect(collateral).toHaveAttribute('data-equivalent', 'value', { timeout: 60_000 });
  await expect(collateral).toContainText(`About ${await valueOf(mocks.liquidToken!, parseEther('2000'), false)}`);

  // A changed amount is valued again once typing pauses.
  await page.getByTestId('request-amount').fill('0.5');
  await expect(principal).toContainText(`About ${await valueOf(WETH, parseEther('0.5'), true)}`, { timeout: 60_000 });
  await fitsWidth(page);

  // An asset the protocol gives no price is valued at nothing, and the
  // line says so instead of a figure.
  await page.goto('/');
  await openRequest(page, mocks.illiquidToken!);
  await page.getByTestId('request-collateral').fill('100');
  const unpriced = page.getByTestId('request-collateral-value');
  await expect(unpriced).toHaveAttribute('data-equivalent', 'unpriced', { timeout: 60_000 });
  await expect(unpriced).toContainText('No price: the protocol values');
  await expect(unpriced).toContainText('at nothing');
  await fitsWidth(page);
});

test('the take-an-offer review states the principal’s and the collateral’s value now, read from the protocol', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken!;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.4', collateralTliq: '2000', rateBps: 450, days: 30 });
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [accountFor('borrower').address, parseEther('2000')]);

  const { page } = await launchWallet('borrower');
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  const row = page.getByRole('region', { name: 'Offers you can take' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-takeable', 'true', { timeout: 60_000 });
  await row.getByRole('button', { name: 'Take this offer' }).click();

  const receipt = page.locator(`.accept-offer[data-offer-id="${offerId}"] .receipt`);
  await expect(receipt).toContainText('Principal’s value now', { timeout: 60_000 });
  await expect(receipt).toContainText(`About ${await valueOf(WETH, parseEther('0.4'), true)}`);
  await expect(receipt).toContainText('Collateral’s value now');
  await expect(receipt).toContainText(`About ${await valueOf(tliq, parseEther('2000'), false)}`);
  await fitsWidth(page);
});
