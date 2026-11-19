/**
 * Lend: fast paths as the default (#3761, `DefaultPathsDesign.md` §3, matrix
 * row "Default paths"), open-ended unless the lender states a period (#3763,
 * §3.6; renewal shown as not available yet until it is built). The Lend page opens on Auto-lend, pre-selected; its
 * form carries each pre-selected choice as its own switch: re-lending
 * repayments through the platform's keeper, interest by time, and the
 * instant market's three consents. A choice the network cannot take is off
 * and greyed with the reason (here: no platform keeper is named for the
 * test chain, and the instant market's switch is off, its coded default).
 * The ways to lend that hold funds stay visible and off. "Make a one-time
 * offer instead" opens the offer form, and the device remembers that choice
 * on the next visit. The batch itself (terms, funding and the choices in one
 * transaction) is unit-tested in preset.test.ts and driven end to end in
 * 86-autolend.spec.ts. Runs on the desktop and the phone project.
 */
import { type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openPair(page: Page, tliq: Hex): Promise<void> {
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
}

test('the Lend form opens on Auto-lend with its choices pre-selected, each off where the network cannot take it', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);

  const { page } = await launchWallet('lender');
  await openPair(page, tliq);
  await expect(page.getByTestId('lend-choice')).toHaveAttribute('data-autolend', 'open', { timeout: 60_000 });
  await expect(page.getByTestId('lend-choice-keep')).toBeChecked();
  await page.getByTestId('lend-offer-open').click();

  const preset = page.getByTestId('autolend-preset');
  await expect(preset).toContainText('Pre-selected for you. Switch off any you do not want.');
  // No platform keeper is named for the test chain: re-lending is not offered, and says why.
  await expect(page.getByTestId('autolend-relend-hint')).toContainText('names no platform keeper', { timeout: 60_000 });
  await expect(page.getByTestId('autolend-relend')).toBeDisabled();
  await expect(page.getByTestId('autolend-relend')).not.toBeChecked();
  // Interest by time is pre-selected.
  await expect(page.getByTestId('autolend-prorata')).toBeChecked();
  // Renewal is not built yet: a line, not a switch (#3763).
  await expect(page.getByTestId('autolend-renewal')).toHaveCount(0);
  await expect(page.getByTestId('autolend-renewal-hint')).toContainText('Not available yet');
  // The instant market's switch is off on this network: each consent is off and says so.
  for (const k of ['fills', 'takeover']) {
    await expect(page.getByTestId(`autolend-${k}`)).toBeDisabled();
    await expect(page.getByTestId(`autolend-${k}`)).not.toBeChecked();
    await expect(page.getByTestId(`autolend-${k}-hint`)).toContainText('Not available on this network now');
  }
  // The ways to lend that hold funds stay visible and off.
  const more = page.getByTestId('autolend-more');
  await expect(more).toContainText('Bids in rate auctions');
  await expect(more).toContainText('Advances on loans');
  await expect(more).toContainText('Buying existing loans');
  for (const k of ['moreAuction', 'moreAdvance', 'moreBuy']) await expect(page.getByTestId(`autolend-${k}`)).toBeDisabled();
  // No end date unless the lender chooses a set period (#3763).
  await expect(page.getByTestId('autolend-setPeriod')).not.toBeChecked();
  await expect(page.getByTestId('autolend-lendUntil')).toHaveCount(0);
  await expect(page.getByTestId('autolend-setPeriod-hint')).toContainText('No end date');
  await fitsWidth(page);

  // The review states each choice as the batch carries it.
  await page.getByTestId('autolend-amount').fill('0.5');
  await page.getByTestId('autolend-rate').fill('5');
  await page.getByTestId('autolend-ltv').fill('50');
  await page.getByTestId('autolend-days').fill('30');
  await page.getByTestId('autolend-review').click();
  const receipt = page.getByTestId('autolend-setup').locator('.receipt');
  await expect(receipt).toContainText('Re-lend repayments for me', { timeout: 60_000 });
  await expect(receipt).toContainText('Not offered: this network names no platform keeper');
  await expect(receipt).toContainText('Fill instant borrows');
  await expect(receipt).toContainText('Off: not available on this network now');
  await expect(receipt).toContainText('comes back to you as a claim instead of being lent again');
  await expect(receipt).toContainText('Renew loans this slot made');
  await expect(receipt).toContainText('Not available yet: loans end on their due dates');
  // What open-ended means here, and that no date of return is promised.
  const sections = page.getByTestId('receipt-section');
  await expect(sections.nth(0)).toContainText('No end date');
  await expect(sections.nth(1)).toContainText('Getting funds back');
  await expect(sections.nth(1)).toContainText('no date of return is promised');
  await fitsWidth(page);
});

test('"Make a one-time offer instead" opens the offer form, and the next visit opens on it', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);

  const { page } = await launchWallet('lender');
  await openPair(page, tliq);
  await expect(page.getByTestId('lend-choice')).toHaveAttribute('data-autolend', 'open', { timeout: 60_000 });
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByTestId('autolend-form')).toBeVisible();
  await page.getByTestId('autolend-one-time').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your lending offer' })).toBeVisible();
  await expect(page.getByTestId('autolend-form')).toHaveCount(0);

  // The device remembers the choice for this wallet and network.
  await page.reload();
  await openPair(page, tliq);
  await expect(page.getByTestId('lend-choice-once')).toBeChecked({ timeout: 60_000 });
  await fitsWidth(page);
});
