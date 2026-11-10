/**
 * The maker's price-move guard on an offer's page (#3358), against the
 * suite's chain. The creator of an open WETH-against-tLIQ offer puts a 5%
 * guard on it: the review says the offer has no guard now and that
 * no one can fill it until hourly price checks cover the pair, and the
 * finish card reads the change from the transaction's logs. The page then
 * says a fill is refused for missing checks; once two hourly checks exist
 * it says the guard would not refuse a fill. Another wallet sees the guard and why a fill
 * would be refused, with no way to change it. The creator changes the limit
 * and removes the guard; a review left open while the offer is cancelled
 * elsewhere stays, refused, until the reader closes it. A lender also posts
 * a new offer with a guard armed in the same transaction (Advanced), and the
 * offer is on the book guarded from the start. Runs on the desktop and the
 * phone; the suite reverts the chain after every test.
 */
import type { Page } from '@playwright/test';
import { erc20Abi, parseAbi, parseEther } from 'viem';
import { postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;
type Guard = { maxMoveBps: number; status: number };
type Scenario = ReturnType<typeof scenario>;
const CHECKPOINT = parseAbi(['function checkpointHourlyPrices(address[] assets)']);

/** Write this hour's price checkpoints for both tokens. Sent at a fixed
 *  limit, not an estimate: the price read inside catches running out of gas
 *  and skips the asset, so the node's estimate is too low (#3504). */
async function checkpoint(sc: Scenario, assets: Hex[]): Promise<void> {
  const w = sc.wallet('lender');
  const hash = await w.writeContract({
    address: sc.diamond,
    abi: CHECKPOINT,
    functionName: 'checkpointHourlyPrices',
    args: [assets],
    gas: 1_000_000n,
    chain: null,
    account: w.account!,
  });
  expect((await sc.pub.waitForTransactionReceipt({ hash })).status).toBe('success');
}

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Check a guard change's receipt, sign it, and wait for the measured outcome. */
async function sign(page: Page, receiptText: string[], outcomeText: string): Promise<void> {
  const flow = page.getByTestId('guard-panel');
  const receipt = flow.locator('.receipt');
  for (const t of receiptText) await expect(receipt).toContainText(t, { timeout: 60_000 });
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(finish).toContainText(outcomeText);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(flow).toHaveCount(0);
}

test('the creator guards an open offer, the page says when a fill is refused, and the guard is changed and removed', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario({ lender: 'freshLender' });
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 540, days: 14 });
  const id = offerId.toString();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;

  const { page, flags } = await launchWallet('freshLender');
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  const guard = page.getByTestId('guard');
  await expect(guard).toHaveAttribute('data-on', 'false', { timeout: 60_000 });
  await expect(guard).toContainText('This offer has no price-move guard.');
  const sent = flags.sentTransactions;

  // A limit out of range is not offered.
  await guard.getByTestId('guard-input').fill('0.2');
  await expect(guard.getByTestId('guard-set')).toBeDisabled();
  await expect(guard).toContainText('Enter a limit between 0.5% and 50%');

  await guard.getByTestId('guard-input').fill('5');
  await guard.getByTestId('guard-set').click();
  await sign(
    page,
    ['Put a price-move guard on this offer', `#${id}`, '5%', 'The offer has no guard now', 'no one can fill the offer', 'Nothing moves'],
    'The guard is set at 5%',
  );
  expect((await sc.read<Guard>('getOfferPriceGuard', [offerId])).maxMoveBps).toBe(500);
  await expect(guard).toHaveAttribute('data-on', 'true', { timeout: 60_000 });
  await expect(guard.getByTestId('guard-limit')).toContainText('more than 5%');
  await expect(guard).toHaveAttribute('data-status', 'no-checkpoint');
  await expect(guard.getByTestId('guard-status')).toContainText('hourly price checks for this pair are missing');
  await fitsWidth(page);

  // Two hourly checks for both tokens: the pair is calm, so the guard would not refuse a fill.
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await page.reload();
  await connectWallet(page);
  await expect(guard).toHaveAttribute('data-status', 'clear', { timeout: 60_000 });
  await expect(guard.getByTestId('guard-status')).toContainText('the guard would not refuse a fill now');

  // Another wallet sees the guard and cannot change it.
  const other = await launchWallet('visitor');
  await other.page.goto(`/offers/${id}`);
  await connectWallet(other.page);
  const seen = other.page.getByTestId('guard');
  await expect(seen.getByTestId('guard-limit')).toContainText('more than 5%', { timeout: 60_000 });
  await expect(seen.getByTestId('guard-input')).toHaveCount(0);
  await other.page.close();

  // Change it, then remove it.
  await guard.getByTestId('guard-input').fill('10');
  await guard.getByTestId('guard-set').click();
  await sign(page, ['Change this offer’s price-move guard', '10%', 'replaces the current guard'], 'The guard is set at 10%');
  expect((await sc.read<Guard>('getOfferPriceGuard', [offerId])).maxMoveBps).toBe(1000);
  await expect(guard.getByTestId('guard-limit')).toContainText('more than 10%', { timeout: 60_000 });
  await guard.getByTestId('guard-clear').click();
  await sign(page, ['Remove this offer’s price-move guard', 'no longer checked'], 'The guard is removed');
  expect((await sc.read<Guard>('getOfferPriceGuard', [offerId])).maxMoveBps).toBe(0);
  await expect(guard).toHaveAttribute('data-on', 'false', { timeout: 60_000 });
  expect(flags.sentTransactions).toBe(sent + 3);
  await fitsWidth(page);

  // A guard change under review when the creator cancels the offer elsewhere:
  // the cancel clears the terms, and the review stays, refused, until closed.
  await guard.getByTestId('guard-input').fill('5');
  await guard.getByTestId('guard-set').click();
  const flow = page.getByTestId('guard-panel');
  await expect(flow.locator('.receipt')).toContainText('Put a price-move guard on this offer', { timeout: 60_000 });
  await sc.diamondWrite('lender', 'cancelOffer', [offerId]);
  await expect(page.getByTestId('offer-no-terms')).toBeVisible({ timeout: 90_000 });
  await expect(flow).toContainText('This offer has no stored terms, so there is nothing to guard.', { timeout: 60_000 });
  await fitsWidth(page);
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await flow.getByRole('button', { name: 'Cancel' }).click();
  await expect(flow).toHaveCount(0);
  expect(flags.sentTransactions).toBe(sent + 3);
});

