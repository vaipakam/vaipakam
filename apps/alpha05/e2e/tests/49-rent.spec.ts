/**
 * Rent (matrix NFT-02, NFT-03, NFT-04, NFT-38). With no listing the rental
 * book says so and, on this test network, offers the faucet. An owner lists
 * an ERC-721 for rent: the book shows it with no collateral and no ratio,
 * and its page offers "Rent this NFT". A renter whose wallet is short sees
 * the shortfall against rent plus buffer and no wallet step; once the
 * wallet holds enough, the review re-reads by itself, states the up-front
 * total, the buffer fixed by the listing, the rent rule and every
 * consequence, and the rental is signed, approved exactly and sent. The
 * outcome is measured: the rental started, the rent and buffer moved into
 * the renter's own vault, and the owner's vault names the renter as the
 * NFT's user. Runs on the desktop and the phone project; the chain is
 * reverted after each test.
 */
import { formatEther, parseAbi, parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';
import { ageOffer } from '@vaipakam/anvil-harness/lending';

const NFT_ABI = parseAbi(['function mint(address to, uint256 tokenId)', 'function approve(address to, uint256 tokenId)']);
const TOKEN_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address owner) view returns (uint256)']);
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 7 : 3);
}

test('an empty rental book offers the faucet; an owner lists an NFT and a renter rents it, measured from the chain', async ({ launchWallet }, testInfo) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  const nft = mocks.rentalNft!;
  const pay = mocks.liquidToken!;
  const owner = accountFor('lender').address;
  const renter = accountFor('borrower').address;

  // Without a wallet the book is not read; with one and no listing, the
  // page says the book is empty and offers the faucet on this test network.
  const { page, flags } = await launchWallet('borrower', { preAuthorized: false });
  await page.goto('/rent');
  await expect(page.getByRole('heading', { level: 1, name: 'Rent an NFT' })).toBeVisible();
  await expect(page.getByTestId('rent-connect')).toBeVisible();
  await expect(page.getByTestId('offer-book')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  const book = page.getByTestId('offer-book');
  await expect(book.getByRole('heading', { name: 'NFTs for rent' })).toBeVisible();
  await expect(page.getByTestId('offer-book-tabs')).toHaveCount(0);
  await expect(page.getByTestId('rent-empty')).toContainText('No NFT is listed for rent', { timeout: 60_000 });
  await expect(page.getByTestId('rent-faucet')).toHaveAttribute('href', '/#faucet');
  await expect(page.getByTestId('rent-request-open')).toBeVisible();
  await fitsWidth(page);

  // The owner lists an NFT for rent: 2 tokens a day for 5 days.
  const tokenId = freshId(testInfo.project.name);
  await sc.write('lender', nft, NFT_ABI, 'mint', [owner, tokenId]);
  await sc.write('lender', nft, NFT_ABI, 'approve', [sc.diamond, tokenId]);
  const fee = parseEther('2');
  const created = await sc.diamondWrite('lender', 'createOffer', [
    {
      offerType: 0,
      lendingAsset: nft,
      amount: fee,
      interestRateBps: 0n,
      collateralAsset: ZERO,
      collateralAmount: 0n,
      durationDays: 5n,
      assetType: 1,
      tokenId,
      quantity: 1n,
      creatorRiskAndTermsConsent: true,
      prepayAsset: pay,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      collateralQuantity: 0n,
      allowsPartialRepay: false,
      amountMax: fee,
      interestRateBpsMax: 0n,
      collateralAmountMax: 0n,
      periodicInterestCadence: 0,
      expiresAt: 0n,
      fillMode: 0,
      allowsPrepayListing: false,
      allowsParallelSale: false,
      refinanceTargetLoanId: 0n,
      useFullTermInterest: false,
    },
  ]);
  const offerId = BigInt(sc.decodeDiamondLogs(created.logs).find((e) => e.eventName === 'OfferCreated')!.args.offerId as bigint);
  await ageOffer(sc, offerId);
  const id = offerId.toString();
  const raw = await sc.read<{ rentalBufferBpsAtCreate: number }>('getOffer', [offerId]);
  const bufferBps = BigInt(raw.rentalBufferBpsAtCreate);
  const rent = fee * 5n;
  const total = rent + (rent * bufferBps) / 10_000n;

  // The book lists it with no collateral and no ratio.
  await page.reload();
  const row = page.getByTestId(`book-row-${id}`);
  await expect(row).toContainText(`Offer #${id}: rent out NFT #${tokenId} of vRENT`, { timeout: 60_000 });
  await expect(row).toContainText('a day, on a 5-day term');
  await expect(row).toContainText('None: a rental has no collateral and no ratio');
  // A filter that hides the listing says so; it never claims an empty book.
  await page.getByTestId('offer-book-side-borrower').click();
  await expect(page.getByTestId('offer-book-filtered')).toBeVisible();
  await expect(page.getByTestId('rent-empty')).toHaveCount(0);
  await page.getByTestId('offer-book-side-lender').click();
  await expect(row).toBeVisible();
  await fitsWidth(page);
  await page.getByTestId(`book-link-${id}`).click();

  // Its page reads it from the chain and offers the rental review.
  await expect(page.getByRole('heading', { level: 1, name: `Offer #${id}` })).toBeVisible();
  const facts = page.getByTestId('offer-facts');
  await expect(facts).toContainText('NFT for rent', { timeout: 60_000 });
  await expect(facts).toContainText('Daily fee');
  await expect(facts).toContainText('None: a rental has no collateral and no ratio');
  await page.getByTestId('offer-page-take').click();

  // A wallet short of rent plus buffer sees the shortfall, and no wallet step.
  const flow = page.getByTestId('rent-accept');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Moved from your wallet into your own vault', { timeout: 60_000 });
  // The wallet is brought to one base unit short of rent plus buffer (it
  // covers the rent alone), whatever it held before.
  const held = await sc.pub.readContract({ address: pay, abi: TOKEN_ABI, functionName: 'balanceOf', args: [renter] });
  if (held < total - 1n) {
    await sc.write('borrower', pay, TOKEN_ABI, 'mint', [renter, total - 1n - held]);
    await expect(flow).toContainText('short of the', { timeout: 60_000 });
    await expect(flow.getByTestId('rent-consent')).toHaveCount(0);
  }

  // Once the wallet holds enough, the review re-reads by itself.
  await sc.write('borrower', pay, TOKEN_ABI, 'mint', [renter, 1n]);
  await expect(flow.getByTestId('rent-consent')).toBeVisible({ timeout: 60_000 });
  await expect(receipt).toContainText(formatEther(total).replace(/\.0$/, ''));
  await expect(receipt).toContainText(`The right to use NFT #${tokenId} of vRENT until the rental ends`);
  await expect(receipt).toContainText('fixed by the listing');
  await expect(receipt).toContainText('Pro-rata: you pay for the days you use');
  await expect(receipt).toContainText('Unused rent and the whole buffer come back to you as a claim');
  await expect(receipt).toContainText('None: a rental has no collateral and no health factor');
  await expect(receipt).toContainText('You never own this NFT');
  await expect(receipt).toContainText('the rental closes by itself and your buffer is yours to claim. Until then you can close it from its page');
  await expect(receipt).toContainText('Wallet prompts: 3.');
  await fitsWidth(page);

  const vault = await sc.read<Hex>('getUserVaultAddress', [renter]);
  const before = vault === ZERO ? 0n : await sc.pub.readContract({ address: pay, abi: TOKEN_ABI, functionName: 'balanceOf', args: [vault] });
  await flow.getByTestId('rent-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('started with you as the renter');
  await expect(finish).toContainText('moved into your own vault for the rent and buffer');
  await expect(finish).toContainText(`You hold the right to use NFT #${tokenId} of vRENT until`);
  // The approval and the rental; the signature is not a transaction.
  expect(flags.sentTransactions).toBe(sent + 2);
  await expect(finish.getByRole('link', { name: /Open rental #\d+/ })).toBeVisible();
  await fitsWidth(page);

  // The chain agrees: the owner's vault names the renter as the NFT's user,
  // and the renter's vault holds the rent and buffer.
  const user = await sc.read<Hex>('vaultGetNFTUserOf', [owner, nft, tokenId]);
  expect(user.toLowerCase()).toBe(renter.toLowerCase());
  const renterVault = await sc.read<Hex>('getUserVaultAddress', [renter]);
  const after = await sc.pub.readContract({ address: pay, abi: TOKEN_ABI, functionName: 'balanceOf', args: [renterVault] });
  expect(after - before).toBe(total);
});
