/**
 * List an NFT for rent (matrix NFT-01). An owner opens the listing form on
 * Rent, names a token this wallet does not hold and is told so in the review
 * before any wallet step; with a token it holds, the review states that the
 * NFT moves into the owner's own vault, the daily fee, term and rent rule,
 * what a renter pays up front with the buffer this listing fixes now, what
 * the owner receives and what a default does. The listing is approved for
 * that one token and posted, and the outcome is measured: the listing
 * recorded and the NFT in the owner's vault. The chain agrees, and the
 * listing's own page reads it as an NFT for rent. Runs on the desktop and
 * the phone project; the chain is reverted after each test.
 */
import { formatEther, parseAbi, parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const NFT_ABI = parseAbi(['function mint(address to, uint256 tokenId)', 'function ownerOf(uint256 tokenId) view returns (address)']);

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 8 : 4);
}

test('an owner lists an NFT for rent: a token not held is refused in the review, a held one is posted and measured from the chain', async ({ launchWallet }, testInfo) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  const nft = mocks.rentalNft!;
  const pay = mocks.liquidToken!;
  const owner = accountFor('lender').address;

  const { page, flags } = await launchWallet('lender', { preAuthorized: false });
  await page.goto('/rent');
  await expect(page.getByRole('heading', { level: 1, name: 'Rent an NFT' })).toBeVisible();
  await expect(page.getByTestId('rent-connect')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  const open = page.getByTestId('rent-list-open');
  await expect(open).toBeEnabled({ timeout: 60_000 });
  await open.click();

  // The form: no collateral or rate fields, one daily fee.
  const form = page.getByTestId('rent-list-form');
  await expect(form).toBeVisible();
  await expect(form).toContainText('a rental fee is never a range');
  const tokenId = freshId(testInfo.project.name);
  // Choosing "another" opens an empty paste box that stays open, for the
  // collection and the payment token alike; choosing a suggestion closes it.
  for (const [select, box] of [['rent-list-nft', 'rent-list-nft-address'], ['rent-list-pay', 'rent-list-pay-address']] as const) {
    await form.getByTestId(select).selectOption('other');
    await expect(form.getByTestId(select)).toHaveValue('other');
    await expect(form.getByTestId(box)).toHaveValue('');
  }
  await form.getByTestId('rent-list-nft').selectOption(nft);
  await expect(form.getByTestId('rent-list-nft-address')).toHaveCount(0);
  await form.getByTestId('rent-list-token-id').fill(tokenId.toString());
  await form.getByTestId('rent-list-pay').selectOption(pay);
  await form.getByTestId('rent-list-fee').fill('2');
  await form.getByTestId('rent-list-days').fill('5');
  await fitsWidth(page);
  await form.getByTestId('rent-list-continue').click();

  // A token this wallet does not hold yet: said in the review, no wallet step.
  const flow = page.getByTestId('rent-list-flow');
  await expect(flow).toContainText(`No NFT #${tokenId} exists in this collection`, { timeout: 60_000 });
  await expect(flow.getByTestId('rent-list-consent')).toHaveCount(0);

  // Once the wallet holds it, the review re-reads by itself.
  await sc.write('lender', nft, NFT_ABI, 'mint', [owner, tokenId]);
  await expect(flow.getByTestId('rent-list-consent')).toBeVisible({ timeout: 60_000 });
  const receipt = flow.locator('.receipt');
  const [, bufferBps] = await sc.read<readonly [bigint, bigint]>('getRiskConfig', []);
  const rent = parseEther('2') * 5n;
  const buffer = (rent * bufferBps) / 10_000n;
  const fmt = (v: bigint) => formatEther(v).replace(/\.0$/, '');
  await expect(receipt).toContainText('Moved from your wallet into your own vault');
  await expect(receipt).toContainText(`NFT #${tokenId} of vRENT`);
  await expect(receipt).toContainText('5 days of use once a renter starts it');
  await expect(receipt).toContainText('Pro-rata: the renter pays for the days used');
  await expect(receipt).toContainText(fmt(rent + buffer));
  await expect(receipt).toContainText('kept as set when the listing lands');
  await expect(receipt).toContainText('less the protocol’s share');
  await expect(receipt).toContainText('the buffer goes to the protocol');
  await expect(receipt).toContainText('None: a rental has no collateral and no health factor');
  await expect(receipt).toContainText('You cannot withdraw it until the listing or the rental ends');
  await expect(receipt).toContainText('Wallet prompts: 2.');
  await fitsWidth(page);

  await flow.getByTestId('rent-list-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(/Listing #\d+ posted/);
  await expect(finish).toContainText(`NFT #${tokenId} of vRENT moved into your own vault`);
  // The one-token approval and the listing.
  expect(flags.sentTransactions).toBe(sent + 2);
  await fitsWidth(page);

  // The chain agrees: the owner's vault holds the NFT, and the listing names it.
  const vault = await sc.read<Hex>('getUserVaultAddress', [owner]);
  const holder = await sc.pub.readContract({ address: nft, abi: NFT_ABI, functionName: 'ownerOf', args: [tokenId] });
  expect(holder.toLowerCase()).toBe(vault.toLowerCase());
  const link = finish.getByRole('link', { name: /Open listing #\d+/ });
  const id = ((await link.innerText()).match(/#(\d+)/) ?? [])[1]!;
  const offer = await sc.read<{ creator: Hex; lendingAsset: Hex; tokenId: bigint; amount: bigint; prepayAsset: Hex }>('getOffer', [BigInt(id)]);
  expect(offer.creator.toLowerCase()).toBe(owner.toLowerCase());
  expect(offer.lendingAsset.toLowerCase()).toBe(nft.toLowerCase());
  expect(offer.tokenId).toBe(tokenId);
  expect(offer.amount).toBe(parseEther('2'));
  expect(offer.prepayAsset.toLowerCase()).toBe(pay.toLowerCase());

  // Its own page reads it as an NFT for rent.
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: `Offer #${id}` })).toBeVisible();
  await expect(page.getByTestId('offer-facts')).toContainText('NFT for rent', { timeout: 60_000 });
});
