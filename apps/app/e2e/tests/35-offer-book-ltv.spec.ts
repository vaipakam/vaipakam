/** #2384 (UX3-007) — an Offer Book card states the offer's loan-to-value.
 *
 *  The rule (each leg valued by its own token decimals, a borrow request's
 *  figure as a ceiling, every unknown named) is pinned by
 *  `src/data/offerLtv.test.ts`, including the mixed-decimal case the
 *  contract's pair-level view gets wrong (#2403). What the unit tier
 *  cannot show is that the card reads the protocol's LIVE prices and
 *  prints the figure they imply. So this seeds a lend offer on the fork
 *  and computes the expected ratio here, from the same two
 *  `getAssetPrice` reads and the tokens' own `decimals()`, then requires
 *  that exact percentage on the offer's row — a hard-coded number would
 *  drift with the mock feeds, and a looser match would pass on any figure.
 *
 *  The row is located by its "offer #<id>" line (advanced mode), never by
 *  position: the book holds every offer earlier specs left. It rests at a
 *  45-day tenor, outside the desk's shared bucket list, so it changes no
 *  other spec's market. */
import { test, expect } from '../lib/wallet-fixture';
import { DIAMOND, DIAMOND_ABI_VIEM, ERC20_MIN_ABI, WETH, pub } from '../lib/chain';
import { BUCKET_PREFERENCE, TLIQ, getOffer, seedDeskOffer } from '../lib/desk';

async function legValue(asset: `0x${string}`, amount: bigint): Promise<bigint> {
  const [[price, feedDecimals], tokenDecimals] = await Promise.all([
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getAssetPrice',
      args: [asset],
    }) as Promise<readonly [bigint, number]>,
    pub.readContract({ address: asset, abi: ERC20_MIN_ABI, functionName: 'decimals' }) as Promise<number>,
  ]);
  return (amount * price * 10n ** 18n) / 10n ** BigInt(feedDecimals) / 10n ** BigInt(tokenDecimals);
}

test('an offer card states its loan-to-value from live prices', async ({ launchWallet }) => {
  // A tenor OUTSIDE the desk's shared bucket list (lib/desk.ts — the
  // cross-spec bucket budget): this spec needs no empty market, only a row
  // it can find by id, so it must not spend a bucket another spec owns.
  const days = 45;
  expect((BUCKET_PREFERENCE as readonly number[]).includes(days)).toBe(false);
  const amountWeth = '0.004';
  const collateralTliq = '50';
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 731,
    amountWeth,
    collateralTliq,
    days,
  });

  // Amounts as the chain recorded them — a lend offer's card uses its full
  // amount (amountMax) against the collateral that full amount requires.
  const rec = await getOffer(offerId);
  const borrowed = await legValue(WETH, rec.amountMax as bigint);
  const collateral = await legValue(TLIQ, rec.collateralAmount as bigint);
  const bps = (borrowed * 10_000n) / collateral;
  // The app's formatBpsAsPercent: bps / 100, at most two decimals.
  const pct = `${Number((Number(bps) / 100).toFixed(2))}%`;

  const { page } = await launchWallet('borrower', { advanced: true });
  await page.goto('/offers', { waitUntil: 'domcontentloaded' });
  const row = page
    .locator('.item-row')
    .filter({ has: page.getByText(`offer #${offerId}`, { exact: false }) })
    .first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText(`loan-to-value ${pct}`, { timeout: 30_000 });
});
