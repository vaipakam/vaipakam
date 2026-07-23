/** #1355 (M2 PR-8) — the Full VPFI tariff opt-in on the accept review.
 *
 *  Three behaviours, in one serial spec (workers=1; the kill-switch is
 *  chain-global so the spec restores it in a finally):
 *
 *  1. DARK DEFAULT — while `feeEntitlementEnabled` is false (the
 *     deployed posture) the opt-in control does not render at all: a
 *     presented Full authorization while dark is a failed opt-in on
 *     chain, so a dark deploy must not invite one.
 *  2. STRICT FULL FAILS CLOSED — with the feature enabled, a borrower
 *     who opts into Full WITHOUT allowing a downgrade, and whose vault
 *     holds no VPFI, is REJECTED at accept (the signed `acceptorFull`
 *     reaches the contract and `FeeEntitlementFullOptInFailed`
 *     reverts the whole accept — nothing moves). This is the
 *     discriminating leg: if the opt-in were silently dropped from the
 *     signed terms, this accept would succeed.
 *  3. DOWNGRADE OPENS NON-FULL — same conditions but with the
 *     downgrade box ticked: the loan opens, and the stamped record
 *     shows a non-Full borrower mode with zero tariff absorbed.
 */
import type { Page } from '@playwright/test';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { encodeFunctionData } from 'viem';
import {
  postLenderOffer,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { anvilRpc, setBalance } from '../lib/anvil';
import { pub, ADMIN, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

const FEE_MODE_FULL = 2;

/** Flip the fee-entitlement kill-switch as the testnet admin. */
async function setFeeEntitlementEnabled(enabled: boolean): Promise<void> {
  await anvilRpc('anvil_impersonateAccount', [ADMIN]);
  await setBalance(ADMIN, 10n ** 18n);
  const send = async (fn: string, args: readonly unknown[]) => {
    const data = encodeFunctionData({
      abi: DIAMOND_ABI_VIEM,
      functionName: fn,
      args: args as unknown[],
    });
    const hash = await anvilRpc<`0x${string}`>('eth_sendTransaction', [
      { from: ADMIN, to: DIAMOND, data, gas: '0x2dc6c0' },
    ]);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`${fn} reverted`);
    }
  };
  try {
    if (enabled) {
      // Enabling requires the canonical-VPFI stamp; the deploy sets it
      // on Base Sepolia, but assert-don't-assume on a fork.
      try {
        await send('setFeeEntitlementEnabled', [true]);
      } catch {
        await send('setCanonicalVPFIChain', [true]);
        await send('setFeeEntitlementEnabled', [true]);
      }
    } else {
      await send('setFeeEntitlementEnabled', [false]);
    }
  } finally {
    await anvilRpc('anvil_stopImpersonatingAccount', [ADMIN]);
  }
}

/** Open the accept review for `offerId` as the connected borrower.
 *  The deep link resolves the offer through the indexer stub, which
 *  re-derives from the forked chain per request but can transiently
 *  lag/rate-limit right after the offer lands — on a miss the flow
 *  shows the "couldn't find that offer" alert, so retry with a reload
 *  until the review renders (the offer IS on chain). */
async function openAcceptReview(page: Page, offerId: bigint): Promise<void> {
  await page.goto(`/borrow?offer=${offerId}`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  const accept = page.getByRole('button', { name: /borrow this now/i });
  const notFound = page.getByText(/find that offer/i);
  await expect(async () => {
    if (await notFound.isVisible().catch(() => false)) {
      // Re-GOTO the deep link, never reload(): on a miss the flow
      // strips ?offer= from the URL, so a reload would land on the
      // plain details page and spin there forever.
      await page.goto(`/borrow?offer=${offerId}`, {
        waitUntil: 'domcontentloaded',
      });
      await connectWallet(page);
    }
    expect(await accept.isVisible()).toBe(true);
  }).toPass({ timeout: 120_000, intervals: [2_000, 5_000] });
}

/** Tick the risk-and-terms consent SPECIFICALLY (never `.first()` —
 *  with the tariff card rendered, the first visible checkbox is the
 *  opt-in, not the consent). */
async function tickConsent(page: Page): Promise<void> {
  const consent = page
    .locator('label')
    .filter({ hasText: /I understand and agree/i })
    .locator('input[type="checkbox"]');
  await expect(async () => {
    if (!(await consent.isChecked())) await consent.check();
  }).toPass({ timeout: 60_000, intervals: [500, 1_000] });
}

test('Full tariff opt-in: dark default hides it; strict Full fails closed; downgrade opens non-Full', async ({
  launchWallet,
}) => {
  test.setTimeout(600_000);

  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  // ── 1. Dark default: no opt-in surface on the accept review. ──
  const borrower = await launchWallet('borrower');
  const { page } = borrower;
  await openAcceptReview(page, offerId);
  await expect(page.getByTestId('full-tariff-optin')).toHaveCount(0);

  await setFeeEntitlementEnabled(true);
  try {
    // ── 2. Enabled + strict Full + empty VPFI vault ⇒ accept fails. ──
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openAcceptReview(page, offerId);
    const card = page.getByTestId('full-tariff-optin');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Engage Full; the live quote line + auto-seeded ceiling appear.
    await card.locator('input[type="checkbox"]').first().check();
    await expect(card.getByTestId('full-tariff-ceiling')).not.toHaveValue('', {
      timeout: 30_000,
    });
    await tickConsent(page);
    const accept = page.getByRole('button', { name: /borrow this now/i });
    await expect(accept).toBeEnabled({ timeout: 60_000 });
    await accept.click();
    // The signed acceptorFull reaches the contract, which rejects the
    // whole accept (no downgrade permission, vault short of C*).
    await expect(page.getByRole('alert').last()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText(/loan opened|what happens next/i)).toHaveCount(0);

    // ── 3. Same accept with the downgrade permitted ⇒ opens non-Full. ──
    const boxes = card.locator('input[type="checkbox"]');
    await boxes.nth(1).check(); // "open the loan without it"
    await tickConsent(page);
    await expect(accept).toBeEnabled({ timeout: 60_000 });
    await accept.click();
    await expect(page.getByText(/loan opened|what happens next/i)).toBeVisible({
      timeout: 120_000,
    });

    const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');
    const fe = (await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getFeeEntitlement',
      args: [loanId],
    })) as {
      borrowerMode: number;
      openDays: number;
      borrowerTariffPaid: bigint;
    };
    // Stamped (the tariff path ran) but downgraded: not Full, nothing
    // absorbed.
    expect(Number(fe.openDays)).toBeGreaterThanOrEqual(1);
    expect(Number(fe.borrowerMode)).not.toBe(FEE_MODE_FULL);
    expect(fe.borrowerTariffPaid).toBe(0n);
  } finally {
    await setFeeEntitlementEnabled(false);
    await borrower.ctx.close();
  }
});
