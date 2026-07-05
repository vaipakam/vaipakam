/**
 * Reusable UI flow drivers — the multi-actor scenarios compose these
 * (03-accept posts as the lender before the borrower accepts; 04-repay
 * runs both before repaying). Selectors are the ones proven on live
 * Base Sepolia by the campaign harness (docs/TestScopes/
 * alpha02-harness-seed) — change them there and here together.
 */
import { expect, type Page } from '@playwright/test';
import { MOCKS, pub, DIAMOND, DIAMOND_ABI_VIEM } from './chain';
import { connectWallet } from './wallet-fixture';

/** Lender posts a 0.005 WETH lending offer against 100 tLIQ collateral. */
export async function postLenderOffer(page: Page): Promise<void> {
  await page.goto('/lend', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.locator('select').first().selectOption({ index: 1 }); // WETH
  await page.locator('input[placeholder="0.0"]').fill('0.005');
  await page.getByRole('button', { name: /see matching offers/i }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /post my own lending offer/i }).click();
  await page.waitForTimeout(800);
  await page.locator('input[placeholder="5"]').fill('10');
  // Collateral: paste the faucet tLIQ address (not in the curated list).
  await page.locator('select:visible').first().selectOption({ index: 3 });
  await page.waitForTimeout(400);
  await page.locator('input[placeholder="0x…"]').fill(MOCKS!.liquidToken as string);
  await page.waitForTimeout(1200);
  await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /continue to review/i }).click();
  await page.waitForTimeout(2000);
  await page.locator('input[type="checkbox"]:visible').first().check();
  const post = page.getByRole('button', { name: /post lending offer/i });
  await expect(post).toBeEnabled();
  await post.click();
  await expect(page.getByText(/lending offer posted/i)).toBeVisible({
    timeout: 90_000,
  });
}

/** Borrower guided-match accepts the open 0.005 WETH offer. */
export async function acceptAsBorrower(page: Page): Promise<void> {
  await page.goto('/borrow', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await page.locator('select').first().selectOption({ index: 1 }); // WETH
  await page.locator('input[placeholder="0.0"]').fill('0.005');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /see matching offers/i }).click();
  await page.waitForTimeout(2500);
  const choose = page.getByRole('button', { name: /^choose$/i }).first();
  await expect(choose).toBeVisible({ timeout: 20_000 });
  await choose.click();
  await page.waitForTimeout(2500);
  await page.locator('input[type="checkbox"]:visible').first().check();
  const accept = page.getByRole('button', { name: /borrow this now/i });
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(page.getByText(/loan opened|what happens next/i)).toBeVisible({
    timeout: 120_000,
  });
}

/** Newest loan id where `who` is the given side, from the chain's own
 *  position enumeration (what the app's claims discovery reads too). */
export async function newestLoanIdFor(
  who: `0x${string}`,
  side: 'lender' | 'borrower',
): Promise<bigint> {
  const [lenderIds, borrowerIds] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserPositionLoansPaginated',
    args: [who, 0n, 100n],
  })) as [readonly bigint[], readonly bigint[], bigint];
  const ids = side === 'lender' ? lenderIds : borrowerIds;
  if (!ids.length) throw new Error(`no ${side} loans for ${who}`);
  return ids.reduce((a, b) => (b > a ? b : a));
}
