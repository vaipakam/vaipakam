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

/** Choose a SelectMenu row by its stable data-value. The app's
 *  dropdowns are the custom SelectMenu (button + listbox), not native
 *  <select> — `selectOption` does not apply. Rows carry `data-value`
 *  precisely so drivers never select positionally (the suggested
 *  token rows hydrate from live symbol reads; index-based selection
 *  raced that hydration in run 3 and landed on the paste row). */
export async function chooseMenuValue(
  page: Page,
  menuId: string,
  value: string,
): Promise<void> {
  await page.locator(`#${menuId}`).click();
  // `i` flag: token rows carry the suggested list's checksum casing,
  // the deployments bundle may differ.
  const row = page.locator(`[role="listbox"] [data-value="${value}" i]`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

/** Pick a suggested (curated / faucet) token by ADDRESS. Rows hydrate
 *  from live symbol reads — chooseMenuValue waits for the row rather
 *  than racing the hydration. */
export async function pickCuratedAsset(
  page: Page,
  pickerId: string,
  address: string,
): Promise<void> {
  await chooseMenuValue(page, pickerId, address);
}

/** Open an AssetPicker's paste-address branch and fill `address`.
 *  '__custom__' is the picker's stable sentinel row value — never
 *  positional (the suggested rows above it hydrate asynchronously). */
export async function pasteAsset(
  page: Page,
  pickerId: string,
  address: string,
): Promise<void> {
  await chooseMenuValue(page, pickerId, '__custom__');
  // The paste input renders inside the same .field as the menu.
  await page
    .locator(`.field:has(#${pickerId}) input[placeholder="0x…"]`)
    .fill(address);
}

/** The suite's principal amount. DISTINCTIVE on purpose: the guided
 *  matcher ranks by |offer amount - desired amount| FIRST, so an
 *  offer at an amount nothing on the forked live book uses ranks at
 *  distance 0 for a borrower asking exactly this amount — top-5
 *  placement is then deterministic against book drift (rate is only
 *  the tiebreak among same-amount offers, i.e. this run's own).
 *  Offers created by CI runs live only on the disposable fork, so
 *  they can never accumulate on the real testnet book. */
export const OFFER_AMOUNT_WETH = '0.00537';

/** Tick the consent box and wait for the sign button to open. Late
 *  disclosures (the live grace-bucket / liquidity / linked-loan reads
 *  landing after the tick) legitimately RESET the checkbox — that's
 *  the app's re-consent rule, not a bug — so keep re-ticking until
 *  every canSign gate clears or the deadline passes. */
export async function consentAndWaitEnabled(page: Page, button: Locator): Promise<void> {
  await expect(async () => {
    const consent = page.locator('input[type="checkbox"]:visible').first();
    if (!(await consent.isChecked())) await consent.check();
    expect(await button.isEnabled()).toBe(true);
  }).toPass({ timeout: 60_000, intervals: [500, 1_000] });
}

/** Drive the lender post-offer form to the REVIEW card and return the
 *  sign button — no consent tick, no click. The kill-switch and
 *  dry-run specs assert on the review itself; `base` targets an
 *  alternate dev server (the kill-switch spec's VITE_DISABLED_FLOWS
 *  instance on its own port). */
export async function lenderOfferFormToReview(
  page: Page,
  base = '',
): Promise<Locator> {
  await page.goto(`${base}/lend`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await pickCuratedAsset(page, 'lending-asset', WETH);
  await page.locator('input[placeholder="0.0"]').fill(OFFER_AMOUNT_WETH);
  const see = page.getByRole('button', { name: /see matching offers/i });
  await expect(see).toBeEnabled({ timeout: 30_000 });
  await see.click();
  await page.getByRole('button', { name: /post my own lending offer/i }).click();
  await page.locator('input[placeholder="5"]').fill('9');
  // Collateral: paste the faucet tLIQ address (not in the curated list).
  await pasteAsset(page, 'collateral-asset', MOCKS!.liquidToken as string);
  await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
  const cont = page.getByRole('button', { name: /continue to review/i });
  await expect(cont).toBeEnabled({ timeout: 15_000 });
  await cont.click();
  return page.getByRole('button', { name: /post lending offer/i });
}

/** Lender posts an OFFER_AMOUNT_WETH lending offer against 100 tLIQ
 *  collateral. */
export async function postLenderOffer(page: Page): Promise<void> {
  const post = await lenderOfferFormToReview(page);
  await consentAndWaitEnabled(page, post);
  await post.click();
  await expect(page.getByText(/lending offer posted/i)).toBeVisible({
    timeout: 90_000,
  });
}

/** Shared review-step tail of both accept paths: consent (re-ticked
 *  through late-disclosure resets), sign, wait for the done card. */
async function signAcceptReview(page: Page): Promise<void> {
  const accept = page.getByRole('button', { name: /borrow this now/i });
  await expect(accept).toBeVisible({ timeout: 30_000 });
  await consentAndWaitEnabled(page, accept);
  await accept.click();
  await expect(page.getByText(/loan opened|what happens next/i)).toBeVisible({
    timeout: 120_000,
  });
}

/** Borrower accepts a SPECIFIC offer via the offer-book deep link
 *  (?offer=<id>) — the Offer Book take-an-offer journey (the card CTA
 *  reads "Borrow this" on a lender offer / "Fund this request" on a
 *  borrow request, UX-018). */
export async function acceptAsBorrower(
  page: Page,
  offerId: bigint,
): Promise<void> {
  await page.goto(`/borrow?offer=${offerId}`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await signAcceptReview(page);
}

/** Borrower accepts through the GUIDED MATCHER (flow 4.1): details →
 *  See matching offers → the card for `offerId` → review → sign. The
 *  fork inherits Base Sepolia's whole open book (stale look-alike
 *  offers included — run 3's borrower picked one whose collateral it
 *  didn't hold), so the card is selected by its "offer #<id>" line,
 *  never positionally, and OFFER_AMOUNT_WETH guarantees top-5
 *  placement (see its doc). */
export async function acceptViaGuidedMatch(
  page: Page,
  offerId: bigint,
): Promise<void> {
  await page.goto('/borrow', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await pickCuratedAsset(page, 'lending-asset', WETH);
  await page.locator('input[placeholder="0.0"]').fill(OFFER_AMOUNT_WETH);
  const see = page.getByRole('button', { name: /see matching offers/i });
  await expect(see).toBeEnabled({ timeout: 30_000 });
  await see.click();
  const card = page
    .locator('.item-row')
    .filter({ has: page.getByText(`offer #${offerId}`) })
    .first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^choose$/i }).click();
  await signAcceptReview(page);
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
