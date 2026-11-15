/**
 * Analytics (RW-74, RW-75, RW-60; RB-ANALYTICS): a public page, reached from the
 * Advanced navigation or by direct link, with no wallet. Every figure is
 * read from the fixture chain at one block. Before any loan the rates say
 * there are none yet, never 0%; once a loan opens through the protocol's
 * public entry points the counters, the average rate and the asset list
 * follow it, and every figure matches what the protocol itself reports at
 * the page's block. How each state is worded is held by the page's unit
 * test; the one-block read by `figures.test.ts`.
 */
import { openLoan } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { expect, test } from '../lib/wallet';
import { formatFigureText } from '../../src/shared/ui/format';

async function noOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('with no loan yet the page reads the chain at one block and says there is no rate yet', async ({ launchWallet }) => {
  const sc = scenario();
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/analytics');
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
  await expect(page.getByTestId('analytics-read-at')).toHaveText(/^Read at block \d+, .+ UTC, .+ ago\.$/, { timeout: 60_000 });
  await expect(page.getByTestId('analytics-since')).toContainText('Counted since this deployment began at block');
  await expect(page.getByText('Nothing on this page comes from the app’s indexer database.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View on the explorer' }).first()).toHaveAttribute('href', new RegExp(`/address/${sc.diamond}$`, 'i'));
  await expect(page.getByTestId('analytics-network')).toHaveValue(/^\d+$/);

  await expect(page.getByTestId('analytics-loans-opened')).toHaveText('0');
  await expect(page.getByTestId('analytics-average-rate')).toHaveText('None yet: no loan has opened');
  // No default rate is shown: the protocol's counter also counts ordinary
  // settlement, and the page says so instead.
  await expect(page.getByTestId('analytics-default-rate')).toHaveCount(0);
  await expect(page.getByTestId('analytics-no-default-rate')).toContainText('cannot tell a default from a normal close');
  await expect(page.getByTestId('analytics-utilization')).toHaveText('None: no priced collateral on open loans');
  await expect(page.getByTestId('analytics-no-assets')).toBeVisible();

  // The fee rates are the protocol's own settings, read live.
  const share = await sc.read<bigint>('getTreasuryFeeBps');
  await expect(page.getByTestId('analytics-treasury-share')).toHaveText(`${Number(share) / 100}%`);
  // The treasury current vault code pays is stated, and what the protocol
  // contract holds is shown whichever it is.
  await expect(page.getByTestId('analytics-custody')).toHaveText(/Current vault code sends fees to|No treasury is set/);
  await expect(page.getByTestId('analytics-held')).toBeVisible();

  // RW-60: the fixture sets no VPFI token, and the page says so rather than
  // showing a supply of zero. The home and bridged facts are held by the
  // page's unit test and checked live against the testnets' real tokens.
  expect(await sc.read<string>('getVPFIToken')).toBe('0x0000000000000000000000000000000000000000');
  await expect(page.getByTestId('analytics-vpfi-none')).toHaveText('No VPFI token is set on Base Sepolia.');
  await expect(page.getByTestId('analytics-vpfi-supply')).toHaveCount(0);
  const allocation = page.getByTestId('analytics-vpfi-allocation');
  await expect(allocation).toContainText('24% · 55,200,000 VPFI · undecided');
  await expect(allocation).toContainText('100% · 230,000,000 VPFI');
  await expect(allocation).not.toContainText(/insurance/i);
  await noOverflow(page);
});

test('an opened loan moves the counters, and each figure matches the protocol at the page’s block', async ({ launchWallet }) => {
  const sc = scenario();
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 500, days: 30 });
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/analytics');
  await expect(page.getByTestId('analytics-read-at')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('analytics-loans-opened')).toHaveText('1');
  await expect(page.getByTestId('analytics-open-loans')).toHaveText('1');
  await expect(page.getByTestId('analytics-average-rate')).toHaveText('5%');
  await expect(page.getByTestId('analytics-default-rate')).toHaveCount(0);

  // The page's lifetime figure is the protocol's own (nothing has moved
  // since the loan opened, so the head the spec reads is the page's block).
  const stats = await sc.read<readonly bigint[]>('getProtocolStats');
  const lent = formatFigureText(stats[4]!, 18).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  await expect(page.getByTestId('analytics-lifetime-lent')).toHaveText(new RegExp(`^${lent} `));

  const assets = page.getByTestId('analytics-asset');
  await expect(assets).toHaveCount(1);
  await expect(assets.first().getByRole('heading', { level: 3 })).toHaveText('WETH');
  await expect(assets.first()).toContainText('0.3 WETH');
  await noOverflow(page);
});
