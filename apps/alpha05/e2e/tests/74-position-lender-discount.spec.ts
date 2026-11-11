/**
 * Position, the lender's fee discount on one loan (matrix LN-18, #3586),
 * from the protocol's own view (`lenderHoldDiscountView`, #3562): the
 * discount that applies is the lower of the lender's discount when they took
 * the position and their discount now. A loan opened while the lender held no
 * VPFI stays at none after the lender's tier rises, and the page says the
 * entry figure caps it; a loan opened at the higher tier applies it and says
 * a later fall would lower it. With the fee-discount setting off, the page
 * says no holding discount applies until it is on. Advanced states both
 * figures, how the deployment delivers the discount and whether a Full fee
 * tariff adds to it; Basic states the figure that applies. The borrower sees
 * no lender discount. Runs on the desktop and the phone project; the chain is
 * reverted after each test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import type { Locator, Page } from '@playwright/test';
import { openLoan } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

/** The value beside a fact's label (exact label match). */
const fact = (section: Locator, label: string) =>
  section
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('xpath=following-sibling::dd[1]');

async function fitsWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function open(page: Page, loanId: bigint): Promise<Locator> {
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await expect(page.getByTestId('position-status')).toHaveText('Active: the loan is running.', { timeout: 60_000 });
  const section = page.getByTestId('position-discount');
  await expect(fact(section, 'Holding discount on this loan')).toBeVisible({ timeout: 60_000 });
  return section;
}

test('the lender’s discount on a loan is the lower of its entry and now: capped on a loan opened before the holding, applied on one opened with it', async ({
  launchWallet,
}) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const lender = sc.address('lender');
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
  await sc.diamondWrite('lender', 'setVPFIDiscountConsent', [true]);

  // Loan A opens while the lender holds no VPFI: its entry is tier 0.
  const a = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.6', collateralTliq: '3000', rateBps: 500, days: 30 });
  const { page } = await launchWallet('lender', { advanced: true });
  let s = await open(page, a.loanId);
  await expect(fact(s, 'Holding discount on this loan')).toHaveText('None');
  await expect(fact(s, 'When you took this position')).toHaveText(/^Tier 0, 0% off, recorded .*UTC/);
  await expect(fact(s, 'Your discount now')).toHaveText('Tier 0, 0% off');
  await expect(fact(s, 'How it is given')).toHaveText('The fee on interest you earn is reduced at each settlement; no VPFI moves.');
  await expect(fact(s, 'Full fee tariff')).toHaveText('Not on this loan');
  await expect(page.getByTestId('position-discount-consent')).toHaveCount(0);
  await fitsWidth(page);

  // The lender then holds 200 VPFI for four days: tier 1 applies now.
  await sc.write('lender', token, TOKEN_ABI, 'mint', [lender, parseEther('200')]);
  await sc.write('lender', token, erc20Abi, 'approve', [sc.diamond, parseEther('200')]);
  await sc.diamondWrite('lender', 'depositVPFIToVault', [parseEther('200')]);
  await increaseTime(4 * 86_400);
  await mine();
  expect(await sc.read<readonly [number, number]>('getEffectiveDiscount', [lender])).toEqual([1, 1000]);
  expect(await sc.read<{ holdBps: number }>('lenderHoldDiscountView', [a.loanId, lender])).toMatchObject({ entryBps: 0, nowBps: 1000, holdBps: 0 });

  // Loan A stays at none: its entry figure caps it, and the page says so.
  s = await open(page, a.loanId);
  await expect(page.getByTestId('position-discount-notes')).toHaveAttribute('data-standing', 'capped', { timeout: 60_000 });
  await expect(fact(s, 'Holding discount on this loan')).toHaveText('None');
  await expect(fact(s, 'Your discount now')).toHaveText('Tier 1, 10% off');
  await expect(s).toContainText('Capped at the discount you held when you took this position: VPFI added since does not raise it on this loan.');

  // Loan B opens at tier 1: the lower of entry and now is tier 1's 10%.
  const b = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.6', collateralTliq: '3000', rateBps: 500, days: 30 });
  s = await open(page, b.loanId);
  await expect(page.getByTestId('position-discount-notes')).toHaveAttribute('data-standing', 'follows', { timeout: 60_000 });
  await expect(fact(s, 'Holding discount on this loan')).toHaveText("10% off the protocol's share of your interest");
  await expect(fact(s, 'When you took this position')).toHaveText(/^Tier 1, 10% off, recorded .*UTC/);
  await expect(s).toContainText('If your tier falls before a settlement, the lower figure applies at that settlement.');
  await fitsWidth(page);

  // The setting off: the page says no holding discount applies until it is on.
  await sc.diamondWrite('lender', 'setVPFIDiscountConsent', [false]);
  s = await open(page, b.loanId);
  const consent = page.getByTestId('position-discount-consent');
  await expect(consent).toHaveAttribute('data-consent', 'off', { timeout: 60_000 });
  await expect(consent).toContainText('Your fee-discount setting is off, so no holding discount applies at a settlement until you turn it on.');
  await expect(consent.getByRole('link', { name: 'Fee-discount setting' })).toHaveAttribute('href', '/rewards');

  // Basic states the figure that applies, not the figures it is taken from.
  const basic = await launchWallet('lender');
  s = await open(basic.page, b.loanId);
  await expect(fact(s, 'Holding discount on this loan')).toHaveText("10% off the protocol's share of your interest");
  await expect(fact(s, 'When you took this position')).toHaveCount(0);
  await fitsWidth(basic.page);

  // The borrower holds no lender side: no lender discount is shown.
  const borrower = await launchWallet('borrower');
  await borrower.page.goto(`/positions/${b.loanId}`);
  await connectWallet(borrower.page);
  await expect(borrower.page.getByTestId('position-role')).toHaveAttribute('data-role', 'borrower', { timeout: 60_000 });
  await expect(borrower.page.getByTestId('position-discount')).toHaveCount(0);
});
