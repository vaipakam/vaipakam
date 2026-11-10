/**
 * Close a rental (matrix NFT-05). An owner lists an ERC-721 for rent and a
 * renter rents it through the protocol's public entry points; a day and a
 * half later the owner's page says how a rental ends and offers nothing,
 * while the renter's page offers "Close the rental". The review takes
 * nothing from the wallet: it states the rent owed now and at the latest
 * moment it reaches (two days, a part day counted whole), the days already
 * settled, the late fee (none inside the term), what comes back as a claim
 * and what the owner receives. The close is one prompt after a dry run, and
 * its outcome is measured: the rental closed, the renter's claim recorded,
 * and the owner's vault no longer naming the renter as the NFT's user. Runs
 * on the desktop and the phone project; the chain is reverted after each
 * test.
 */
import { parseAbi, parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { acceptPostedOffer } from '@vaipakam/anvil-harness/lending';
import { anvilRpc, increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const NFT_ABI = parseAbi(['function mint(address to, uint256 tokenId)', 'function approve(address to, uint256 tokenId)']);
const TOKEN_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount)']);
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
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 8 : 4);
}

test('a renter closes a rental: nothing from the wallet, the rent and claim stated, then the rental closed, the claim recorded and the use ended, measured from the chain', async ({ launchWallet }, testInfo) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  const nft = mocks.rentalNft!;
  const pay = mocks.liquidToken!;
  const owner = accountFor('lender').address;
  const renter = accountFor('borrower').address;

  // The owner lists an NFT for rent: 2 tokens a day for 5 days, pro-rata.
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

  // The renter rents it: rent for the whole term plus the buffer move into
  // the renter's own vault.
  const raw = await sc.read<{ rentalBufferBpsAtCreate: number }>('getOffer', [offerId]);
  const rent = fee * 5n;
  const total = rent + (rent * BigInt(raw.rentalBufferBpsAtCreate)) / 10_000n;
  await sc.write('borrower', pay, TOKEN_ABI, 'mint', [renter, total]);
  await sc.write('borrower', pay, TOKEN_ABI, 'approve', [sc.diamond, total]);
  const { loanId } = await acceptPostedOffer(sc, 'borrower', offerId);
  expect((await sc.read<Hex>('vaultGetNFTUserOf', [owner, nft, tokenId])).toLowerCase()).toBe(renter.toLowerCase());

  // A day and a half in: two days used, a part day counted whole.
  await increaseTime(36 * 3600);
  await mine();

  // The owner is told how a rental ends, and offered nothing.
  const o = await launchWallet('lender');
  await o.page.goto(`/positions/${loanId}`);
  await connectWallet(o.page);
  const ownerActions = o.page.getByRole('region', { name: 'Actions' });
  await expect(ownerActions.getByTestId('rent-close-ends')).toContainText('A rental ends when the renter closes it', { timeout: 60_000 });
  await expect(ownerActions.getByTestId('rent-close-open')).toHaveCount(0);
  await expect(ownerActions.getByTestId('repay-refusal')).toHaveCount(0);
  await o.page.close();

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const actions = page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByTestId('repay-refusal')).toHaveCount(0);
  await actions.getByTestId('rent-close-open').click({ timeout: 60_000 });

  const flow = page.getByTestId('rent-close-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Close rental #${loanId}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Nothing: the rent and late fee are paid from what you prepaid');
  await expect(receipt).toContainText('Rent owed if it closes now');
  await expect(receipt).toContainText('for 2 days');
  await expect(receipt).toContainText('Days used since the start, a part day as a whole day, less days settled');
  await expect(receipt).toContainText('0 of 5');
  await expect(receipt).toContainText('Late fee if it closes now');
  await expect(receipt).toContainText('collected on the Claims page');
  await expect(receipt).toContainText(`Your right to use NFT #${tokenId} of vRENT ends when the close lands`);
  await expect(receipt).toContainText('less the protocol’s share');
  await expect(receipt).toContainText('Closing ends your right to use the NFT at once');
  await expect(receipt).toContainText('a day that begins before then is paid as a whole day');
  await expect(receipt).toContainText('Closing after the term ends costs a late fee');
  await expect(receipt).toContainText('Wallet prompts: 1.');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(`Rental #${loanId} closed`);
  await expect(finish).toContainText('recorded for you as a claim');
  await expect(finish).toContainText(`Your use of NFT #${tokenId} of vRENT ended`);
  // One transaction, no approval.
  expect(flags.sentTransactions).toBe(sent + 1);
  await fitsWidth(page);

  // The chain agrees: closed, the renter's claim is the prepayment less two
  // days' rent, and the owner's vault names no user.
  const after = await sc.read<{ status: number }>('getLoanDetails', [loanId]);
  expect(Number(after.status)).toBe(1);
  const claim = await sc.read<readonly [Hex, bigint]>('getClaimable', [loanId, false]);
  expect(claim[1]).toBe(total - fee * 2n);
  expect((await sc.read<Hex>('vaultGetNFTUserOf', [owner, nft, tokenId])).toLowerCase()).not.toBe(renter.toLowerCase());
});
