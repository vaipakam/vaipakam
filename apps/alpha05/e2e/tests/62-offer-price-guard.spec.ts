/**
 * The maker's price-move guard on an offer's page (#3358), against the
 * suite's chain. The creator of an open WETH-against-tLIQ offer puts a 5%
 * guard on it: the review says the offer was unguarded until now and that
 * no one can fill it until hourly price checks cover the pair, and the
 * finish card reads the change from the transaction's logs. The page then
 * says a fill is refused for missing checks; once two hourly checks exist
 * it says a fill is allowed. Another wallet sees the guard and why a fill
 * would be refused, with no way to change it. The creator changes the limit
 * and removes the guard. Runs on the desktop and the phone; the suite
 * reverts the chain after every test.
 */
import type { Page } from '@playwright/test';
import { parseAbi } from 'viem';
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
    ['Put a price-move guard on this offer', `#${id}`, '5%', 'has no guard, as it has had since you posted it', 'no one can fill the offer', 'Nothing moves'],
    'The guard is set at 5%',
  );
  expect((await sc.read<Guard>('getOfferPriceGuard', [offerId])).maxMoveBps).toBe(500);
  await expect(guard).toHaveAttribute('data-on', 'true', { timeout: 60_000 });
  await expect(guard.getByTestId('guard-limit')).toContainText('more than 5%');
  await expect(guard).toHaveAttribute('data-status', 'no-checkpoint');
  await expect(guard.getByTestId('guard-status')).toContainText('hourly price checks for this pair are missing');
  await fitsWidth(page);

  // Two hourly checks for both tokens: the pair is calm, so a fill is allowed.
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await page.reload();
  await connectWallet(page);
  await expect(guard).toHaveAttribute('data-status', 'clear', { timeout: 60_000 });
  await expect(guard.getByTestId('guard-status')).toContainText('A fill is allowed now');

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
});
