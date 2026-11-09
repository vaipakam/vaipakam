/**
 * Take a renter's request (matrix NFT-01 / NFT-02, Take request). A renter
 * posts a request for an NFT: its page reads it as a renter's request and
 * offers "Rent out your NFT". An owner whose wallet does not hold the token
 * is told so in the review, with no wallet step; once the wallet holds it,
 * the review re-reads by itself and states that the NFT moves into the
 * owner's own vault, who the renter is, the daily fee, term and rent rule,
 * the rent and buffer already in the renter's vault, what the owner receives
 * and what a default does. The terms are signed, the one token approved, and
 * the rental started; the outcome is measured: the rental, the NFT in the
 * owner's vault, and the vault naming the renter as its user. The chain
 * agrees. Runs on the desktop and the phone project; the chain is reverted
 * after each test.
 */
import { parseAbi, parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const NFT_ABI = parseAbi(['function mint(address to, uint256 tokenId)', 'function ownerOf(uint256 tokenId) view returns (address)']);
const TOKEN_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)']);
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

/** A token id no other spec or project mints, so the two projects never meet. */
function freshId(project: string): bigint {
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 6 : 2);
}

test('an owner takes a renter’s request: a token not held is refused in the review, then the NFT moves into the owner’s vault and the renter becomes its user, measured from the chain', async ({ launchWallet }, testInfo) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  const nft = mocks.rentalNft!;
  const pay = mocks.liquidToken!;
  const owner = accountFor('lender').address;
  const renter = accountFor('borrower').address;

  // The renter asks to rent a token nobody holds yet: 2 tokens a day for 5
  // days, the rent and buffer moved into the renter's vault at posting.
  const tokenId = freshId(testInfo.project.name);
  const fee = parseEther('2');
  const [, bufferBps] = await sc.read<readonly [bigint, bigint]>('getRiskConfig', []);
  const rent = fee * 5n;
  const total = rent + (rent * bufferBps) / 10_000n;
  await sc.write('borrower', pay, TOKEN_ABI, 'mint', [renter, total]);
  await sc.write('borrower', pay, TOKEN_ABI, 'approve', [sc.diamond, total]);
  const created = await sc.diamondWrite('borrower', 'createOffer', [
    {
      offerType: 1,
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
  const id = offerId.toString();

  // Its page reads it as a renter's request and offers renting the NFT out.
  const { page, flags } = await launchWallet('lender', { preAuthorized: false });
  await page.goto(`/offers/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: `Offer #${id}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  const facts = page.getByTestId('offer-facts');
  await expect(facts).toContainText('A renter’s request to rent an NFT', { timeout: 60_000 });
  await expect(facts).toContainText('NFT for rent');
  await expect(page.getByTestId('offer-elsewhere')).toHaveCount(0);
  const take = page.getByTestId('offer-page-take');
  await expect(take).toHaveText('Rent out your NFT');
  await expect(take).toBeEnabled({ timeout: 60_000 });
  await fitsWidth(page);
  await take.click();

  // The token does not exist yet: said in the review, no wallet step.
  const flow = page.getByTestId('rent-take');
  await expect(flow).toContainText(`No NFT #${tokenId} exists in this collection`, { timeout: 60_000 });
  await expect(flow.getByTestId('rent-take-consent')).toHaveCount(0);

  // Once the owner's wallet holds it, the review re-reads by itself.
  await sc.write('lender', nft, NFT_ABI, 'mint', [owner, tokenId]);
  await expect(flow.getByTestId('rent-take-consent')).toBeVisible({ timeout: 60_000 });
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Moved from your wallet into your own vault');
  await expect(receipt).toContainText(`NFT #${tokenId} of vRENT`);
  await expect(receipt).toContainText('Renter');
  await expect(receipt).toContainText('5 days from now');
  await expect(receipt).toContainText('Pro-rata: the renter pays for the days used');
  await expect(receipt).toContainText('Already in the renter’s vault');
  await expect(receipt).toContainText('fixed by the request');
  await expect(receipt).toContainText('into your vault when the rental closes');
  await expect(receipt).toContainText('the buffer goes to the protocol');
  await expect(receipt).toContainText('None: a rental has no collateral and no health factor');
  await expect(receipt).toContainText('You cannot withdraw it while the rental is open');
  await expect(receipt).toContainText('Wallet prompts: 3.');
  await fitsWidth(page);

  await flow.getByTestId('rent-take-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('started with you as the owner');
  await expect(finish).toContainText(`NFT #${tokenId} of vRENT moved into your own vault`);
  await expect(finish).toContainText(`The renter holds the right to use NFT #${tokenId} of vRENT until`);
  // The one-token approval and the rental; the signature is not a transaction.
  expect(flags.sentTransactions).toBe(sent + 2);
  await expect(finish.getByRole('link', { name: /Open rental #\d+/ })).toBeVisible();
  await fitsWidth(page);

  // The chain agrees: the owner's vault holds the NFT and names the renter
  // as its user.
  const vault = await sc.read<Hex>('getUserVaultAddress', [owner]);
  const holder = await sc.pub.readContract({ address: nft, abi: NFT_ABI, functionName: 'ownerOf', args: [tokenId] });
  expect(holder.toLowerCase()).toBe(vault.toLowerCase());
  const user = await sc.read<Hex>('vaultGetNFTUserOf', [owner, nft, tokenId]);
  expect(user.toLowerCase()).toBe(renter.toLowerCase());
});
