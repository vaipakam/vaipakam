/**
 * Borrow: a request that locks one ERC-721 token as collateral (matrix
 * NFT-13, OFF-02, OFF-07). The collection's standard is the contract's own
 * answer; the token is named by its id and the form says live who holds it;
 * the review names the token, the one-token approval and the in-kind
 * default; the wallet approves that token only; and the outcome is measured
 * from the transaction's own logs. Runs on the desktop and the phone project.
 */
import { parseAbi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const NFT_ABI = parseAbi([
  'function mint(address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
]);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string, n: number): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 5 : 0) + BigInt(n);
}

async function openForm(page: Page, nft: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  const pick = page.getByTestId('pick-collateral');
  await pick.locator('select').selectOption(nft);
  // The collection's standard is the contract's own answer (ERC-165).
  await expect(pick.locator('[data-asset-standard="erc721"]')).toContainText('you lock one NFT, named by its number', { timeout: 30_000 });
  await expect(page.getByText('Post a request locking your NFT')).toBeVisible();
  await page.getByTestId('request-open').click();
  await expect(page.getByTestId('request-token-id')).toBeVisible();
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
}

test('a borrower posts a request locking one NFT: the token named, approved alone, and measured into the vault', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const nft = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).rentalNft;
  const borrower = accountFor('borrower').address;
  const visitor = accountFor('visitor').address;
  const mine = freshId(testInfo.project.name, 1);
  const theirs = freshId(testInfo.project.name, 2);
  await sc.write('borrower', nft, NFT_ABI, 'mint', [borrower, mine]);
  await sc.write('borrower', nft, NFT_ABI, 'mint', [visitor, theirs]);

  const { page, flags } = await launchWallet('borrower');
  await openForm(page, nft);

  // The form says live who holds the typed token.
  const id = page.getByTestId('request-token-id');
  const standing = page.getByTestId('request-token-standing');
  await id.fill('7.5');
  await id.blur();
  await expect(page.getByText('Use whole digits only, as the number appears on the NFT.')).toBeVisible();
  await id.fill((mine + 1000n).toString());
  await expect(standing).toContainText('exists in this collection', { timeout: 30_000 });
  await id.fill(theirs.toString());
  await expect(standing).toContainText('Another wallet holds this NFT');
  await id.fill(mine.toString());
  await expect(standing).toContainText('Your wallet holds this NFT');
  await expect(standing).toHaveAttribute('data-tone', 'ok');

  await page.getByTestId('request-amount').fill('0.1');
  await page.getByTestId('request-rate').fill('9');
  await fitsWidth(page);
  await page.getByTestId('request-review').click();

  // The review names the token, the one-token approval and the in-kind
  // default, and counts two prompts (approve the token, post).
  const receipt = page.locator('.post-request .receipt');
  await expect(receipt).toContainText('You lock in your vault now', { timeout: 60_000 });
  await expect(receipt).toContainText(`NFT #${mine} of vRENT`);
  await expect(receipt).toContainText('only, never the rest of the collection');
  await expect(receipt).toContainText('None: an illiquid leg is valued at zero');
  await expect(receipt).toContainText('on default the lender receives all of it');
  await expect(receipt).toContainText('Wallet prompts: 2.');
  await fitsWidth(page);

  const flow = page.locator('.post-request');
  await flow.getByTestId('request-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('posted and open for lenders');
  await expect(finish).toContainText(`NFT #${mine} of vRENT locked in your vault`);
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: the request names the token, the token is in the
  // borrower's vault, and the move cleared the one-token approval.
  const offerId = BigInt((await finish.textContent())!.match(/Request #(\d+)/)![1]!);
  const offer = await sc.read<StoredOffer>('getOffer', [offerId]);
  expect(offer.creator.toLowerCase()).toBe(borrower.toLowerCase());
  expect(offer.offerType).toBe(1);
  expect(offer.amount).toBe(parseEther('0.1'));
  expect(offer.collateralAsset.toLowerCase()).toBe(nft.toLowerCase());
  expect(offer.collateralAssetType).toBe(1);
  expect(offer.collateralTokenId).toBe(mine);
  const vault = await sc.read<Hex>('getUserVaultAddress', [borrower]);
  expect((await sc.pub.readContract({ address: nft, abi: NFT_ABI, functionName: 'ownerOf', args: [mine] })).toLowerCase()).toBe(vault.toLowerCase());
  expect(await sc.pub.readContract({ address: nft, abi: NFT_ABI, functionName: 'getApproved', args: [mine] })).toBe('0x0000000000000000000000000000000000000000');
});

test('a token another wallet holds is blocked in the review, and nothing is offered to sign', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const nft = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).rentalNft;
  const borrower = accountFor('borrower').address;
  const held = freshId(testInfo.project.name, 3);
  await sc.write('borrower', nft, NFT_ABI, 'mint', [borrower, held]);

  const { page, flags } = await launchWallet('visitor');
  await openForm(page, nft);
  await page.getByTestId('request-token-id').fill(held.toString());
  await expect(page.getByTestId('request-token-standing')).toContainText('Another wallet holds this NFT', { timeout: 30_000 });
  await page.getByTestId('request-amount').fill('0.05');
  await page.getByTestId('request-rate').fill('4');
  await page.getByTestId('request-review').click();

  const flow = page.locator('.post-request');
  await expect(flow).toContainText(`NFT #${held} is held by another wallet`, { timeout: 60_000 });
  await expect(flow.getByTestId('request-consent')).toHaveCount(0);
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);

  // Changing the request keeps the typed token.
  await flow.getByTestId('request-edit').click();
  await expect(page.getByTestId('request-token-id')).toHaveValue(held.toString());
});
