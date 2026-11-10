/**
 * The pause's escape route on the Vault page (matrix ACC-30, ACC-31), on the
 * fixture chain. Under an administrative pause the page says withdrawals are
 * closed and when the escape route opens, read from the protocol, and a
 * withdrawal's review is stopped by the pause. Once the pause has run its
 * escape period, the page says the route is open, and a wallet without
 * protected mode withdraws through it: the review says the asset goes
 * straight to this wallet through the escape route, and the finish card
 * measures what left the vault and reached the wallet. Runs on the desktop
 * and the phone project, with a wallet that has no history; the chain is
 * reverted after each test, which also lifts the pause.
 */
import { erc20Abi, parseEther } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const WETH_KEY = `erc20:${WETH.toLowerCase()}:0`;

test('under a pause withdrawals are closed until the escape route opens, then a withdrawal goes through it to this wallet', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const amount = parseEther('0.03');
  await sc.write('borrower', WETH, TOKEN_ABI, 'deposit', [], amount);
  await sc.write('borrower', WETH, TOKEN_ABI, 'approve', [sc.diamond, amount]);
  await sc.diamondWrite('borrower', 'depositToVault', [0, WETH, 0n, amount]);
  const vault = (await sc.read<Hex>('getUserVaultAddress', [me])) as Hex;
  await sc.diamondWrite('admin', 'pause');
  const opensAt = await sc.read<bigint>('escapeOpensAt');
  expect(opensAt > 0n).toBe(true);
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] });

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/vault');
  await connectWallet(page);
  const notice = page.getByTestId('vault-escape');
  await expect(notice).toHaveAttribute('data-state', 'opensAt', { timeout: 60_000 });
  await expect(notice).toContainText('withdrawals are closed. Its escape route opens at');
  await fitsWidth(page);

  await page.getByTestId(`vault-withdraw-open-${WETH_KEY}`).click({ timeout: 60_000 });
  await page.getByTestId('vault-withdraw-amount').fill('0.01');
  await page.getByTestId('vault-withdraw-review').click();
  const flow = page.getByTestId('vault-withdraw-panel');
  await expect(flow).toContainText('The protocol is paused, and a withdrawal is closed until it resumes', { timeout: 60_000 });
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await page
    .getByTestId('vault-withdraw-change')
    .click()
    .catch(() => undefined);
  await page
    .getByTestId('vault-withdraw-cancel')
    .click({ timeout: 10_000 })
    .catch(() => undefined);

  const block = await sc.pub.getBlock();
  await anvilRpc('evm_increaseTime', [Number(opensAt - block.timestamp) + 60]);
  await anvilRpc('evm_mine');
  await expect(notice).toHaveAttribute('data-state', 'openPlain', { timeout: 60_000 });
  await expect(notice).toContainText('its escape route is open');

  if (!(await page.getByTestId('vault-withdraw-form').isVisible())) await page.getByTestId(`vault-withdraw-open-${WETH_KEY}`).click({ timeout: 60_000 });
  await page.getByTestId('vault-withdraw-amount').fill('0.01');
  await page.getByTestId('vault-withdraw-review').click();
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('This wallet, at once, through the escape route', { timeout: 60_000 });
  await expect(receipt).toContainText('its escape route is open: this withdrawal goes through it');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Left your vault: 0.01 WETH');
  await expect(finish).toContainText('Reached your wallet: 0.01 WETH');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBe(parseEther('0.02'));
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] })).toBe(before + parseEther('0.01'));
});
