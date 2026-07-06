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
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import {
  OFFER_AMOUNT_WETH,
  pickCuratedAsset,
  postLenderOffer,
  newestOfferIdFor,
} from '../lib/flows';
import { ANVIL_URL } from '../lib/anvil';
import { WETH } from '../lib/chain';
import { accountFor } from '../lib/wallets';

const BADGE_PORT = 4175;
const BADGE_BASE = `http://127.0.0.1:${BADGE_PORT}`;
const STUB_PORT = Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788);

let badgeServer: ChildProcess | undefined;

test.beforeAll(async () => {
  const stale = await fetch(BADGE_BASE).then(
    () => true,
    () => false,
  );
  if (stale) {
    throw new Error(
      `something is already listening on ${BADGE_BASE} — kill it before running the badges spec`,
    );
  }
  badgeServer = spawn(
    'node',
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(BADGE_PORT),
      '--strictPort',
    ],
    {
      env: {
        ...process.env,
        ALPHA02_E2E: '1',
        VITE_DEFAULT_CHAIN_ID: '84532',
        VITE_BASE_SEPOLIA_RPC_URL: ANVIL_URL,
        VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
        VITE_GOPLUS_EXTRA_CHAINS: '84532',
      },
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (badgeServer.exitCode !== null) {
      throw new Error(
        `badges vite exited with ${badgeServer.exitCode} — port ${BADGE_PORT} already in use?`,
      );
    }
    try {
      const res = await fetch(BADGE_BASE);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('badges vite not ready');
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(() => {
  badgeServer?.kill('SIGTERM');
});

/** A fully-evaluated GoPlus row (every check '0'/known) with
 *  overrides — unknown/missing fields would add "could not be
 *  evaluated" noise the assertions don't want. */
function goPlusRow(overrides: Record<string, unknown> = {}) {
  return {
    is_open_source: '1',
    is_honeypot: '0',
    cannot_sell_all: '0',
    cannot_buy: '0',
    buy_tax: '0',
    sell_tax: '0',
    transfer_tax: '0',
    is_mintable: '0',
    owner_change_balance: '0',
    is_blacklisted: '0',
    transfer_pausable: '0',
    is_whitelisted: '0',
    is_anti_whale: '0',
    anti_whale_modifiable: '0',
    trading_cooldown: '0',
    hidden_owner: '0',
    can_take_back_ownership: '0',
    is_proxy: '0',
    selfdestruct: '0',
    slippage_modifiable: '0',
    personal_slippage_modifiable: '0',
    external_call: '0',
    fake_token: null,
    ...overrides,
  };
}

/** Answer every GoPlus request (single or comma-batched) with `row`
 *  for each requested address — or an HTTP `status` failure. */
async function mockGoPlus(
  page: Page,
  row: Record<string, unknown> | null,
  status = 200,
): Promise<void> {
  await page.route('https://api.gopluslabs.io/**', async (route) => {
    if (row === null) {
      await route.fulfill({ status, body: 'mocked failure' });
      return;
    }
    const url = new URL(route.request().url());
    const addrs = (url.searchParams.get('contract_addresses') ?? '')
      .split(',')
      .filter(Boolean);
    const result = Object.fromEntries(addrs.map((a) => [a.toLowerCase(), row]));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 1, message: 'ok', result }),
    });
  });
}

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
  await mockGoPlus(viewer.page, goPlusRow({ is_honeypot: '1' }));

  // Book row: badge visible (advanced mode renders the offer id).
  await viewer.page.goto(`${BADGE_BASE}/offers`, { waitUntil: 'domcontentloaded' });
  const row = bookRowFor(viewer.page, offerId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Risk flagged')).toBeVisible({ timeout: 30_000 });

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
  await mockGoPlus(viewer.page, goPlusRow({ slippage_modifiable: '1' }));

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
  await mockGoPlus(viewer.page, null, 500);

  await viewer.page.goto(`${BADGE_BASE}/offers`, { waitUntil: 'domcontentloaded' });
  const row = bookRowFor(viewer.page, offerId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Not screened')).toBeVisible({ timeout: 30_000 });
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
