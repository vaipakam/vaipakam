/**
 * Borrow: the creator's opt-in to the Full fee tariff on a request (matrix
 * OFF-22), and the backstop stated as not offered (OFF-26). While the
 * protocol's switch is off the form says so and the choice is closed. With
 * it on, the form quotes today's tariff, fills the ceiling from it, and the
 * review states the choice, the reads and what each loan pays; posting then
 * offers the opt-in as its own transaction, measured by reading the request
 * back. Runs on the desktop and the phone project.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

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

test('while the Full fee tariff is switched off the choice is closed and says why, and the backstop is stated as not offered', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const { page, flags } = await launchWallet('borrower', { advanced: true });
  await openForm(page, tliq);
  const tariff = page.getByTestId('request-tariff');
  await expect(tariff.getByTestId('request-tariff-off')).toHaveText('The Full fee tariff is switched off on this network, so it cannot be chosen.', { timeout: 60_000 });
  await expect(page.getByTestId('request-tariff-opt')).toBeDisabled();
  await expect(page.getByTestId('request-backstop')).toHaveText('Backstop lending for requests nobody takes is not offered in this app yet.');
  await fitsWidth(page);
  expect(flags.sentTransactions).toBe(0);
});

test('with the tariff switched on, the request states it, posts, and sets it by its own transaction', async ({ launchWallet }) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    // The switch is accepted only on the canonical VPFI chain.
    await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
    await sc.diamondWrite('admin', 'setFeeEntitlementEnabled', [true]);
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    const borrower = accountFor('borrower').address;
    await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('2000')]);
    await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);
    const [cStar] = await sc.read<readonly [bigint, boolean]>('quoteCStar', [WETH, parseEther('0.25'), 30n]);
    expect(cStar > 0n).toBe(true);

    const { page, flags } = await launchWallet('borrower', { advanced: true });
    await openForm(page, tliq);
    await page.getByTestId('request-amount').fill('0.25');
    await page.getByTestId('request-collateral').fill('2000');
    await page.getByTestId('request-rate').fill('6');
    await page.getByTestId('request-tariff-opt').check({ timeout: 60_000 });
    await expect(page.getByTestId('request-tariff-quote')).toContainText("Today's tariff for a loan of 0.25 WETH:", { timeout: 60_000 });
    await expect(page.getByTestId('request-tariff').getByText(/Left blank, today's tariff for the largest loan is used/)).toBeVisible();
    await expect(page.getByTestId('request-tariff-fail').getByRole('radio', { name: 'Refuse that loan' })).toBeChecked();
    await fitsWidth(page);
    await page.getByTestId('request-review').click();

    const receipt = page.locator('.post-request .receipt').first();
    await expect(receipt).toContainText('Chosen; set by its own transaction after the request posts', { timeout: 60_000 });
    await expect(receipt).toContainText('Switched on now');
    await expect(receipt).toContainText("Today's tariff for this loan");
    await expect(receipt).toContainText('Most VPFI one loan may take');
    await expect(receipt).toContainText('Free VPFI in your vault now');
    await expect(receipt).toContainText('and it is not refunded');
    await expect(receipt).toContainText('the tariff adds 10 points to its discount, up to the 50% cap');
    await expect(receipt).toContainText('A lender who takes the request before that transaction is confirmed opens a loan without the tariff.');
    // The fixture's wallet holds no VPFI in a vault, which is stated with the
    // refusal it brings rather than blocking the request.
    await expect(receipt).toContainText(
      /Your vault has 0 VPFI free now, less than the .+ VPFI even the smallest loan would take; until you add VPFI, every loan this request opens is refused\./,
    );
    await fitsWidth(page);

    const flow = page.locator('.post-request');
    await flow.getByTestId('request-consent').check();
    const sent = flags.sentTransactions;
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = flow.locator('[data-phase="measured"]').first();
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    expect(flags.sentTransactions).toBe(sent + 2);
    const id = BigInt((await finish.textContent())!.match(/Request #(\d+)/)![1]!);

    const arm = page.getByTestId('request-tariff-arm');
    await expect(arm).toContainText('Your request is posted. This second transaction sets the tariff on it.');
    await expect(arm.locator('.receipt')).toContainText(`Request #${id}`);
    await fitsWidth(page);
    await arm.getByRole('button', { name: 'Confirm in wallet' }).click();
    await expect(arm.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    expect(flags.sentTransactions).toBe(sent + 3);

    const offer = await sc.read<{ creatorFull: boolean; creatorMaxCStar: bigint; creatorAllowFullDowngrade: boolean }>('getOffer', [id]);
    expect(offer.creatorFull).toBe(true);
    expect(offer.creatorMaxCStar).toBe(cStar);
    expect(offer.creatorAllowFullDowngrade).toBe(false);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});