test('a lender posts an offer with a price-move guard armed in the same transaction', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ lender: 'freshLender' });
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await sc.write('lender', WETH, parseAbi(['function deposit() payable']), 'deposit', [], parseEther('0.2'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('freshLender', { advanced: true });
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
  await page.getByTestId('request-amount').fill('0.2');
  await page.getByTestId('request-rate').fill('6');
  await page.getByTestId('request-collateral').fill('1500');

  // The guard's limit is checked in the form, before any review.
  const field = page.getByTestId('request-guard');
  await field.getByTestId('request-guard-opt').check();
  await field.getByTestId('request-guard-input').fill('60');
  await field.getByTestId('request-guard-input').blur();
  await expect(field).toContainText('Enter a limit between 0.5% and 50%');
  await field.getByTestId('request-guard-input').fill('5');
  await fitsWidth(page);
  await page.getByTestId('request-review').click();

  const flow = page.locator('.post-request');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Post your lending offer', { timeout: 60_000 });
  await expect(receipt).toContainText('Guard limit');
  await expect(receipt).toContainText('5%, from the prices when this posts');
  await expect(receipt).toContainText('moved more than 5% from its level when this posts');
  await expect(receipt).toContainText('Until the hourly price checks cover this pair, no one can fill the offer.');
  await fitsWidth(page);
  await flow.getByTestId('request-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('The guard is set at 5%');
  await expect(finish).toContainText('0.2 WETH locked in your vault');
  // The approval, then the one transaction that arms the guard and posts.
  expect(flags.sentTransactions).toBe(sent + 2);

  const id = BigInt((await finish.textContent())!.match(/Offer #(\d+)/)![1]!);
  expect((await sc.read<Guard>('getOfferPriceGuard', [id])).maxMoveBps).toBe(500);
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  const guard = page.getByTestId('guard');
  await expect(guard).toHaveAttribute('data-on', 'true', { timeout: 60_000 });
  await expect(guard.getByTestId('guard-limit')).toContainText('more than 5%');
  await fitsWidth(page);
});
