/**
 * Vault deposit (matrix ACC-22), through the protocol's public entry point
 * on the fixture chain. A wallet with no vault deposits WETH: the review
 * says the deposit creates the vault, approves exactly the amount, and the
 * finish card states what the protocol credited and what left the wallet;
 * the holdings then show it as counted and free. One NFT is deposited with an
 * approval for that token alone, and a quantity of a multi-token with the
 * collection approval granted for the deposit and taken back after it. With
 * Terms in force the deposit asks for them first, and a paused protocol
 * closes it and says what stays open. With protected mode on the receipt
 * states the account's delay before anything can leave again, and a Terms
 * version published while the review is open stops the deposit before any
 * wallet prompt and sends it back through the Terms gate. Runs on the desktop and the phone
 * project, with wallets that have no history; the chain is reverted after
 * each test, so they reach every test the same.
 */
import { erc20Abi, parseAbi, parseEther, keccak256, toHex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';
import { enableProtection } from '../lib/protection';

type Hex = `0x${string}`;
const ZERO = '0x0000000000000000000000000000000000000000';

const NFT_ABI = parseAbi(['function mint(address to, uint256 tokenId)', 'function ownerOf(uint256 tokenId) view returns (address)']);
const MULTI_ABI = parseAbi([
  'function mint(address to, uint256 id, uint256 amount)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string, n: number): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 5 : 0) + BigInt(n);
}

async function openDeposit(page: Page): Promise<void> {
  await page.goto('/vault');
  await connectWallet(page);
  await page.getByTestId('vault-deposit-open').click();
  await expect(page.getByTestId('vault-deposit-form')).toBeVisible({ timeout: 60_000 });
}

test('a wallet with no vault deposits WETH: the vault is created, exactly the amount approved, and the credit measured', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  expect(((await sc.read<Hex>('getUserVaultAddress', [me])) as string).toLowerCase()).toBe(ZERO);
  await sc.write('borrower', WETH, TOKEN_ABI, 'deposit', [], parseEther('0.05'));
  await sc.write('borrower', WETH, TOKEN_ABI, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('freshBorrower');
  await openDeposit(page);
  await page.getByTestId('vault-deposit-asset').selectOption(WETH);
  const amount = page.getByTestId('vault-deposit-amount');
  await expect(page.getByTestId('vault-deposit-form')).toContainText('Your wallet holds', { timeout: 30_000 });
  await amount.fill('9999');
  await amount.blur();
  await expect(page.getByTestId('vault-deposit-form')).toContainText('More than your wallet holds');
  await amount.fill('0.02');
  await fitsWidth(page);
  await page.getByTestId('vault-deposit-review').click();

  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Deposit into your vault', { timeout: 60_000 });
  await expect(receipt).toContainText('Your vault, created with this deposit');
  await expect(receipt).toContainText('Lets the protocol take exactly 0.02 WETH, for this deposit.');
  await expect(receipt).toContainText('refuses a token that does not arrive in full');
  await expect(receipt).toContainText('No token-safety screening runs on this network');
  await expect(receipt).toContainText('Taking it out later');
  await expect(receipt).toContainText('To your wallet, at once');
  await expect(receipt).toContainText('Wallet prompts: 2');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Counted in your vault: 0.02 WETH');
  await expect(finish).toContainText('Left your wallet for your vault: 0.02 WETH');
  await expect(finish).toContainText('Vault created at');
  expect(flags.sentTransactions).toBe(sent + 2);

  const vault = (await sc.read<Hex>('getUserVaultAddress', [me])) as Hex;
  expect(vault.toLowerCase()).not.toBe(ZERO);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBe(parseEther('0.02'));
  // The approval was used in full: nothing is left standing.
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [me, sc.diamond] })).toBe(0n);

  await finish.getByRole('button', { name: 'Close' }).click();
  const weth = `erc20:${WETH.toLowerCase()}:0`;
  await expect(page.getByTestId(`vault-counted-${weth}`)).toHaveText('0.02 WETH', { timeout: 60_000 });
  await expect(page.getByTestId(`vault-withdrawable-${weth}`)).toHaveText('0.02 WETH');
  await expect(page.getByTestId('vault-deposit-open')).toBeVisible();
  await fitsWidth(page);
});

