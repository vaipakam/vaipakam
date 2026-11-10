/**
 * Ask to rent an NFT (matrix NFT-02, Post request). A renter opens the
 * request form on Rent and names a token that does not exist yet: the review
 * says so, and names a shortfall against rent plus buffer with no wallet
 * step. Once the wallet holds enough, the review re-reads by itself and
 * states what moves into the renter's own vault now, the daily fee, term and
 * rent rule, the buffer this request fixes now, that an owner who takes it
 * starts the rental at once, and every consequence. The request is approved
 * for exactly the rent and buffer and posted, and the outcome is measured:
 * the request recorded and the rent and buffer in the renter's vault. The
 * chain agrees, and the request's own page reads it as an NFT for rent.
 * Runs on the desktop and the phone project; the chain is reverted after
 * each test.
 */
import { formatEther, parseAbi, parseEther, type Hex } from 'viem';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const TOKEN_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address owner) view returns (uint256)']);

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
  return BigInt(Date.now()) * 10n + BigInt(project === 'phone' ? 9 : 5);
}

test('a renter posts a request to rent: a shortfall is stated first, then the rent and buffer move into the renter’s vault, measured from the chain', async ({ launchWallet }, testInfo) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  const nft = mocks.rentalNft!;
  const pay = mocks.liquidToken!;
  const renter = accountFor('borrower').address;

  const { page, flags } = await launchWallet('borrower', { preAuthorized: false });
  await page.goto('/rent');
  await expect(page.getByRole('heading', { level: 1, name: 'Rent an NFT' })).toBeVisible();
  await expect(page.getByTestId('rent-connect')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  const open = page.getByTestId('rent-request-open');
  await expect(open).toBeEnabled({ timeout: 60_000 });
  await open.click();

  // The form: no collateral or rate fields, one daily fee; the book steps
  // aside and the listing button is disabled while the request is open.
  const form = page.getByTestId('rent-request-form');
  await expect(form).toBeVisible();
  await expect(form).toContainText('a rental fee is never a range');
  await expect(page.getByTestId('offer-book')).toHaveCount(0);
  await expect(page.getByTestId('rent-list-open')).toBeDisabled();
  // A fee so large no test wallet holds the rent: the shortfall is stated.
  const tokenId = freshId(testInfo.project.name);
  const balance = await sc.pub.readContract({ address: pay, abi: TOKEN_ABI, functionName: 'balanceOf', args: [renter] });
  const days = 5n;
  const fee = balance / days + parseEther('1');
  const feeText = formatEther(fee);
  await form.getByTestId('rent-request-nft').selectOption(nft);
  await form.getByTestId('rent-request-token-id').fill(tokenId.toString());
  await form.getByTestId('rent-request-pay').selectOption(pay);
  await form.getByTestId('rent-request-fee').fill(feeText);
  await form.getByTestId('rent-request-days').fill(days.toString());
  await fitsWidth(page);
  await form.getByTestId('rent-request-continue').click();

  const flow = page.getByTestId('rent-request-flow');
  await expect(flow).toContainText(`No NFT #${tokenId} exists in this collection yet`, { timeout: 60_000 });
  await expect(flow).toContainText('short of the', { timeout: 60_000 });
  await expect(flow.getByTestId('rent-request-consent')).toHaveCount(0);

  // Once the wallet holds enough, the review re-reads by itself.
  const [, bufferBps] = await sc.read<readonly [bigint, bigint]>('getRiskConfig', []);
  const rent = fee * days;
  const buffer = (rent * bufferBps) / 10_000n;
  const total = rent + buffer;
  await sc.write('borrower', pay, TOKEN_ABI, 'mint', [renter, total]);
  await expect(flow.getByTestId('rent-request-consent')).toBeVisible({ timeout: 60_000 });
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Moved from your wallet into your own vault');
  await expect(receipt).toContainText(`NFT #${tokenId} of vRENT, which does not exist yet`);
  await expect(receipt).toContainText('5 days of use once an owner takes it');
  await expect(receipt).toContainText('Pro-rata: you pay for the days you use');
  // The buffer is today's setting; the request keeps the one in force when
  // it lands, and the review states that race.
  await expect(receipt).toContainText("of the rent at today's setting");
  await expect(receipt).toContainText('The protocol takes the buffer setting in force when your request lands');
  await expect(receipt).toContainText('Unused rent and the whole buffer come back to you as a claim');
  await expect(receipt).toContainText('None: a rental has no collateral and no health factor');
  await expect(receipt).toContainText('starts the rental at once, with no further step from you');
  await expect(receipt).toContainText('You cannot withdraw them until you cancel it or it ends');
  await expect(receipt).toContainText('Wallet prompts: 2.');
  await fitsWidth(page);

  await flow.getByTestId('rent-request-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(/Request #\d+ posted/);
  await expect(finish).toContainText('moved into your own vault for the rent and buffer');
  // The exact approval and the request.
  expect(flags.sentTransactions).toBe(sent + 2);
  await fitsWidth(page);

  // The chain agrees: the renter's vault holds the rent and buffer, and the
  // request names the NFT, the fee and the payment token.
  const vault = await sc.read<Hex>('getUserVaultAddress', [renter]);
  const held = await sc.pub.readContract({ address: pay, abi: TOKEN_ABI, functionName: 'balanceOf', args: [vault] });
  expect(held >= total).toBe(true);
  const link = finish.getByRole('link', { name: /Open request #\d+/ });
  const id = ((await link.innerText()).match(/#(\d+)/) ?? [])[1]!;
  const offer = await sc.read<{ creator: Hex; offerType: number; lendingAsset: Hex; tokenId: bigint; amount: bigint; prepayAsset: Hex }>('getOffer', [BigInt(id)]);
  expect(offer.creator.toLowerCase()).toBe(renter.toLowerCase());
  expect(Number(offer.offerType)).toBe(1);
  expect(offer.lendingAsset.toLowerCase()).toBe(nft.toLowerCase());
  expect(offer.tokenId).toBe(tokenId);
  expect(offer.amount).toBe(fee);
  expect(offer.prepayAsset.toLowerCase()).toBe(pay.toLowerCase());

  // Its own page reads it as an NFT for rent.
  await link.click();
  await expect(page.getByRole('heading', { level: 1, name: `Offer #${id}` })).toBeVisible();
  await expect(page.getByTestId('offer-facts')).toContainText('NFT for rent', { timeout: 60_000 });
});
