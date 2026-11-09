/**
 * Rewards (matrix RW-01, RW-02, RW-04, RW-05, RW-06, RW-07): one page for
 * the wallet's rewards and its VPFI. On the fixture, which sets no VPFI
 * token, the page shows the rewards and the fee-discount consent and says
 * VPFI is not set up, with no deposit or withdrawal offered. With a VPFI
 * token set (a mintable test token stands in for it), the page reads the
 * wallet's VPFI, says nothing can be withdrawn before a vault exists, and
 * deposits it: the receipt states that deposited VPFI counts toward the
 * fee-discount tier and that the wallet's consent is off; the outcome is
 * measured and the counted figure is read again. A withdrawal of all of it
 * says the holding time restarts and that the consent stays as it is, and
 * the chain agrees that nothing stays counted. Runs on the desktop and the
 * phone project; the chain is reverted after each test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('with no VPFI token set, the page shows rewards and the consent, and offers no VPFI deposit or withdrawal', async ({ launchWallet }) => {
  test.setTimeout(120_000);
  const sc = scenario();
  expect(await sc.read<Hex>('getVPFIToken'), 'the fixture starts with no VPFI token').toBe(ZERO);
  const { page } = await launchWallet('lender', { preAuthorized: false });
  await page.goto('/rewards');
  await expect(page.getByRole('heading', { level: 1, name: 'Rewards' })).toBeVisible();
  await expect(page.getByTestId('rewards-connect')).toBeVisible();
  await connectWallet(page);
  await expect(page.getByTestId('rewards-widget')).toBeVisible({ timeout: 60_000 });
  // The page itself is Rewards: the widget does not link to it.
  await expect(page.getByTestId('rewards-widget').getByRole('link', { name: 'More on Rewards' })).toHaveCount(0);
  const vpfi = page.getByTestId('rewards-vpfi');
  await expect(vpfi).toHaveAttribute('data-vpfi', 'unavailable', { timeout: 60_000 });
  await expect(vpfi).toContainText('VPFI is not set up on this network');
  await expect(page.getByTestId('rewards-vpfi-deposit')).toHaveCount(0);
  await expect(page.getByTestId('rewards-vpfi-withdraw')).toHaveCount(0);
  await expect(page.getByTestId('consent-toggle')).toBeVisible();
  await fitsWidth(page);
});

test('VPFI is deposited into the vault and counted for the tier, then all of it withdrawn, measured from the chain', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  // A mintable test token stands in for VPFI on the fixture chain.
  const token = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken!;
  await sc.diamondWrite('admin', 'setVPFIToken', [token]);
  await sc.write('borrower', token, TOKEN_ABI, 'mint', [me, parseEther('10')]);
  const symbol = await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' });

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/rewards');
  await connectWallet(page);
  const vpfi = page.getByTestId('rewards-vpfi');
  await expect(vpfi).toHaveAttribute('data-vpfi', 'available', { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-wallet')).toHaveText(`10 ${symbol}`, { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`0 ${symbol}`);
  await expect(vpfi).toContainText('You have no vault yet; your first deposit creates it.');
  await expect(vpfi).toContainText('VPFI in your vault is not collateral.');
  await expect(page.getByTestId('rewards-vpfi-withdraw-closed')).toContainText('you have no vault on this network yet');
  await expect(page.getByTestId('rewards-vpfi-withdraw')).toBeDisabled();
  await fitsWidth(page);

  // Deposit: the receipt states the tier's side.
  await page.getByTestId('rewards-vpfi-deposit').click();
  await expect(page.getByTestId('vault-deposit-asset')).toHaveCount(0);
  await page.getByTestId('vault-deposit-amount').fill('4');
  await page.getByTestId('vault-deposit-review').click();
  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Deposited VPFI counts toward your fee-discount tier', { timeout: 60_000 });
  await expect(receipt).toContainText('Your fee-discount consent is off');
  await expect(receipt).toContainText('Your vault, created with this deposit');
  await fitsWidth(page);
  let sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  let finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Counted in your vault: 4 ${symbol}`);
  expect(flags.sentTransactions).toBe(sent + 2);
  expect(await sc.read<bigint>('getTrackedVPFIBalance', [me])).toBe(parseEther('4'));
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`4 ${symbol}`, { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-free')).toHaveText(`4 ${symbol}`);

  // Withdraw all of it: the holding time restarts, the consent stays.
  await page.getByTestId('rewards-vpfi-withdraw').click();
  await page.getByTestId('vault-withdraw-amount').fill('4');
  await page.getByTestId('vault-withdraw-review').click();
  const out = page.getByTestId('vault-withdraw-panel');
  const outReceipt = out.locator('.receipt');
  await expect(outReceipt).toContainText('This takes your counted VPFI to zero', { timeout: 60_000 });
  await expect(outReceipt).toContainText('Your fee-discount consent stays as it is.');
  await expect(outReceipt).toContainText('This wallet, at once');
  await fitsWidth(page);
  sent = flags.sentTransactions;
  await out.getByRole('button', { name: 'Confirm in wallet' }).click();
  finish = out.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Reached your wallet: 4 ${symbol}`);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read<bigint>('getTrackedVPFIBalance', [me])).toBe(0n);
  expect(await sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [me] })).toBe(parseEther('10'));
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('rewards-vpfi-counted')).toHaveText(`0 ${symbol}`, { timeout: 60_000 });
  await expect(page.getByTestId('rewards-vpfi-withdraw-closed')).toContainText('no VPFI is counted in your vault');
  await fitsWidth(page);
});