test('one NFT is deposited with an approval for that token alone', async ({ launchWallet }, testInfo) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const nft = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).rentalNft;
  const me = sc.address('lender');
  const id = freshId(testInfo.project.name, 1);
  await sc.write('lender', nft, NFT_ABI, 'mint', [me, id]);

  const { page, flags } = await launchWallet('freshLender');
  await openDeposit(page);
  await page.getByTestId('vault-deposit-asset').selectOption(nft);
  await expect(page.getByTestId('vault-deposit-form').locator('[data-asset-standard="erc721"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('vault-deposit-amount')).toHaveCount(0);
  await page.getByTestId('vault-deposit-token-id').fill(id.toString());
  await page.getByTestId('vault-deposit-review').click();

  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`NFT #${id}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Lets the protocol move this one token, never the rest of the collection.');
  await expect(receipt).toContainText('Wallet prompts: 2');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Counted in your vault: NFT #${id}`);
  expect(flags.sentTransactions).toBe(sent + 2);
  const vault = (await sc.read<Hex>('getUserVaultAddress', [me])) as Hex;
  expect(((await sc.pub.readContract({ address: nft, abi: NFT_ABI, functionName: 'ownerOf', args: [id] })) as string).toLowerCase()).toBe(vault.toLowerCase());
});

test('a quantity of a multi-token is deposited; the collection approval is granted for it and taken back after', async ({ launchWallet }, testInfo) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const multi = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).multiToken;
  const me = sc.address('lender');
  const id = freshId(testInfo.project.name, 2);
  await sc.write('lender', multi, MULTI_ABI, 'mint', [me, id, 5n]);

  const { page, flags } = await launchWallet('freshLender');
  await openDeposit(page);
  await page.getByTestId('vault-deposit-asset').selectOption(multi);
  await expect(page.getByTestId('vault-deposit-form').locator('[data-asset-standard="erc1155"]')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('vault-deposit-token-id').fill(id.toString());
  await page.getByTestId('vault-deposit-amount').fill('3');
  await page.getByTestId('vault-deposit-review').click();

  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`3 of token #${id}`, { timeout: 60_000 });
  await expect(receipt).toContainText('for this deposit only');
  await expect(receipt).toContainText('taken back in one more wallet step afterwards');
  await expect(receipt).toContainText('Wallet prompts: 3');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Approval over your');
  expect(flags.sentTransactions).toBe(sent + 3);
  const vault = (await sc.read<Hex>('getUserVaultAddress', [me])) as Hex;
  expect(await sc.pub.readContract({ address: multi, abi: MULTI_ABI, functionName: 'balanceOf', args: [vault, id] })).toBe(3n);
  expect(await sc.pub.readContract({ address: multi, abi: MULTI_ABI, functionName: 'isApprovedForAll', args: [me, sc.diamond] })).toBe(false);
});

test('with Terms in force the deposit asks for them first; a paused protocol closes it and says what stays open', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  await sc.diamondWrite('admin', 'setCurrentTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  await page.getByTestId('vault-deposit-open').click();
  const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
  await expect(dialog).toContainText('Depositing into your vault needs the Terms of Service', { timeout: 30_000 });
  await fitsWidth(page);
  await dialog.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(dialog.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Continue: Depositing into your vault' }).click();
  await expect(page.getByTestId('vault-deposit-form')).toBeVisible();
  await page.getByTestId('vault-deposit-cancel').click();

  await sc.diamondWrite('admin', 'pause');
  const sent = flags.sentTransactions;
  await expect(page.getByTestId('vault-deposit-paused')).toContainText('The protocol is paused, and a deposit is closed until it resumes.', { timeout: 60_000 });
  await expect(page.getByTestId('vault-deposit-paused')).toContainText('Full and partial repayment and adding collateral stay open');
  await expect(page.getByTestId('vault-deposit-open')).toHaveCount(0);
  expect(flags.sentTransactions).toBe(sent);
  await fitsWidth(page);
});

test('protected mode is stated in the receipt, and Terms published during the review stop the deposit and reopen the gate', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], parseEther('0.05'));
  await enableProtection(sc, 'lender', 2 * 24 * 60 * 60);

  const { page, flags } = await launchWallet('freshLender');
  await openDeposit(page);
  await page.getByTestId('vault-deposit-asset').selectOption(WETH);
  await expect(page.getByTestId('vault-deposit-form')).toContainText('Your wallet holds', { timeout: 30_000 });
  await page.getByTestId('vault-deposit-amount').fill('0.01');
  await page.getByTestId('vault-deposit-review').click();

  const flow = page.getByTestId('vault-deposit-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('To your wallet after your 2 days delay', { timeout: 60_000 });
  await expect(receipt).toContainText('Protected mode is on for your account');
  await expect(receipt).not.toContainText('To your wallet, at once');
  await fitsWidth(page);

  await sc.diamondWrite('admin', 'setCurrentTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(page.getByTestId('vault-deposit-terms-due')).toContainText('A Terms version you have not accepted is now in force', { timeout: 60_000 });
  expect(flags.sentTransactions).toBe(sent);
  await page.getByTestId('vault-deposit-terms-accept').click();
  await expect(page.getByRole('dialog', { name: 'Terms of Service' })).toContainText('Depositing into your vault needs the Terms of Service', { timeout: 30_000 });
  await fitsWidth(page);
});
