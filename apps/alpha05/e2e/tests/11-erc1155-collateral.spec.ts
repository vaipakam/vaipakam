/**
 * Borrow: a request that locks a quantity of one ERC-1155 token as
 * collateral (matrix NFT-13, OFF-02, OFF-07). The collection's standard is
 * the contract's own answer; the form says live how many of the typed token
 * the wallet holds; the review names the quantity, the collection-wide
 * approval and that it is taken back; the wallet grants it, posts, and takes
 * it back (three prompts), and the outcome is measured from the
 * transaction's own logs. An approval the wallet had already granted is
 * left exactly as it was (one prompt). Runs on the desktop and the phone
 * project.
 */
import { parseAbi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const MULTI_ABI = parseAbi([
  'function mint(address to, uint256 id, uint256 amount)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
]);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string, n: number): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 5 : 0) + BigInt(n);
}

async function openForm(page: Page, multi: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  const pick = page.getByTestId('pick-collateral');
  await pick.locator('select').selectOption(multi);
  // The collection's standard is the contract's own answer (ERC-165).
  await expect(pick.locator('[data-asset-standard="erc1155"]')).toContainText('you lock a quantity of one token', { timeout: 30_000 });
  await expect(page.getByText('Post a request locking your NFT')).toBeVisible();
  await page.getByTestId('request-open').click();
  await expect(page.getByTestId('request-token-id')).toBeVisible();
  await expect(page.getByTestId('request-quantity')).toBeVisible();
  await expect(page.getByTestId('request-collateral')).toHaveCount(0);
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
}

interface StoredOffer {
  creator: Hex;
  offerType: number;
  amount: bigint;
  collateralAsset: Hex;
  collateralAssetType: number;
  collateralTokenId: bigint;
  collateralQuantity: bigint;
}

test('a borrower locks 3 of one multi-token: approval granted for the request, taken back after, and the quantity measured into the vault', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const multi = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).multiToken;
  const borrower = accountFor('borrower').address;
  const id = freshId(testInfo.project.name, 1);
  await sc.write('borrower', multi, MULTI_ABI, 'mint', [borrower, id, 5n]);

  const { page, flags } = await launchWallet('borrower');
  await openForm(page, multi);

  // The form says live how many of the typed token the wallet holds.
  const tokenId = page.getByTestId('request-token-id');
  const standing = page.getByTestId('request-token-standing');
  await tokenId.fill((id + 1000n).toString());
  await expect(standing).toContainText(`Your wallet holds none of token #${id + 1000n}`, { timeout: 30_000 });
  await tokenId.fill(id.toString());
  await expect(standing).toContainText('Your wallet holds 5 of this token');
  await expect(standing).toHaveAttribute('data-tone', 'ok');

  const quantity = page.getByTestId('request-quantity');
  await quantity.fill('0');
  await quantity.blur();
  await expect(page.getByText('Use a whole number of at least 1.')).toBeVisible();
  await page.getByTestId('request-quantity-max').click();
  await expect(quantity).toHaveValue('5');
  await quantity.fill('3');

  await page.getByTestId('request-amount').fill('0.1');
  await page.getByTestId('request-rate').fill('9');
  await fitsWidth(page);
  await page.getByTestId('request-review').click();

  // The review names the quantity, the collection-wide approval taken back
  // after, and the in-kind default, and counts three prompts.
  const receipt = page.locator('.post-request .receipt');
  await expect(receipt).toContainText('You lock in your vault now', { timeout: 60_000 });
  await expect(receipt).toContainText(`3 of token #${id} of vMULTI`);
  await expect(receipt).toContainText('for this request only; one more wallet step takes it back after posting');
  await expect(receipt).toContainText('on default the lender receives all of it');
  await expect(receipt).toContainText('Wallet prompts: 3.');
  await fitsWidth(page);

  const flow = page.locator('.post-request');
  await flow.getByTestId('request-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('posted and open for lenders');
  await expect(finish).toContainText(`3 of token #${id} of vMULTI locked in your vault`);
  await expect(finish).toContainText('Approval over your vMULTI tokens taken back');
  expect(flags.sentTransactions).toBe(sent + 3);
  await fitsWidth(page);

  // The chain agrees: the request names the token and its quantity, the
  // quantity is in the borrower's vault, and the approval is gone.
  const offerId = BigInt((await finish.textContent())!.match(/Request #(\d+)/)![1]!);
  const offer = await sc.read<StoredOffer>('getOffer', [offerId]);
  expect(offer.creator.toLowerCase()).toBe(borrower.toLowerCase());
  expect(offer.offerType).toBe(1);
  expect(offer.amount).toBe(parseEther('0.1'));
  expect(offer.collateralAsset.toLowerCase()).toBe(multi.toLowerCase());
  expect(offer.collateralAssetType).toBe(2);
  expect(offer.collateralTokenId).toBe(id);
  expect(offer.collateralQuantity).toBe(3n);
  const vault = await sc.read<Hex>('getUserVaultAddress', [borrower]);
  expect(await sc.pub.readContract({ address: multi, abi: MULTI_ABI, functionName: 'balanceOf', args: [vault, id] })).toBe(3n);
  expect(await sc.pub.readContract({ address: multi, abi: MULTI_ABI, functionName: 'balanceOf', args: [borrower, id] })).toBe(2n);
  expect(await sc.pub.readContract({ address: multi, abi: MULTI_ABI, functionName: 'isApprovedForAll', args: [borrower, sc.diamond] })).toBe(false);
});

test('an approval the wallet already granted is left as it was, and too few held is blocked before any prompt', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const multi = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).multiToken;
  const borrower = accountFor('borrower').address;
  const id = freshId(testInfo.project.name, 2);
  await sc.write('borrower', multi, MULTI_ABI, 'mint', [borrower, id, 2n]);
  await sc.write('borrower', multi, MULTI_ABI, 'setApprovalForAll', [sc.diamond, true]);

  const { page, flags } = await launchWallet('borrower');
  await openForm(page, multi);
  await page.getByTestId('request-token-id').fill(id.toString());
  await expect(page.getByTestId('request-token-standing')).toContainText('Your wallet holds 2 of this token', { timeout: 30_000 });
  await page.getByTestId('request-quantity').fill('4');
  await page.getByTestId('request-amount').fill('0.05');
  await page.getByTestId('request-rate').fill('4');
  await page.getByTestId('request-review').click();

  // Too few held: named, and nothing is offered to sign.
  const flow = page.locator('.post-request');
  await expect(flow).toContainText(`This wallet holds 2 of token #${id}, short of the 4 to lock.`, { timeout: 60_000 });
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);

  // Lowered to what it holds: one prompt, and the approval stays as set.
  await flow.getByTestId('request-edit').click();
  await expect(page.getByTestId('request-token-id')).toHaveValue(id.toString());
  await page.getByTestId('request-quantity').fill('2');
  await page.getByTestId('request-review').click();
  const receipt = page.locator('.post-request .receipt');
  await expect(receipt).toContainText('Your wallet already lets the protocol move your vMULTI tokens; left as you set it', { timeout: 60_000 });
  await expect(receipt).toContainText('Wallet prompts: 1.');
  await flow.getByTestId('request-consent').check();
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).not.toContainText('taken back');
  expect(flags.sentTransactions).toBe(1);
  expect(await sc.pub.readContract({ address: multi, abi: MULTI_ABI, functionName: 'isApprovedForAll', args: [borrower, sc.diamond] })).toBe(true);
});
