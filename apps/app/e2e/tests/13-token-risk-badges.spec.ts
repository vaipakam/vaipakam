/** #1036 badges slice — browsing-surface token-risk badges + guided-
 *  match exclusion, on Anvil.
 *
 *  GoPlus doesn't index test networks, so on the standard fork-tier
 *  server the screen reports 'unsupported' and badges are structurally
 *  invisible (the control case pins exactly that posture: no badge
 *  noise on testnets). To exercise the REAL badge/exclusion logic the
 *  spec spawns its own dev server with VITE_GOPLUS_EXTRA_CHAINS=84532
 *  (the test-only widening knob) and route-mocks the GoPlus origin per
 *  test — block row, warn row, and a 500 — against an offer the spec
 *  itself posts (WETH principal, non-curated tLIQ collateral).
 *
 *  Asserted properties:
 *  1. BLOCK: the Offer Book row wears "Risk flagged", and the guided
 *     matcher EXCLUDES the offer from the top 5 while saying how many
 *     it hid (never a silently thinner list).
 *  2. WARN: the row/card wears "Caution" and stays listed — warn is
 *     disclosure, not exclusion.
 *  3. UNREACHABLE: the row wears "Not screened" and stays listed —
 *     browse tier is early-warning fail-open (the accept gate is the
 *     fail-closed enforcement point, covered by the #1036 gate work).
 *  4. CONTROL: the standard server (chain unsupported) shows no risk
 *     badges at all.
 *  5. PENDING (#2535): while the screen has not answered, the guided
 *     matcher lists the offer as "Checking" with Choose disabled — a
 *     recommendation is never offered ahead of its screen — and opens it
 *     once the answer lands.
 */
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import type { Page } from '@playwright/test';
import {
  OFFER_AMOUNT_WETH,
  pickCuratedAsset,
  postLenderOffer,
  newestOfferIdFor,
} from '../lib/flows';
import { WETH } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import {
  goPlusRow,
  mockGoPlus,
  startGoPlusServer,
  type GoPlusServer,
} from '../lib/goplus';

const BADGE_PORT = 4175;

let badgeServer: GoPlusServer | undefined;
let BADGE_BASE = '';

test.beforeAll(async () => {
  badgeServer = await startGoPlusServer(BADGE_PORT);
  BADGE_BASE = badgeServer.base;
});

test.afterAll(() => {
  badgeServer?.stop();
});

/** Drive the borrow guided matcher on `base` to the offers step. */
async function openGuidedMatches(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/borrow`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await pickCuratedAsset(page, 'lending-asset', WETH);
  await page.locator('input[placeholder="0.0"]').fill(OFFER_AMOUNT_WETH);
  const see = page.getByRole('button', { name: /see matching offers/i });
  await expect(see).toBeEnabled({ timeout: 30_000 });
  await see.click();
}

function bookRowFor(page: Page, offerId: bigint) {
  return page
    .locator('.item-row')
    .filter({ has: page.getByText(`offer #${offerId}`, { exact: false }) })
    .first();
}

test('a hard-flagged offer wears "Risk flagged" on the book and is excluded from guided matching', async ({
  launchWallet,
}) => {
  // Post the offer through the STANDARD server (chain unsupported →
  // the paste-branch gate stays open on testnets), then browse it on
  // the badge server where the mocked screen flags its collateral.
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);

  const viewer = await launchWallet('borrower', { advanced: true });
  await mockGoPlus(viewer.page, () => ({ row: goPlusRow({ is_honeypot: '1' }) }));

  // Book row: badge visible (advanced mode renders the offer id).
  await viewer.page.goto(`${BADGE_BASE}/offers`, { waitUntil: 'domcontentloaded' });
  const row = bookRowFor(viewer.page, offerId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Risk flagged')).toBeVisible({ timeout: 30_000 });

  // Human-units rule (user directive 2026-07-22): the advanced detail
  // line quotes the rate as PERCENT ("rate 9%" for this suite's 9%
  // lender offer) — raw "900 bps" must never appear as visible text.
  await expect(row).toContainText('rate 9%');
  await expect(row).not.toContainText('bps');

  // Guided matcher: the offer is withheld from the top 5, and the
  // list says how many were hidden.
  await openGuidedMatches(viewer.page, BADGE_BASE);
  await expect(
    viewer.page.getByText(/hidden because an independent security check/i),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    viewer.page
      .locator('.item-row')
      .filter({ has: viewer.page.getByText(`offer #${offerId}`) }),
  ).toHaveCount(0);
});

test('a warn-tier offer stays listed wearing "Caution"', async ({
  launchWallet,
}) => {
  // Test 1's offer (specs in a file share the fork sequentially).
  const offerId = await newestOfferIdFor(accountFor('lender').address);

  const viewer = await launchWallet('borrower', { advanced: true });
  await mockGoPlus(viewer.page, () => ({ row: goPlusRow({ slippage_modifiable: '1' }) }));

  await viewer.page.goto(`${BADGE_BASE}/offers`, { waitUntil: 'domcontentloaded' });
  const row = bookRowFor(viewer.page, offerId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Caution')).toBeVisible({ timeout: 30_000 });

  // Warn is disclosure, not exclusion: the card is still offered.
  await openGuidedMatches(viewer.page, BADGE_BASE);
  const card = viewer.page
    .locator('.item-row')
    .filter({ has: viewer.page.getByText(`offer #${offerId}`) })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Caution')).toBeVisible();
});

test('an unreachable screen shows "Not screened" and keeps the offer listed', async ({
  launchWallet,
}) => {
  const offerId = await newestOfferIdFor(accountFor('lender').address);

  const viewer = await launchWallet('borrower', { advanced: true });
  await mockGoPlus(viewer.page, () => ({ status: 500 }));

  await viewer.page.goto(`${BADGE_BASE}/offers`, { waitUntil: 'domcontentloaded' });
  const row = bookRowFor(viewer.page, offerId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Not screened')).toBeVisible({ timeout: 30_000 });
});

test('a guided match whose screen has not answered is "Checking" and cannot be chosen until it has (#2535)', async ({
  launchWallet,
}) => {
  const offerId = await newestOfferIdFor(accountFor('lender').address);

  const viewer = await launchWallet('borrower', { advanced: true });
  let release!: () => void;
  const answered = new Promise<void>((r) => {
    release = r;
  });
  await mockGoPlus(viewer.page, () => ({ row: goPlusRow() }), answered);

  await openGuidedMatches(viewer.page, BADGE_BASE);
  const card = viewer.page
    .locator('.item-row')
    .filter({ has: viewer.page.getByText(`offer #${offerId}`) })
    .first();
  const choose = card.getByRole('button', { name: /^choose$/i });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Checking', { exact: true })).toBeVisible();
  await expect(choose).toBeDisabled();

  // The screen answers clean: the hold lifts, and nothing else is shown
  // (a clean verdict wears no badge).
  release();
  await expect(card.getByText('Checking', { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(choose).toBeEnabled();
});

test('control: the standard server (unscreened chain) shows no risk badges', async ({
  launchWallet,
}) => {
  const viewer = await launchWallet('borrower', { advanced: true });
  await viewer.page.goto('/offers', { waitUntil: 'domcontentloaded' });
  // The book itself must have rendered rows before "no badges" means
  // anything.
  await expect(viewer.page.locator('.item-row').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(viewer.page.getByText('Risk flagged')).toHaveCount(0);
  await expect(viewer.page.getByText('Not screened')).toHaveCount(0);
});
