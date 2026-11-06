/**
 * Borrow: the request's interest schedule (matrix OFF-14). The form offers
 * only the schedules the protocol's own admission rule allows for the terms
 * typed, and says under each closed one why (the switch, the principal
 * against the threshold with both figures, the period against the loan).
 * A chosen schedule still applies in Basic, which says so, and the review
 * states it there with each period's interest, the grace and the sale a
 * missed period brings. Runs on the desktop and the phone project.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, onPhone, openMenu, test } from '../lib/wallet';

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;
const E18 = 10n ** 18n;
/** The lowest threshold the protocol accepts (1,000 numeraire units). */
const THRESHOLD = 1_000n * E18;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openForm(page: Page, collateral: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('request-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
}

const schedule = (page: Page, name: RegExp) => page.getByTestId('request-cadence').getByRole('radio', { name });

test('while periodic interest is switched off, only interest at repayment is offered, and the form says why', async ({ launchWallet }) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [false]);
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    const { page, flags } = await launchWallet('borrower', { advanced: true });
    await openForm(page, tliq);
    const cadence = page.getByTestId('request-cadence');
    await expect(cadence.getByText('Enter the amount and choose a term to see which schedules are open.')).toBeVisible();
    await page.getByTestId('request-amount').fill('0.25');
    await expect(cadence).toContainText('Switched off on this network now; only interest at repayment is open.', { timeout: 60_000 });
    await expect(schedule(page, /All at repayment/)).toBeChecked();
    await expect(schedule(page, /Every month/)).toBeDisabled();
    await expect(schedule(page, /Every year/)).toBeDisabled();
    await fitsWidth(page);
    expect(flags.sentTransactions).toBe(0);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});

test('a monthly request is offered only on terms the protocol admits, applies in Basic, and posts with its schedule', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [true]);
    await sc.diamondWrite('admin', 'setMinPrincipalForFinerCadence', [THRESHOLD]);
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    const borrower = accountFor('borrower').address;
    await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('2000')]);
    await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);
    // A whole number of WETH worth half as much again as the threshold, so
    // the principal clears it at the fixture's price.
    const perWeth = await sc.read<bigint>('getNumeraireValue', [WETH, E18, false]);
    const wholeWeth = (THRESHOLD * 3n) / 2n / perWeth + 1n;

    const { page, flags } = await launchWallet('borrower', { advanced: true });
    await openForm(page, tliq);
    await page.getByTestId('request-collateral').fill('2000');
    await page.getByTestId('request-rate').fill('6');
    // Below the threshold, a finer schedule names both figures.
    await page.getByTestId('request-amount').fill('0.01');
    const cadence = page.getByTestId('request-cadence');
    await expect(cadence).toContainText(/Needs a loan worth at least 1,000\.00 [^;]+; this one is worth [\d,.]+ [^.]+\./, { timeout: 60_000 });
    await expect(schedule(page, /Every month/)).toBeDisabled();

    // At or above it, the period rule is what is left: on a 60-day loan a
    // month is open and a quarter is not.
    await page.getByTestId('request-amount').fill(String(wholeWeth));
    await page.getByTestId('request-duration').getByRole('radio', { name: '60 days' }).check();
    await expect(schedule(page, /Every month/)).toBeEnabled({ timeout: 60_000 });
    await expect(cadence).toContainText('The period (90 days) must be shorter than the loan (60 days).');
    await expect(schedule(page, /Every quarter/)).toBeDisabled();
    await schedule(page, /Every month/).check();
    await fitsWidth(page);

    // Basic keeps it and says so.
    await openMenu(page);
    await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Basic' }).click();
    if (onPhone(testInfo.project.name)) await page.keyboard.press('Escape');
    await expect(page.getByTestId('request-advanced')).toHaveCount(0);
    await expect(page.getByTestId('request-advanced-set')).toContainText('an interest schedule');
    await page.getByTestId('request-review').click();

    const receipt = page.locator('.post-request .receipt');
    await expect(receipt).toContainText('Due every month', { timeout: 60_000 });
    await expect(receipt).toContainText('Interest due each period');
    await expect(receipt).toContainText(/every 30 days/);
    await expect(receipt).toContainText('Grace for a missed period');
    // The whole term's interest is a total the instalments count toward.
    await expect(receipt).toContainText('instalments paid count toward it');
    await expect(receipt).not.toContainText('You owe on the due date');
    await expect(receipt).toContainText(/Interest is due every month: if a period is not paid within .+ after it ends, anyone may sell part of your collateral to pay it\./);
    await expect(receipt).toContainText('The interest schedule cannot be changed after posting');
    // The keeper's posture is Advanced detail.
    await expect(receipt).not.toContainText('Who settles a missed period');
    await fitsWidth(page);

    const flow = page.locator('.post-request');
    await flow.getByTestId('request-consent').check();
    const sent = flags.sentTransactions;
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    expect(flags.sentTransactions).toBe(sent + 2);

    const id = BigInt((await finish.textContent())!.match(/Request #(\d+)/)![1]!);
    const offer = await sc.read<{ periodicInterestCadence: number; durationDays: bigint; amount: bigint }>('getOffer', [id]);
    expect(Number(offer.periodicInterestCadence)).toBe(1);
    expect(Number(offer.durationDays)).toBe(60);
    expect(offer.amount).toBe(wholeWeth * E18);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});
