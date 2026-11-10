/**
 * Vault withdraw (matrix ACC-23), through the protocol's public entry point
 * on the fixture chain. A wallet without protected mode withdraws part of
 * its free WETH: the form refuses more than the protocol's free figure, the
 * review says it goes to this wallet at once, and the finish card measures
 * what left the vault and reached the wallet. With protected mode on, the
 * review names the account's payout queue and its delay, and the finish
 * card states the queued payout. An NFT the deposit record names only by
 * its collection is withdrawn by its token id. Runs on the desktop and the
 * phone project, with wallets that have no history; the chain is reverted
 * after each test, so they reach every test the same.
 */
import { erc20Abi, parseAbi, parseEther } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';
import { enableProtection } from '../lib/protection';

type Hex = `0x${string}`;

const NFT_ABI = parseAbi([
  'function mint(address to, uint256 tokenId)',
  'function approve(address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const DELAY = 2 * 24 * 60 * 60;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string, n: number): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 5 : 0) + BigInt(n);
}

/** `role` holds `amount` WETH in its vault, deposited through the protocol. */
async function depositWeth(sc: ReturnType<typeof scenario>, role: 'lender' | 'borrower', amount: bigint): Promise<void> {
  await sc.write(role, WETH, TOKEN_ABI, 'deposit', [], amount);
  await sc.write(role, WETH, TOKEN_ABI, 'approve', [sc.diamond, amount]);
  await sc.diamondWrite(role, 'depositToVault', [0, WETH, 0n, amount]);
}

const WETH_KEY = `erc20:${WETH.toLowerCase()}:0`;

test('free WETH is withdrawn to this wallet at once: more than is free is refused, and what moved is measured', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  await depositWeth(sc, 'borrower', parseEther('0.03'));
  const vault = (await sc.read<Hex>('getUserVaultAddress', [me])) as Hex;
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] });

  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/vault');
  await connectWallet(page);
  await page.getByTestId(`vault-withdraw-open-${WETH_KEY}`).click({ timeout: 60_000 });
  const form = page.getByTestId('vault-withdraw-form');
  await expect(form).toContainText('Free to withdraw now: 0.03 WETH', { timeout: 30_000 });
  const amount = page.getByTestId('vault-withdraw-amount');
  await amount.fill('1');
  await amount.blur();
  await expect(form).toContainText('More than is free to withdraw');
  await amount.fill('0.01');
  await fitsWidth(page);
  await page.getByTestId('vault-withdraw-review').click();

  const flow = page.getByTestId('vault-withdraw-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Withdraw from your vault', { timeout: 60_000 });
  await expect(receipt).toContainText('This wallet, at once');
  await expect(receipt).toContainText('Only what is free moves');
  await expect(receipt).toContainText('The app withdraws only to the wallet that signs');
  await expect(receipt).toContainText('Wallet prompts: 1');
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

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId(`vault-counted-${WETH_KEY}`)).toHaveText('0.02 WETH', { timeout: 60_000 });
  await expect(page.getByTestId('vault-withdraw')).toHaveCount(0);
  await fitsWidth(page);
});

test('with protected mode on, the withdrawal is queued for the account’s delay and the finish card says so', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  await depositWeth(sc, 'lender', parseEther('0.03'));
  await enableProtection(sc, 'lender', DELAY);
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] });

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  await page.getByTestId(`vault-withdraw-open-${WETH_KEY}`).click({ timeout: 60_000 });
  await expect(page.getByTestId('vault-withdraw-form')).toContainText('Free to withdraw now', { timeout: 30_000 });
  await page.getByTestId('vault-withdraw-amount').fill('0.01');
  await page.getByTestId('vault-withdraw-review').click();

  const flow = page.getByTestId('vault-withdraw-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Your protected account’s payout queue for 2 days, then your wallet', { timeout: 60_000 });
  await expect(receipt).toContainText('cancel it from your payout queue on the Claims page');
  await expect(receipt).not.toContainText('This wallet, at once');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('0.01 WETH queued for your wallet, releasable from');
  await expect(finish).not.toContainText('Left your vault');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read<readonly bigint[]>('getPendingPayoutIds', [me])).toHaveLength(1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] })).toBe(before);
});

test('an NFT the deposit record names only by its collection is withdrawn by its token id', async ({ launchWallet }, testInfo) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const nft = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).rentalNft;
  const me = sc.address('lender');
  const id = freshId(testInfo.project.name, 1);
  await sc.write('lender', nft, NFT_ABI, 'mint', [me, id]);
  await sc.write('lender', nft, NFT_ABI, 'approve', [sc.diamond, id]);
  await sc.diamondWrite('lender', 'depositToVault', [1, nft, id, 1n]);

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/vault');
  await connectWallet(page);
  await page.getByTestId(`vault-withdraw-collection-${nft.toLowerCase()}`).click({ timeout: 60_000 });
  const form = page.getByTestId('vault-withdraw-form');
  await expect(form).toBeVisible();
  await page.getByTestId('vault-withdraw-token-id').fill(id.toString());
  await expect(form).toContainText('This NFT leaves your vault for your wallet.');
  await fitsWidth(page);
  await page.getByTestId('vault-withdraw-review').click();

  const flow = page.getByTestId('vault-withdraw-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`NFT #${id}`, { timeout: 60_000 });
  await expect(receipt).toContainText('This wallet, at once');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Reached your wallet: NFT #${id}`);
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(((await sc.pub.readContract({ address: nft, abi: NFT_ABI, functionName: 'ownerOf', args: [id] })) as string).toLowerCase()).toBe(me.toLowerCase());
});
