/**
 * Reusable UI flow drivers — the multi-actor scenarios compose these
 * (03-accept posts as the lender before the borrower accepts; 04-repay
 * runs both before repaying). Selectors are the ones proven on live
 * Base Sepolia by the campaign harness (docs/TestScopes/
 * alpha02-harness-seed) — change them there and here together.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { MOCKS, WETH, pub, DIAMOND, DIAMOND_ABI_VIEM } from './chain';
import { connectWallet } from './wallet-fixture';

/** Pick a curated token by ADDRESS. The AssetPicker's curated options
 *  hydrate from live symbol reads, so on a cold page the select briefly
 *  holds only "Choose an asset…" + "Paste a token address…" — run 3's
 *  index-based selection raced that hydration and landed on the paste
 *  row, leaving the form address empty forever. */
export async function pickCuratedAsset(
  page: Page,
  pickerId: string,
  address: string,
): Promise<void> {
  // `i` flag: option values carry the curated list's checksum casing,
  // the deployments bundle may differ.
  const opt = page.locator(`#${pickerId} option[value="${address}" i]`);
  await expect(opt).toBeAttached({ timeout: 30_000 });
  const exact = await opt.getAttribute('value');
  await page.locator(`#${pickerId}`).selectOption(exact!);
}

/** Open an AssetPicker's paste-address branch and fill `address`.
 *  '__custom__' is the picker's stable sentinel option value — never
 *  positional (the curated rows above it hydrate asynchronously). */
async function pasteAsset(
  page: Page,
  pickerId: string,
  address: string,
): Promise<void> {
  await page.locator(`#${pickerId}`).selectOption('__custom__');
  await page.locator(`#${pickerId} ~ input[placeholder="0x…"]`).fill(address);
}

/** Tick the consent box and wait for the sign button to open. Late
 *  disclosures (the live grace-bucket / liquidity / linked-loan reads
 *  landing after the tick) legitimately RESET the checkbox — that's
 *  the app's re-consent rule, not a bug — so keep re-ticking until
 *  every canSign gate clears or the deadline passes. */
async function consentAndWaitEnabled(page: Page, button: Locator): Promise<void> {
  await expect(async () => {
    const consent = page.locator('input[type="checkbox"]:visible').first();
    if (!(await consent.isChecked())) await consent.check();
    expect(await button.isEnabled()).toBe(true);
  }).toPass({ timeout: 60_000, intervals: [500, 1_000] });
}

/** Lender posts a 0.005 WETH lending offer against 100 tLIQ collateral. */
export async function postLenderOffer(page: Page): Promise<void> {
  await page.goto('/lend', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await pickCuratedAsset(page, 'lending-asset', WETH);
  await page.locator('input[placeholder="0.0"]').fill('0.005');
  const see = page.getByRole('button', { name: /see matching offers/i });
  await expect(see).toBeEnabled({ timeout: 30_000 });
  await see.click();
  await page.getByRole('button', { name: /post my own lending offer/i }).click();
  await page.locator('input[placeholder="5"]').fill('10');
  // Collateral: paste the faucet tLIQ address (not in the curated list).
  await pasteAsset(page, 'collateral-asset', MOCKS!.liquidToken as string);
  await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
  const cont = page.getByRole('button', { name: /continue to review/i });
  await expect(cont).toBeEnabled({ timeout: 15_000 });
  await cont.click();
  const post = page.getByRole('button', { name: /post lending offer/i });
  await consentAndWaitEnabled(page, post);
  await post.click();
  await expect(page.getByText(/lending offer posted/i)).toBeVisible({
    timeout: 90_000,
  });
}

/** Borrower accepts a SPECIFIC offer via the offer-book deep link
 *  (?offer=<id>). Deliberately not the guided matcher: the fork
 *  inherits Base Sepolia's whole open offer book, so matching
 *  legitimately surfaces stale look-alike offers (run 3's borrower
 *  picked one whose collateral it didn't hold) — the deep link is the
 *  deterministic route to the offer the test just created, and is
 *  itself a first-class flow (Alpha02RegressionFlows §offer book). */
export async function acceptAsBorrower(
  page: Page,
  offerId: bigint,
): Promise<void> {
  await page.goto(`/borrow?offer=${offerId}`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  const accept = page.getByRole('button', { name: /borrow this now/i });
  await expect(accept).toBeVisible({ timeout: 30_000 });
  await consentAndWaitEnabled(page, accept);
  await accept.click();
  await expect(page.getByText(/loan opened|what happens next/i)).toBeVisible({
    timeout: 120_000,
  });
}

/** Newest offer id created by `creator`, from the chain's own
 *  enumeration — how a spec learns the id postLenderOffer just minted
 *  (roles are reused across scenarios and retries, so "newest" is the
 *  one this call site created). */
export async function newestOfferIdFor(creator: `0x${string}`): Promise<bigint> {
  const [ids] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserOffersPaginated',
    args: [creator, 0n, 200n],
  })) as [readonly bigint[], bigint];
  if (!ids.length) throw new Error(`no offers for ${creator}`);
  return ids.reduce((a, b) => (b > a ? b : a));
}

/** Newest loan id where `who` is the given side. The chain view
 *  returns `(loanIds, positionTokenIds, totalBalance)` — loans whose
 *  position NFT the wallet HOLDS, both roles mixed (run 4 failed by
 *  misreading tuple slot 2 as borrower loan ids — those are NFT token
 *  ids). Role is a per-loan field, so filter via getLoanDetails. */
export async function newestLoanIdFor(
  who: `0x${string}`,
  side: 'lender' | 'borrower',
): Promise<bigint> {
  const [loanIds] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getUserPositionLoansPaginated',
    args: [who, 0n, 100n],
  })) as [readonly bigint[], readonly bigint[], bigint];
  let newest: bigint | undefined;
  for (const id of loanIds) {
    const loan = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getLoanDetails',
      args: [id],
    })) as { lender: string; borrower: string };
    const party = side === 'lender' ? loan.lender : loan.borrower;
    if (party.toLowerCase() !== who.toLowerCase()) continue;
    if (newest === undefined || id > newest) newest = id;
  }
  if (newest === undefined) throw new Error(`no ${side} loans for ${who}`);
  return newest;
}
