/**
 * Why an Auto-lend is not lending (#3660), against the suite's chain and the
 * index stand-in. On Positions, an active Auto-lend with money waiting
 * offers "Why isn't it lending?" behind a tap. With no borrow request on
 * the pair it says so. With a request whose rate sits below the Auto-lend's
 * lowest, once the pair has its two hourly price checks, it states the
 * protocol's own refusal with both rates and links the request. With the
 * index down it says the closest requests are unknown instead of claiming
 * there are none. Nothing is sent. Runs on the desktop and the phone; the
 * chain is reverted after each test.
 */
import type { Page } from '@playwright/test';
import { erc20Abi, parseAbi, parseEther, type Hex } from 'viem';
import { postBorrowRequest, WETH } from '@vaipakam/anvil-harness/lending';
import { anvilRpc } from '../lib/anvil';
import { scenario, txDeadline } from '../lib/chain';
import { setIndexPosture } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

type Scenario = ReturnType<typeof scenario>;
const CHECKPOINT = parseAbi(['function checkpointHourlyPrices(address[] assets)']);
const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** This hour's price checkpoints, at a fixed gas limit (#3504). */
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

/** An Auto-lend lending WETH against tLIQ from 5% a year, for up to 30 days,
 *  with 0.5 WETH waiting. It accepts interest for the time borrowed, as the
 *  harness's requests pay, so the protocol's first refusal of the request
 *  below is its rate and not its interest terms. */
async function autoLend(sc: Scenario, tliq: Hex): Promise<void> {
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await sc.diamondWrite('admin', 'setLenderIntentEnabled', [true]);
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('1'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, parseEther('0.5')]);
  await sc.diamondWrite('lender', 'setLenderIntent', [WETH, tliq, 0, parseEther('1'), 500n, 5000, 30, parseEther('0.04'), false, 0n, true, true, { linkKind: 0, linkMarginBps: 0, rateFarFromAverageAcknowledged: false }, await txDeadline(sc)]);
  await sc.diamondWrite('lender', 'fundLenderIntent', [WETH, tliq, 0, parseEther('0.5')]);
}

async function openWhy(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/positions');
  await connectWallet(page);
  const why = page.getByTestId('autolend-why');
  await expect(why).toBeVisible({ timeout: 60_000 });
  await why.getByTestId('autolend-why-open').click();
  return why;
}

test('says no request stands on the pair, then names the closest request’s rate gap in the protocol’s words', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await autoLend(sc, tliq);

  const { page, flags } = await launchWallet('lender');
  let why = await openWhy(page);
  const verdict = why.getByTestId('autolend-why-verdict');
  await expect(verdict).toHaveAttribute('data-why', 'none', { timeout: 60_000 });
  await expect(verdict).toHaveText('No open borrow request stands on this pair yet.');
  await fitsWidth(page);

  // A request paying 3% to 4%, and the pair's two hourly price checks, so the
  // protocol's first refusal is the rate.
  const low = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 300, rateMaxBps: 400, days: 14 });
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  await checkpoint(sc, [WETH, tliq]);
  await anvilRpc('evm_increaseTime', [3600]);
  await anvilRpc('evm_mine');
  why = await openWhy(page);
  await expect(verdict).toHaveAttribute('data-why', 'gap', { timeout: 60_000 });
  await expect(verdict).toHaveText('The closest request pays at most 4% a year; your Auto-lend lends from 5%.');
  await expect(why.getByTestId('autolend-why-standing')).toHaveText('Open borrow requests on this pair: 1.');
  await why.getByTestId('autolend-why-closest').locator('summary').click();
  await expect(why.getByTestId('autolend-why-closest')).toContainText(`Offer #${low}`);
  await fitsWidth(page);
  expect(flags.sentTransactions).toBe(0);
});

test('says the closest requests are unknown while the index is down', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await autoLend(sc, tliq);
  await setIndexPosture('down');
  try {
    const { page } = await launchWallet('lender');
    const why = await openWhy(page);
    await expect(why.getByTestId('autolend-why-index-failed')).toContainText('the closest requests are unknown', { timeout: 60_000 });
    await expect(why.getByTestId('autolend-why-verdict')).toHaveCount(0);
  } finally {
    await setIndexPosture('live');
  }
});
