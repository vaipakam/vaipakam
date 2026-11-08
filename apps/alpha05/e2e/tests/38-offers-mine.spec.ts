/**
 * My offers and cancelling (matrix OFF-46, OFF-48, OFF-49), through the
 * protocol's public entry points on the fixture chain. A wallet posts a
 * lending offer: the Offers page lists it as open, the cancel review is
 * held by the protocol's five-minute cool-down and lifts by itself once the
 * chain passes it, the review states the unlent amount returning to this
 * wallet at once, and the finish card measures it. After the cancel the
 * offer reads as cancelled, with the protocol's cleared terms said so. A
 * borrowing request that expired is cleaned up, returning its collateral.
 * Runs on the desktop and the phone project, with wallets that have no
 * history; the chain is reverted after each test.
 */
import { erc20Abi, parseEther } from 'viem';
import { postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
const ZERO: Hex = '0x0000000000000000000000000000000000000000';

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

test('an open lending offer is cancelled after the cool-down, and its unlent amount returns to this wallet', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const me = sc.address('lender');
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 650, days: 14 });
  const id = offerId.toString();
  const before = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] });

  const { page, flags } = await launchWallet('freshLender');
  await page.goto('/offers');
  await connectWallet(page);
  const row = page.getByTestId(`offer-row-${id}`);
  await expect(row).toContainText(`Offer #${id}: lend 0.05 WETH at 6.5% a year, on a 14-day term.`, { timeout: 60_000 });
  await expect(page.getByTestId(`offer-state-${id}`)).toHaveText('Open');
  await expect(page.getByTestId('offers-filter-open')).toHaveText('Open (1)');
  await fitsWidth(page);

  await page.getByTestId(`offer-cancel-${id}`).click();
  const flow = page.getByTestId(`offer-cancel-panel-${id}`);
  // Just posted: the cool-down holds the cancel, and says until when.
  await expect(flow).toContainText('cannot be cancelled in its first five minutes', { timeout: 60_000 });
  await fitsWidth(page);
  await anvilRpc('evm_increaseTime', [301]);
  await anvilRpc('evm_mine');
  await expect(flow).not.toContainText('cannot be cancelled in its first five minutes', { timeout: 60_000 });

  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Cancel this offer');
  await expect(receipt).toContainText(`Lending offer #${id}`);
  await expect(receipt).toContainText('0.05 WETH');
  await expect(receipt).toContainText('This wallet, at once');
  await expect(receipt).toContainText('position token is retired');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(`Offer #${id} cancelled`);
  await expect(finish).toContainText('Returned to your wallet: 0.05 WETH');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [me] })).toBe(before + parseEther('0.05'));

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('offers-filter-cancelled')).toHaveText('Cancelled (1)', { timeout: 60_000 });
  await page.getByTestId('offers-filter-cancelled').click();
  await expect(page.getByTestId(`offer-state-${id}`)).toHaveText('Cancelled');
  await expect(row).toContainText('cleared this offer’s terms');
  await fitsWidth(page);
});

test('an expired borrowing request is cleaned up, and its collateral returns to this wallet', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const me = sc.address('borrower');
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const collateral = parseEther('300');
  await sc.write('borrower', tliq, TOKEN_ABI, 'mint', [me, collateral]);
  await sc.write('borrower', tliq, TOKEN_ABI, 'approve', [sc.diamond, collateral]);
  const head = await sc.pub.getBlock({ blockTag: 'latest' });
  const principal = parseEther('0.04');
  const created = await sc.diamondWrite('borrower', 'createOffer', [
    {
      offerType: 1,
      lendingAsset: WETH,
      amount: principal,
      interestRateBps: 700n,
      collateralAsset: tliq,
      collateralAmount: collateral,
      durationDays: 30n,
      assetType: 0,
      tokenId: 0n,
      quantity: 1n,
      creatorRiskAndTermsConsent: true,
      prepayAsset: ZERO,
      collateralAssetType: 0,
      collateralTokenId: 0n,
      collateralQuantity: 0n,
      allowsPartialRepay: true,
      amountMax: principal,
      interestRateBpsMax: 700n,
      collateralAmountMax: collateral,
      periodicInterestCadence: 0,
      expiresAt: head.timestamp + 3600n,
      fillMode: 0,
      allowsPrepayListing: false,
      allowsParallelSale: false,
      refinanceTargetLoanId: 0n,
      useFullTermInterest: false,
    },
  ]);
  const ev = sc.decodeDiamondLogs(created.logs).find((e) => e.eventName === 'OfferCreated');
  const id = BigInt(ev!.args.offerId as bigint).toString();
  await anvilRpc('evm_increaseTime', [3700]);
  await anvilRpc('evm_mine');
  const before = await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'balanceOf', args: [me] });

  const { page } = await launchWallet('freshBorrower');
  await page.goto('/offers');
  await connectWallet(page);
  await expect(page.getByTestId('offers-filter-expired')).toHaveText('Expired (1)', { timeout: 60_000 });
  await page.getByTestId('offers-filter-expired').click();
  const row = page.getByTestId(`offer-row-${id}`);
  await expect(page.getByTestId(`offer-state-${id}`)).toHaveText('Expired');
  await expect(row).toContainText('stays in the vault until someone cleans it up');
  await fitsWidth(page);

  await page.getByTestId(`offer-cancel-${id}`).click();
  const flow = page.getByTestId(`offer-cancel-panel-${id}`);
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Borrowing request #${id}`, { timeout: 60_000 });
  await expect(receipt).toContainText('300 tLIQ');
  await expect(receipt).toContainText('This offer expired');
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText('Returned to your wallet: 300 tLIQ');
  expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'balanceOf', args: [me] })).toBe(before + collateral);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('offers-filter-cancelled')).toHaveText('Cancelled (1)', { timeout: 60_000 });
});
