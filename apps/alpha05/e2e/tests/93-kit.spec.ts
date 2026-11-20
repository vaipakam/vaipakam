/**
 * The embedded lending kit (#3773, matrix row "Embedded lending kit"). A
 * link built with the kit's own builder opens /kit, which states what it
 * asks for, the network, and the integrator it names with the registry's
 * answer read from the chain. Continuing opens the platform's own page
 * filled in from the link: Lend on the link's asset, with a notice naming
 * the integrator and what naming it does there. The lender's own offer then
 * carries the integrator on chain (attribution only), and its review says
 * so; removing the integrator first leaves the offer naming none. A link the
 * parser refuses is refused with its reason. Runs on the desktop and the
 * phone project.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { kitLink } from '@vaipakam/lend-kit';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { CHAIN_ID, connectWallet, expect, test } from '../lib/wallet';

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;
const INTEGRATOR = '0x4444444444444444444444444444444444444444' as const;
const ZERO = '0x0000000000000000000000000000000000000000';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** The link's path and query, opened on the app under test. */
function kitPath(r: Parameters<typeof kitLink>[1]): string {
  const u = new URL(kitLink('http://localhost', r));
  return `${u.pathname}${u.search}`;
}

/** Post a 0.02 WETH lending offer from the open Lend page; returns its id. */
async function postOffer(page: Page, collateral: Hex): Promise<{ id: bigint; receipt: string }> {
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('lend-choice-once').check();
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
  await page.getByTestId('request-amount').fill('0.02');
  await page.getByTestId('request-collateral').fill('150');
  await page.getByTestId('request-rate').fill('6');
  await page.getByTestId('request-expiry').selectOption('1d');
  await page.getByRole('button', { name: 'Review offer' }).click();
  const flow = page.locator('.post-request');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Post your lending offer', { timeout: 60_000 });
  const text = (await receipt.textContent()) ?? '';
  await flow.getByTestId('request-consent').check();
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  return { id: BigInt((await finish.textContent())!.match(/Offer #(\d+)/)![1]!), receipt: text };
}

test('a lend link names a registered integrator, the offer carries it, and removing it leaves the next offer naming none', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.diamondWrite('admin', 'setIntegrator', [INTEGRATOR, INTEGRATOR, 0, 'Kit Test Wallet', []]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.1'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page } = await launchWallet('lender');
  await page.goto(kitPath({ action: 'lend', chainId: CHAIN_ID, asset: WETH, amount: parseEther('0.02'), integrator: INTEGRATOR }));
  await connectWallet(page);
  const kit = page.getByTestId('kit-page');
  await expect(kit).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('kit-what')).toContainText('lend 0.02');
  await expect(kit).toContainText('Nothing is signed on this page.');
  const named = page.getByTestId('kit-page-integrator');
  await expect(named).toContainText('Kit Test Wallet', { timeout: 60_000 });
  await expect(named).toContainText('active');
  await expect(named).toContainText('it is not an approval or a check of that app');
  await expect(named).toContainText('naming it only records which app brought you');
  await fitsWidth(page);
  await page.getByTestId('kit-continue').click();

  // Lend opens on the link's asset, and says where the visit came from.
  await expect(page).toHaveURL(/\/lend$/);
  const notice = page.getByTestId('kit-notice');
  await expect(notice).toHaveAttribute('data-state', 'here');
  await expect(notice).toContainText('lend 0.02');
  await expect(page.getByTestId('kit-integrator')).toContainText('Kit Test Wallet');
  await expect(page.getByTestId('kit-integrator')).toContainText('Auto-lend standing order set up here does not name it');
  await expect(page.getByTestId('pick-lending').locator('select')).toHaveValue(new RegExp(`^${WETH}$`, 'i'));
  await fitsWidth(page);

  const first = await postOffer(page, tliq);
  expect(first.receipt).toContain('names Kit Test Wallet');
  expect(first.receipt).toContain('a record only: it is paid nothing');
  const offer = await sc.read<{ integrator: Hex }>('getOffer', [first.id]);
  expect(offer.integrator.toLowerCase()).toBe(INTEGRATOR);

  // Removing it: the next offer names none, and its review says nothing of it.
  await page.locator('.post-request [data-phase="measured"]').getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('kit-drop').click();
  await expect(page.getByTestId('kit-dropped')).toContainText('nothing you sign here names it');
  const second = await postOffer(page, tliq);
  expect(second.receipt).not.toContain('Kit Test Wallet');
  expect((await sc.read<{ integrator: Hex }>('getOffer', [second.id])).integrator.toLowerCase()).toBe(ZERO);

  // Stopping the link takes the notice away.
  await page.locator('.post-request [data-phase="measured"]').getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('kit-close').click();
  await expect(page.getByTestId('kit-notice')).toHaveCount(0);
});

test('a borrow link opens Borrow on its collateral, and an unregistered integrator is stated as paid nothing', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const { page } = await launchWallet('lender');
  await page.goto(kitPath({ action: 'borrow', chainId: CHAIN_ID, asset: tliq, lendingAsset: WETH, integrator: INTEGRATOR }));
  await connectWallet(page);
  const named = page.getByTestId('kit-page-integrator');
  await expect(named).toContainText('not in the platform’s integrator registry', { timeout: 60_000 });
  await expect(named).toContainText('a share of the loan initiation fee');
  await page.getByTestId('kit-continue').click();
  await expect(page).toHaveURL(/\/borrow$/);
  await expect(page.getByTestId('kit-integrator')).toContainText('“Borrow now” names no app');
  await expect(page.getByTestId('pick-collateral').locator('select')).toHaveValue(new RegExp(`^${tliq}$`, 'i'));
  await expect(page.getByTestId('pick-lending').locator('select')).toHaveValue(new RegExp(`^${WETH}$`, 'i'));
  await fitsWidth(page);
});

test('a link the kit would refuse is refused with its reason, and nothing continues', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor');
  await page.goto(`/kit?v=1&action=rent&chain=${CHAIN_ID}&asset=${WETH}`);
  const kit = page.getByTestId('kit-page');
  await expect(kit).toHaveAttribute('data-state', 'refused');
  await expect(kit).toContainText('This link cannot be used: tokenId is required.');
  await expect(page.getByTestId('kit-continue')).toHaveCount(0);
});
