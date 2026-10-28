/** #2437 — the VPFI token and treasury-fee figures on `/analytics`, read
 *  from the Diamond's own view functions.
 *
 *  WALLET-FREE, like the rest of the page: a bare Playwright page with no
 *  injected provider, the honest first-arrival posture.
 *
 *  WHAT IS ASSERTED. The section states the block it read at, and every
 *  figure on it is what the chain's view returns AT THAT BLOCK: the spec
 *  takes the block number from the page and re-reads `getVPFISnapshot`,
 *  `getTreasuryMetrics`, `getTreasury` and `getNumeraireSymbol` there, so a
 *  figure that does not trace to its view at the stated block fails. Which
 *  token and treasury branch applies is the chain's answer, not assumed.
 *
 *  And one failure posture: with `getTreasuryMetrics` made to revert (only
 *  it, inside the page's one aggregate), the fee figures say they could not
 *  be read and no fee figure is rendered — never a zero.
 */
import { test, expect, type Page } from '@playwright/test';
import { hexToString, toFunctionSelector, type Address, type Hex } from 'viem';
import { copySource as copy } from '../../src/content/copy';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';
import { callDataMatching, failRpcCalls } from '../lib/rpcFault';

const ZERO = '0x0000000000000000000000000000000000000000';
const E18 = 10n ** 18n;

/** The page's fixed-precision rule, in the page's (English) number format:
 *  truncate to `digits` fractional digits, group the whole part. */
function truncated(value: bigint, digits: number): string {
  const unit = E18 / 10n ** BigInt(digits);
  const fraction = ((value % E18) / unit).toString().padStart(digits, '0').replace(/0+$/, '');
  const s = fraction ? `${value / E18}.${fraction}` : (value / E18).toString();
  return new Intl.NumberFormat('en', { maximumFractionDigits: 20 }).format(s as unknown as number);
}

async function openFigures(page: Page) {
  await page.goto('/analytics#vpfi-token', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: copy.chainFigures.heading })).toBeVisible({
    timeout: 30_000,
  });
  const block = page.getByTestId('cf-block');
  await expect(block).toBeVisible({ timeout: 30_000 });
  return BigInt((await block.innerText()).replace(/[^\d]/g, ''));
}

const read = (functionName: string, blockNumber: bigint) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI_VIEM, functionName, blockNumber });

test('every contract figure is its view at the block the page states', async ({ page }) => {
  // The visitor's clock agrees with the chain's, as it does on a live
  // chain. This Anvil chain is shared and earlier specs warp its clock
  // forward, so without this the block would be stamped hours ahead of the
  // browser and the page would rightly call its age unknown (a stamp from
  // the future is never shown as fresh), which is not the case this test
  // is about. Timers keep running; only the date the page reads is set.
  const { timestamp: chainNow } = await pub.getBlock({ blockTag: 'latest' });
  await page.clock.setFixedTime(new Date(Number(chainNow) * 1000));
  const blockNumber = await openFigures(page);
  expect(blockNumber, 'a real block').toBeGreaterThan(0n);
  expect(blockNumber).toBeLessThanOrEqual(await pub.getBlockNumber());
  await expect(page.getByTestId('cf-age')).not.toHaveText(copy.analytics.unknown);

  const [snapshot, metrics, treasury, numeraireWord] = (await Promise.all([
    read('getVPFISnapshot', blockNumber),
    read('getTreasuryMetrics', blockNumber),
    read('getTreasury', blockNumber),
    read('getNumeraireSymbol', blockNumber),
  ])) as [
    readonly [Address, boolean, bigint, bigint, bigint, Address],
    readonly [bigint, bigint, bigint, bigint],
    Address,
    Hex,
  ];

  // ── VPFI token: whichever branch the chain answers ──
  const [token, canonical, supply, cap, headroom, minter] = snapshot;
  if (token === ZERO) {
    await expect(page.getByTestId('cf-token-unbound')).toHaveText(copy.chainFigures.unbound);
  } else {
    await expect(page.getByTestId('cf-token-address')).toHaveAttribute(
      'href',
      new RegExp(`/address/${token}$`, 'i'),
    );
    await expect(page.getByTestId('cf-supply')).toHaveText(`${truncated(supply, 4)} VPFI`);
    if (canonical) {
      await expect(page.getByTestId('cf-cap')).toHaveText(`${truncated(cap, 4)} VPFI`);
      await expect(page.getByTestId('cf-headroom')).toHaveText(`${truncated(headroom, 4)} VPFI`);
      if (minter === ZERO) await expect(page.getByTestId('cf-minter-none')).toBeVisible();
      else
        await expect(page.getByTestId('cf-minter')).toHaveAttribute('href', new RegExp(`/address/${minter}$`, 'i'));
    } else {
      // A bridged chain: no cap or minter, and the page says where they live.
      await expect(page.getByTestId('cf-cap')).toHaveCount(0);
      await expect(page.getByText(copy.chainFigures.mirrorNote)).toBeVisible();
    }
  }

  // ── Fees, in the chain's reference currency ──
  const unit = /^0x0{64}$/.test(numeraireWord) ? 'USD' : hexToString(numeraireWord, { size: 32 }).toUpperCase();
  const [held, total, last24h, last7d] = metrics;
  const fee = (v: bigint) => `${truncated(v, 2)} ${unit}`;
  await expect(page.getByTestId('cf-fees-total')).toHaveText(fee(total));
  await expect(page.getByTestId('cf-fees-24h')).toHaveText(fee(last24h));
  await expect(page.getByTestId('cf-fees-7d')).toHaveText(fee(last7d));
  await expect(page.getByText(copy.chainFigures.feesLowerBound)).toBeVisible();

  // ── Treasury: named; a held balance only when the Diamond is it ──
  if (treasury === ZERO) {
    await expect(page.getByTestId('cf-treasury-unset')).toBeVisible();
  } else {
    await expect(page.getByTestId('cf-treasury-address')).toHaveAttribute(
      'href',
      new RegExp(`/address/${treasury}$`, 'i'),
    );
    if (treasury.toLowerCase() === DIAMOND.toLowerCase()) {
      await expect(page.getByTestId('cf-held')).toHaveText(fee(held));
    } else {
      await expect(page.getByTestId('cf-held')).toHaveCount(0);
      await expect(page.getByText(copy.chainFigures.treasuryExternal)).toBeVisible();
    }
  }
});

test('a fee view that cannot be read says so, and shows no fee figure', async ({ page }) => {
  const fault = await failRpcCalls(page, callDataMatching(toFunctionSelector('getTreasuryMetrics()')));
  await openFigures(page);
  expect(fault.failed(), 'the fee view was read through the fault').toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('cf-fees-unread')).toHaveText(copy.chainFigures.feesUnread);
  await expect(page.getByTestId('cf-fees-total')).toHaveCount(0);
  await expect(page.getByTestId('cf-held')).toHaveCount(0);
  // The other views in the same aggregate still answer.
  await expect(page.getByTestId('cf-token-unread')).toHaveCount(0);
});
