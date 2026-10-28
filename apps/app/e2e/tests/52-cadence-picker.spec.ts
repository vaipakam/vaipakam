/** The create form's interest-schedule picker (#2524), driven against the
 *  protocol's own cadence rule (`previewCadenceAdmission`).
 *
 *  1. With periodic interest switched off, as the e2e chain ships, the
 *     Advanced form says so in one line and offers no choice.
 *  2. With it switched on and the finer-cadence threshold at its floor:
 *     a. a small offer is below the threshold, so every schedule but
 *        "once, when the loan is repaid" is closed with the threshold
 *        stated;
 *     b. a large 90-day offer opens Monthly and closes Quarterly and
 *        longer for their interval; choosing Monthly carries through to
 *        the review's consent text.
 *
 *  The switch and the threshold are chain-global configuration, so the
 *  writes are restored in a `finally`. Nothing is posted: the review is
 *  where the chosen schedule must show, and posting is spec 02's. */
import type { Page } from '@playwright/test';
import { test, expect } from '../lib/wallet-fixture';
import { sendAsAdmin } from '../lib/admin';
import { chooseMenuValue, pasteAsset, pickCuratedAsset } from '../lib/flows';
import { connectWallet } from '../lib/wallet-fixture';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, MOCKS, WETH } from '../lib/chain';

/** The lowest finer-cadence threshold the chain accepts (1,000 in the
 *  numeraire, 1e18-scaled) — the same window spec 51 opens. */
const CADENCE_THRESHOLD_FLOOR = 1_000n * 10n ** 18n;

const read = <T>(functionName: string) =>
  pub.readContract({ address: DIAMOND, abi: DIAMOND_ABI_VIEM, functionName }) as Promise<T>;

/** Lend form, Advanced, filled through to the terms step. */
async function toTerms(page: Page, amountWeth: string, days: string): Promise<void> {
  await page.goto('/lend', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await pickCuratedAsset(page, 'lending-asset', WETH);
  await page.locator('input[placeholder="0.0"]').fill(amountWeth);
  await chooseMenuValue(page, 'duration', days);
  const see = page.getByRole('button', { name: /see matching offers/i });
  await expect(see).toBeEnabled({ timeout: 30_000 });
  await see.click();
  await page.getByRole('button', { name: /post my own lending offer/i }).click();
  await page.locator('input[placeholder="5"]').fill('9');
  await pasteAsset(page, 'collateral-asset', MOCKS!.liquidToken as string);
  await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
}

test('the schedule picker offers what the protocol admits, and says why the rest are closed', async ({
  launchWallet,
}) => {
  const periodicWas = await read<boolean>('getPeriodicInterestEnabled');
  const thresholdWas = await read<bigint>('getMinPrincipalForFinerCadence');
  expect(periodicWas, 'the e2e chain ships with periodic interest off').toBe(false);

  const { page } = await launchWallet('lender', { advanced: true });
  const picker = page.getByTestId('cadence-picker');

  // ── 1. Switched off ────────────────────────────────────────────────────
  await toTerms(page, '1', '90');
  await expect(picker).toHaveAttribute('data-state', 'none-only', { timeout: 30_000 });
  await expect(picker).toContainText(/switched off on this network/i);

  try {
    await sendAsAdmin('setPeriodicInterestEnabled', [true]);
    await sendAsAdmin('setMinPrincipalForFinerCadence', [CADENCE_THRESHOLD_FLOOR]);

    // ── 2a. Below the threshold ────────────────────────────────────────────
    // A lender offer's smallest fill is a tenth of the headline, and the
    // threshold values that, so 0.01 WETH is far below it.
    await toTerms(page, '0.01', '90');
    await expect(picker).toHaveAttribute('data-state', 'choice', { timeout: 30_000 });
    await expect(page.getByTestId('cadence-option-0')).toHaveAttribute('data-admitted', 'true');
    const monthlySmall = page.getByTestId('cadence-option-1');
    await expect(monthlySmall).toHaveAttribute('data-admitted', 'false');
    await expect(monthlySmall).toContainText(/smallest loan this offer can open/i);
    await expect(monthlySmall.locator('input')).toBeDisabled();

    // ── 2b. Above it, 90 days ──────────────────────────────────────────────
    await toTerms(page, '100', '90');
    const monthly = page.getByTestId('cadence-option-1');
    await expect(monthly).toHaveAttribute('data-admitted', 'true', { timeout: 30_000 });
    const quarterly = page.getByTestId('cadence-option-2');
    await expect(quarterly).toHaveAttribute('data-admitted', 'false');
    await expect(quarterly).toContainText(/needs a loan longer than 90 days/i);
    await expect(page.getByTestId('cadence-option-4')).toHaveAttribute('data-admitted', 'false');

    await monthly.locator('input').check();
    const cont = page.getByRole('button', { name: /continue to review/i });
    await expect(cont).toBeEnabled({ timeout: 15_000 });
    await cont.click();
    await expect(page.getByText(/Interest payments: Every month\./).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await sendAsAdmin('setMinPrincipalForFinerCadence', [thresholdWas]);
    await sendAsAdmin('setPeriodicInterestEnabled', [periodicWas]);
  }
});
