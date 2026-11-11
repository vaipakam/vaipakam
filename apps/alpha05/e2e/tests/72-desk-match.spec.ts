/**
 * The desk's match band (matrix OFF-63). A lender offers 0.05 WETH at 4%
 * to 5% a year and a borrower asks for 0.05 WETH at 4.5% to 5.5% a year,
 * on the WETH against tLIQ 14-day market, so the two sides overlap and
 * their rate ranges meet. A third wallet opens the desk: with matching
 * switched off on the network the band says so instead of disappearing.
 * Once the admin switches matching on, the band offers the pair the protocol
 * confirms, with the amount, the middle rate, the collateral, the most the
 * sender's share can be and the matching capacity it counts against. The
 * review states that the loan belongs to the two who posted the offers and
 * that the share is paid only if the match lands; the match opens the loan
 * on the chain, the finish card measures the share that reached the
 * wallet, and the band then finds nothing to match. Runs on the desktop
 * and the phone project; the chain is reverted after each test.
 */
import { postBorrowRequest, postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

/** Connect once the page has drawn either its Connect button or the match
 *  band: the shared helper reads a missing button as already connected, and
 *  after a reload the wallet may reconnect by itself. */
async function connect(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Connect wallet' }).or(page.getByTestId('desk-match')).first()).toBeVisible({ timeout: 30_000 });
  await connectWallet(page);
}

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the match band states the switch, offers the pair the protocol confirms, and matches it on the chain', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, string>).liquidToken!;
  // The lender takes 4% to 5% a year and the borrower pays 4.5% to 5.5%: the
  // ranges meet from 4.5% to 5%, so the protocol matches at 4.75%.
  const ask = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 400, rateMaxBps: 500, days: 14 });
  const bid = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 450, rateMaxBps: 550, days: 14 });
  // The deploy switches matching on; switch it off for the first look.
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [false]);
  const market = `${WETH.toLowerCase()}-${tliq.toLowerCase()}-14`;

  const { page } = await launchWallet('visitor', { preAuthorized: false, advanced: true });
  await page.goto(`/desk?market=${market}`);
  await connect(page);
  await expect(page.getByTestId('desk-crossed')).toBeVisible({ timeout: 60_000 });

  // With matching switched off, the band says so.
  const band = page.getByTestId('desk-match');
  await expect(band).toHaveAttribute('data-state', 'switch-off', { timeout: 60_000 });
  await expect(page.getByTestId('desk-match-off')).toContainText('Matching is switched off on this network');
  await expect(band.getByTestId('desk-match-open')).toHaveCount(0);
  await fitsWidth(page);

  // Switched on, the band offers the confirmed pair.
  await sc.diamondWrite('admin', 'setPartialFillEnabled', [true]);
  await page.reload();
  await connect(page);
  const offered = band.getByTestId('desk-match-pair');
  await expect(offered).toHaveAttribute('data-pair', `${ask}-${bid}`, { timeout: 60_000 });
  await expect(offered).toContainText(`Lender’s offer #${ask}`);
  await expect(offered).toContainText(`borrower’s request #${bid}`);
  await expect(band.getByTestId('desk-match-terms')).toHaveText('0.05 WETH at 4.75% a year for 14 days; the borrower locks 250 tLIQ.');
  // 0.2% of 0.05 WETH is the fee; 1% of the fee is the most the share can be.
  await expect(band.getByTestId('desk-match-share')).toHaveText('At most 0.000001 WETH: 1% of the initiation fee the borrower pays.');
  await expect(band.getByTestId('desk-match-capacity')).toHaveText(
    /^(A match counts one fill against your wallet’s matching capacity\.|No matching-capacity limit is in force on this network\.)$/,
  );
  await fitsWidth(page);

  await band.getByTestId('desk-match-open').click();
  const panel = band.getByTestId('desk-match-panel');
  await expect(panel).toContainText('Review this match', { timeout: 60_000 });
  await expect(panel).toContainText('4.75% a year, the middle of the rates both sides accept');
  await expect(panel).toContainText('The gas. None of your funds move into the loan.');
  await expect(panel).toContainText('The loan belongs to the lender and the borrower who posted these offers.');
  await expect(panel).toContainText('Your share is paid only if the match lands.');
  await fitsWidth(page);

  await panel.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = panel.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(/Loan #\d+ opened: 0\.05 WETH at 4\.75% a year/);
  await expect(finish).toContainText('Your share arrived: 0.000001 WETH');

  // The chain holds the request as taken; the band finds nothing to match
  // once the ladder follows, and the finish card stays until it is closed.
  const taken = await sc.read<Record<string, unknown>>('getOffer', [bid]);
  expect(taken.accepted).toBe(true);
  await expect(band).toHaveAttribute('data-state', 'no-overlap', { timeout: 90_000 });
  await expect(finish).toBeVisible();
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await fitsWidth(page);
});
