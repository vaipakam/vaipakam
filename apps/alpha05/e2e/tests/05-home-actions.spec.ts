/**
 * Home's writes (matrix ACC-63 faucet, RW-07 fee-discount toggle, ACC-15
 * Terms gate) through the shared signing flow: receipt, re-check, wallet,
 * progress, MEASURED outcome. Runs on the desktop and the phone project; each
 * run puts the state it starts from in place itself (consent reset through
 * the protocol's public entry point, the Terms version installed inside a
 * chain snapshot and reverted after), so the second project never depends on
 * the first.
 */
import { erc20Abi, keccak256, toHex, type Hex } from 'viem';
import { scenario } from '../lib/chain';
import { anvilRpc } from '../lib/anvil';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';
import type { Page } from '@playwright/test';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the faucet mints a test token and a test NFT, measures each, and offers the next jobs', async ({ launchWallet }) => {
  const sc = scenario();
  const { page, flags } = await launchWallet('visitor');
  await page.goto('/');
  await connectWallet(page);
  const faucet = page.getByRole('region', { name: /Get test assets/ });
  await expect(faucet).toBeVisible({ timeout: 60_000 });
  await expect(faucet).toContainText('Test assets on Base Sepolia have no value.');
  // Priced and unpriced test tokens, and a rentable NFT.
  await expect(faucet.locator('[data-asset="liquidToken"]')).toContainText('with a test price');
  await expect(faucet.locator('[data-asset="illiquidToken"]')).toContainText('with no price');
  await expect(faucet.locator('[data-asset="rentalNft"]')).toContainText('rentable NFT');

  // An ERC-20: the receipt names the amount exactly and who mints it.
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const account = accountFor('visitor').address;
  const balance = () => sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
  const before = await balance();
  await faucet.locator('[data-asset="liquidToken"]').getByRole('button', { name: 'Get 1000' }).click();
  const receipt = faucet.locator('.receipt');
  await expect(receipt).toContainText('You receive');
  await expect(receipt).toContainText(/1000 \S+/);
  await expect(receipt).toContainText('not the protocol');
  await expect(receipt).toContainText('Wallet prompts: 1.');
  await fitsWidth(page);
  const sent = flags.sentTransactions;
  await faucet.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = faucet.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await expect(finish).toContainText('Done: every part of this action is confirmed on the chain.');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect((await balance()) - before).toBe(1000n * 10n ** 18n);
  // Next steps, and a wallet prompt to show the token.
  for (const to of ['/borrow', '/lend', '/rent', '/positions']) await expect(finish.locator(`a[href="${to}"]`)).toBeVisible();
  await finish.getByRole('button', { name: 'Show it in my wallet' }).click();
  await expect(finish).toContainText('Your wallet was asked to show it.');
  await finish.getByRole('button', { name: 'Close' }).click();

  // A test NFT: a fresh number, owned by the wallet after the mint.
  await faucet.locator('[data-asset="rentalNft"]').getByRole('button', { name: 'Get one' }).click();
  await expect(faucet.locator('.receipt')).toContainText(/NFT #\d+ of /);
  await faucet.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(faucet.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await faucet.getByRole('button', { name: 'Close' }).click();

  // A transaction outlives the page that sent it: leave Home right after
  // confirming, come back, and the flow is still there (not the list).
  await faucet.locator('[data-asset="liquidToken"]').getByRole('button', { name: 'Get 1000' }).click();
  await faucet.getByRole('button', { name: 'Confirm in wallet' }).click();
  await page.locator('nav a[href="/borrow"]:visible').first().click();
  await expect(page).toHaveURL(/\/borrow$/);
  await page.locator('nav a[href="/"]:visible').first().click();
  await expect(faucet.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await expect(faucet.locator('[data-asset="liquidToken"]')).toHaveCount(0);
  await faucet.getByRole('button', { name: 'Close' }).click();
  await expect(faucet.locator('[data-asset="liquidToken"]')).toBeVisible();
});

test('the fee discount turns on and off with a measured outcome; with no Terms in force nothing else is asked', async ({ launchWallet }) => {
  const sc = scenario();
  await sc.diamondWrite('lender', 'setVPFIDiscountConsent', [false]);
  const { page, flags } = await launchWallet('lender');
  await page.goto('/');
  await connectWallet(page);
  const section = page.getByRole('region', { name: 'Fee discount' });
  await expect(section).toHaveAttribute('data-consent', 'off', { timeout: 60_000 });
  await expect(section).toContainText('Fee discount on Base Sepolia: off.');

  const sent = flags.sentTransactions;
  await section.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const receipt = section.locator('.receipt');
  await expect(receipt).toContainText('Turn the fee discount on');
  await expect(receipt).toContainText('Fee discount on Base Sepolia: on');
  // The fixture configures no VPFI price source: the lender discount reduces
  // the fee itself and no VPFI moves.
  await expect(receipt).toContainText('no VPFI moves');
  await section.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(section.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read('getVPFIDiscountConsent', [accountFor('lender').address])).toBe(true);
  await section.getByRole('button', { name: 'Close' }).click();
  await expect(section).toHaveAttribute('data-consent', 'on', { timeout: 30_000 });

  await section.getByRole('button', { name: 'Turn off' }).click();
  await expect(section.locator('.receipt')).toContainText('Your fees lose the holding discount until you turn this back on.');
  await section.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(section.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  expect(await sc.read('getVPFIDiscountConsent', [accountFor('lender').address])).toBe(false);
});

test('with Terms in force, turning the discount on asks for them first; turning it off never does', async ({ launchWallet }) => {
  const sc = scenario();
  // A Terms version can only move up, so it is installed inside a snapshot
  // the test reverts: later specs and the other project start with none.
  const snapshot = await anvilRpc<string>('evm_snapshot');
  try {
    await sc.diamondWrite('borrower', 'setVPFIDiscountConsent', [false]);
    const hash = keccak256(toHex('alpha05 e2e Terms v1'));
    await sc.diamondWrite('admin', 'setCurrentTos', [1, hash]);
    const { page } = await launchWallet('borrower');
    await page.goto('/');
    await connectWallet(page);
    const section = page.getByRole('region', { name: 'Fee discount' });
    await expect(section).toHaveAttribute('data-consent', 'off', { timeout: 60_000 });

    await section.getByRole('button', { name: 'Turn on' }).click();
    const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Turning on the fee discount needs the Terms of Service in force on Base Sepolia accepted first.');
    await expect(dialog.getByRole('link', { name: 'Read the Terms (version 1)' })).toHaveAttribute('href', 'https://vaipakam.com/terms/v1');
    await expect(dialog.getByRole('link', { name: 'Privacy notice' })).toHaveAttribute('href', 'https://vaipakam.com/privacy');
    // The whole fingerprint, grouped.
    await expect(dialog.locator('.receipt')).toContainText(hash.slice(2, 10));
    await expect(dialog.locator('.receipt')).toContainText(hash.slice(-8));
    await fitsWidth(page);
    await dialog.getByRole('button', { name: 'Confirm in wallet' }).click();
    await expect(dialog.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
    expect(await sc.read('hasAcceptedCurrentTerms', [accountFor('borrower').address])).toBe(true);
    await dialog.getByRole('button', { name: 'Continue: Turning on the fee discount' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The consent review follows at once.
    await expect(section.locator('.receipt')).toContainText('Turn the fee discount on');
    await section.getByRole('button', { name: 'Confirm in wallet' }).click();
    await expect(section.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
    await section.getByRole('button', { name: 'Close' }).click();
    await expect(section).toHaveAttribute('data-consent', 'on', { timeout: 30_000 });

    // A newer version: turning OFF still asks nothing.
    await sc.diamondWrite('admin', 'setCurrentTos', [2, keccak256(toHex('alpha05 e2e Terms v2'))]);
    await page.reload();
    await expect(section).toHaveAttribute('data-consent', 'on', { timeout: 60_000 });
    await section.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await section.getByRole('button', { name: 'Confirm in wallet' }).click();
    await expect(section.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});

test('a paused protocol closes the toggle in both directions and names the pause', async ({ launchWallet }) => {
  const sc = scenario();
  await sc.diamondWrite('admin', 'pause');
  try {
    const { page, flags } = await launchWallet('lender');
    await page.goto('/');
    await connectWallet(page);
    const section = page.getByRole('region', { name: 'Fee discount' });
    await expect(section).toContainText('The protocol is paused, so this setting cannot be changed in either direction', { timeout: 60_000 });
    await expect(section).toContainText('Full and partial repayment and adding collateral stay open');
    await expect(section.getByRole('button', { name: /Turn (on|off)/ })).toHaveCount(0);
    expect(flags.sentTransactions).toBe(0);
  } finally {
    await sc.diamondWrite('admin', 'unpause');
  }
});
