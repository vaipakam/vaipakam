/**
 * Vault holdings and Create vault (matrix ACC-20, ACC-21, ACC-24), against
 * vaults funded through the protocol's public entry points on the fixture
 * chain. A wallet with no vault is told so and creates one: the review says
 * nothing moves, the finish card names the vault the transaction created, and
 * the page then shows its address. A wallet with a deposit, a token sent in by
 * a plain transfer and a loan's collateral sees the protocol's own figures:
 * what is counted, what is free to withdraw, what its positions hold, and the
 * uncounted part with the route to adopt it. Runs on the desktop and the
 * phone project; the chain is reverted after each test.
 */
import { erc20Abi, parseEther, type Address } from 'viem';
import { openLoan, WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';

// See 26-loan-claims: a revert leaves the head at the snapshot's timestamp,
// so a block is mined at once.
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

test('a wallet with no vault creates one, and the page then shows its address', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  expect(((await sc.read<Hex>('getUserVaultAddress', [me])) as string).toLowerCase()).toBe(ZERO);

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/vault');
  await connectWallet(page);
  const none = page.getByTestId('vault-none');
  await expect(none).toContainText('You have no vault yet', { timeout: 60_000 });
  await fitsWidth(page);
  await page.getByTestId('vault-create').click();

  const flow = page.getByTestId('vault-create-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Create your vault', { timeout: 60_000 });
  await expect(receipt).toContainText('Nothing. No token leaves your wallet and no approval is asked.');
  await expect(receipt).toContainText(me);
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Vault created at');
  expect(flags.sentTransactions).toBe(sent + 1);
  const vault = (await sc.read<Hex>('getUserVaultAddress', [me])) as string;
  expect(vault.toLowerCase()).not.toBe(ZERO);

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('vault-address-value')).toHaveText(new RegExp(vault, 'i'), { timeout: 60_000 });
  await expect(page.getByTestId('vault-none')).toHaveCount(0);
  await expect(page.getByTestId('vault-empty')).toBeVisible();
});

test('the holdings show the protocol’s figures: counted, free, held by a loan, and an uncounted transfer', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  // Wallets with no history, so every figure below is this test's alone.
  const sc = scenario({ lender: 'freshLender', borrower: 'freshBorrower' });
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });
  const lender = sc.address('lender');
  const borrower = sc.address('borrower');
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Address>).liquidToken;

  // The lender deposits 0.02 WETH, then sends 0.001 straight to the vault.
  const deposit = parseEther('0.02');
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], deposit + parseEther('0.001'));
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, deposit]);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, deposit]);
  const lenderVault = (await sc.read<Hex>('getUserVaultAddress', [lender])) as Address;
  await sc.write('lender', WETH, TOKEN_ABI, 'transfer', [lenderVault, parseEther('0.001')]);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [lenderVault] })).toBe(deposit + parseEther('0.001'));

  const { page, ctx } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  const weth = `erc20:${WETH.toLowerCase()}:0`;
  const row = page.locator(`[data-vault-row="${weth}"]`);
  await expect(page.getByTestId(`vault-counted-${weth}`)).toHaveText('0.02 WETH', { timeout: 60_000 });
  await expect(page.getByTestId(`vault-withdrawable-${weth}`)).toHaveText('0.02 WETH');
  await expect(page.getByTestId(`vault-held-${weth}`)).toHaveText('0 WETH');
  await expect(page.getByTestId(`vault-untracked-${weth}`)).toContainText('0.001 WETH reached your vault outside the protocol');
  await expect(page.getByTestId(`vault-untracked-${weth}`).getByRole('link', { name: 'Adopt or disown it' })).toHaveAttribute('href', /\/recover$/);
  await expect(row).toContainText('Found through deposited, a loan');
  await expect(page.getByTestId('vault-address-value')).toHaveText(new RegExp(lenderVault, 'i'));
  await fitsWidth(page);
  await ctx.close();

  // The borrower's collateral is all held by the loan, none of it free.
  const b = await launchWallet('freshBorrower');
  await b.page.goto('/vault');
  await connectWallet(b.page);
  const coll = `erc20:${tliq.toLowerCase()}:0`;
  const collRow = b.page.locator(`[data-vault-row="${coll}"]`);
  await expect(b.page.getByTestId(`vault-counted-${coll}`)).toContainText('1,500', { timeout: 60_000 });
  await expect(b.page.getByTestId(`vault-withdrawable-${coll}`)).toContainText(/^0 /);
  await expect(b.page.getByTestId(`vault-held-${coll}`)).toContainText('1,500');
  await expect(collRow).toContainText('All of it is held by your loans, offers, claims, reserves or queued payouts.');
  await expect(collRow).toContainText('Found through a loan');
  // The loan's WETH went to the borrower's wallet, so its vault row is empty
  // and hidden behind the switch, which counts it.
  const wethRow = b.page.locator(`[data-vault-row="${weth}"]`);
  await expect(wethRow).toHaveCount(0);
  await b.page.getByTestId('vault-toggle-hidden').click();
  await expect(wethRow).toBeVisible();
  await expect(b.page.getByTestId(`vault-counted-${weth}`)).toHaveText('0 WETH');
  expect(borrower).not.toBe(lender);
  await fitsWidth(b.page);
});
