/** #1058/#1059 — the advisory pre-sign dry-run footer, on Anvil.
 *
 *  Regression test for the #1059 classifier bug: with a healthy RPC
 *  and a buildable offer whose only blocker is the not-yet-granted
 *  deposit allowance, the footer must render a truthful verdict —
 *  the benign approval note (or "passed" if an allowance already
 *  stands) — never the cry-wolf would-fail and never the
 *  silent-unavailable state.
 *
 *  The LENDING leg is deliberately the faucet's OZ-mock tLIQ, not
 *  curated WETH: WETH9's messageless `require` reverts with EMPTY
 *  data, which is honestly unclassifiable (the first CI run proved
 *  it — the footer says would-fail, which is TRUE but useless as a
 *  fixture). The OZ mock reverts with the ERC20InsufficientAllowance
 *  custom error — the exact decodable shape live users hit with the
 *  real testnet mocks, i.e. the path #1059 fixed. The deployed-RPC
 *  half is re-checked live by `e2e/live/live-dryrun-review.mjs`.
 */
import { test, expect } from '../lib/wallet-fixture';
import { connectWallet } from '../lib/wallet-fixture';
import { consentAndWaitEnabled, pasteAsset, pickCuratedAsset } from '../lib/flows';
import { MOCKS, WETH } from '../lib/chain';

test('review renders a truthful dry-run verdict', async ({ launchWallet }) => {
  const { page } = await launchWallet('lender');
  await page.goto('/lend', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  // Lend the OZ-mock tLIQ (paste branch) against curated WETH.
  //
  // TERMS MUST CLEAR THE MIN-COLLATERAL FLOOR (#1007 S11): WETH on
  // Base Sepolia is Liquid at tier 0, which since S11 gets a REAL
  // floor (tier-1 threshold, 80%) instead of the old no-floor
  // sentinel. The original 25 tLIQ / 0.01 WETH terms ($50k vs $20 at
  // the pinned $2,000 mock feeds) only ever passed because the floor
  // was dormant on the pre-S11 testnet Diamond — the moment the live
  // Diamond picked up S11 (2026-07-06 facet refresh) the dry run
  // truthfully reverted MinCollateralBelowFloor. Both mock feeds are
  // pinned EQUAL by DeployTestnetMocks (its pool value-balance guard
  // requires it), so the floor in WETH units is lendAmount × hfFloor
  // / 0.80 of the tLIQ amount: 0.01 tLIQ ⇒ floor ≈ 0.019 WETH;
  // 0.05 WETH gives ~2.7× margin and stays under every LTV cap.
  await pasteAsset(page, 'lending-asset', MOCKS!.liquidToken as string);
  await page.locator('input[placeholder="0.0"]').fill('0.01');
  const see = page.getByRole('button', { name: /see matching offers/i });
  await expect(see).toBeEnabled({ timeout: 30_000 });
  await see.click();
  await page.getByRole('button', { name: /post my own lending offer/i }).click();
  await page.locator('input[placeholder="5"]').fill('9');
  await pickCuratedAsset(page, 'collateral-asset', WETH);
  await page.locator('input[placeholder="0.0"]:visible').last().fill('0.05');
  const cont = page.getByRole('button', { name: /continue to review/i });
  await expect(cont).toBeEnabled({ timeout: 15_000 });
  await cont.click();
  const post = page.getByRole('button', { name: /post lending offer/i });
  // The dry run only builds once consent is ticked (consent=false
  // would just preview RiskAndTermsConsentRequired — #1058 round 1).
  await consentAndWaitEnabled(page, post);

  // A truthful verdict must appear…
  await expect(
    page.getByText(/Dry run passed|token approval will be requested first/),
  ).toBeVisible({ timeout: 30_000 });
  // …and the false-alarm forms must not (the #1059 regression, and
  // the silent-unavailable state that would mean the eth_call never
  // reached Anvil).
  await expect(page.getByText(/just failed with/)).toHaveCount(0);
  await expect(page.getByText(/dry run isn’t available/)).toHaveCount(0);
});
