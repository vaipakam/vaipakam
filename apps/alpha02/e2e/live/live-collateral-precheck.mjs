/**
 * Live review — #1112 early under-collateral warning on the borrow terms step.
 *
 * Drives the deployed post-own-borrow flow to the terms step and asserts the
 * "Before you continue —" precheck banner:
 *   • POSITIVE: 100 liquidToken2 collateral against a 100,000 liquidToken borrow
 *     breaches the borrower-offer ceiling → `createOffer` reverts
 *     `MaxLendingAboveCeiling` (one of collateralPrecheck's
 *     UNDER_COLLATERAL_ERROR_NAMES) → banner shows.
 *   • NEGATIVE: raising the collateral far past the ceiling clears the banner
 *     (the sim then reverts only "approval-needed", which #1112 downgrades).
 *
 * Read-only: the throwaway wallet never signs a state tx — the precheck is a
 * `createOffer` eth_call. It also needs NO funds/approval: the bound is checked
 * BEFORE the collateral transfer, so `MaxLendingAboveCeiling` surfaces ahead of
 * the allowance error even for a fresh wallet.
 *
 * NB the collateral must be non-trivial ($-value > 0): a dust amount
 * (e.g. 0.0001) rounds the collateral USD value to zero, which trips
 * `maxLendingForCollateral`'s no-ceiling sentinel — the offer is then accepted
 * and (correctly) no under-collateral banner shows. 100 units clears that.
 *
 * Requires the refreshed base-sepolia faucet mocks to classify Liquid on-chain
 * (issue #1118 / #1119); addresses are read from the deployments bundle so this
 * driver survives future mock refreshes.
 */
import { launch, ensureConnected, SITE, pasteAssetLive } from './driver.mjs';
import deployments from '@vaipakam/contracts/deployments.json' with { type: 'json' };

const mocks = deployments['84532']?.testnetMocks;
if (!mocks?.liquidToken || !mocks?.liquidToken2) {
  throw new Error('base-sepolia testnetMocks (liquidToken/liquidToken2) missing from deployments bundle');
}
const TLIQ = mocks.liquidToken; // asset to borrow (Liquid, Tier 1)
const MUSDC = mocks.liquidToken2; // collateral (Liquid)

const { page, done, shot, account } = await launch({ role: 'borrower' });
const step = (m) => console.log(`  · ${m}`);
try {
  console.log('wallet:', account.address, '| site:', SITE);
  step(`goto ${SITE}/borrow`);
  await page.goto(`${SITE}/borrow`, { waitUntil: 'domcontentloaded' });
  await ensureConnected(page);
  step('connected');

  // Details: borrow a large amount of tLIQ.
  await pasteAssetLive(page, 'lending-asset', TLIQ);
  await page.locator('#amount').fill('100000');
  const see = page.getByRole('button', { name: /see matching offers/i });
  await see.waitFor({ state: 'visible' });
  await see.click();
  step('saw matching offers');

  // Post our own borrow request instead of accepting a match.
  await page.getByRole('button', { name: /post my own borrow request/i }).click();
  step('post-own borrow → terms step');

  // Terms: rate + a materially-under-collateralised amount.
  await page.locator('input[placeholder="5"]').fill('5');
  await pasteAssetLive(page, 'collateral-asset', MUSDC);
  await page.locator('#collateral-amount').fill('100');

  // POSITIVE: the under-collateral banner must appear.
  const banner = page.getByText(/before you continue/i);
  await banner.waitFor({ state: 'visible', timeout: 45_000 });
  const text = (await banner.textContent())?.trim();
  console.log(`\nPASS ✓ under-collateral precheck banner shown:\n  "${text}"`);
  await shot('1112-precheck-warn');

  // NEGATIVE: sufficient collateral must CLEAR the banner (no crying wolf).
  await page.locator('#collateral-amount').fill('1000000000');
  await banner.waitFor({ state: 'hidden', timeout: 45_000 });
  console.log('PASS ✓ banner clears when collateral is sufficient');
  await shot('1112-precheck-clear');

  console.log('\nLIVE REVIEW PASSED — #1112 verified on', SITE);
  await done();
} catch (e) {
  console.error('\nLIVE REVIEW FAILED:', e.message);
  await shot('1112-precheck-fail').catch(() => {});
  await done();
  process.exit(1);
}
