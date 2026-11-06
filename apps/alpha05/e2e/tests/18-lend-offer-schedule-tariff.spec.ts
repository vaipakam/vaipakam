/**
 * Lend: a lender's interest schedule and Full fee tariff on their own offer
 * (matrix OFF-14 / OFF-22 from the lender's side). The schedule is admitted
 * at the smallest amount one loan may lend, as creation admits it, so a
 * smallest part below the protocol's threshold closes the finer schedules
 * even when the whole amount clears it. The review states each period on all
 * of it and on the smallest part, and a missed period as paid to the lender
 * from the borrower's collateral; the tariff is quoted at both ends, and
 * states what it gives a lender (10 more points of discount on the
 * protocol's share of the loan's interest, for its term, going with the
 * lender position). Posting offers the opt-in as its own transaction on the
 * Lend page, measured by reading the offer back. Runs on the desktop and the
 * phone project, inside a snapshot the test reverts.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;
const E18 = 10n ** 18n;
/** The lowest threshold the protocol accepts (1,000 numeraire units). */
const THRESHOLD = 1_000n * E18;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

interface StoredOffer {
  amount: bigint;
  amountMax: bigint;
  periodicInterestCadence: number;
  creatorFull: boolean;
  creatorMaxCStar: bigint;
  creatorAllowFullDowngrade: boolean;
}

test('a lender posts an offer in parts with a monthly schedule and the Full tariff, and sets the tariff by its own transaction', async ({ launchWallet }) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await sc.diamondWrite('admin', 'setPeriodicInterestEnabled', [true]);
    await sc.diamondWrite('admin', 'setMinPrincipalForFinerCadence', [THRESHOLD]);
    // The tariff's switch is accepted only on the canonical VPFI chain.
    await sc.diamondWrite('admin', 'setCanonicalVPFIChain', [true]);
    await sc.diamondWrite('admin', 'setFeeEntitlementEnabled', [true]);
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    // A whole number of WETH worth half as much again as the threshold: the
    // smallest part, so every loan clears it; the whole amount is twice that.
    const perWeth = await sc.read<bigint>('getNumeraireValue', [WETH, E18, false]);
    const part = (THRESHOLD * 3n) / 2n / perWeth + 1n;
    const whole = part * 2n;
    await sc.write('lender', WETH, WETH_ABI, 'deposit', [], whole * E18);
    await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);
    const [cStar] = await sc.read<readonly [bigint, boolean]>('quoteCStar', [WETH, whole * E18, 60n]);
    expect(cStar > 0n).toBe(true);

    const { page, flags } = await launchWallet('lender', { advanced: true });
    await page.goto('/lend');
    await connectWallet(page);
    await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
    await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
    await page.getByTestId('lend-offer-open').click();
    await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
    // A monthly schedule needs a loan longer than a month.
    await page.getByTestId('request-duration').getByRole('radio', { name: '60 days' }).check();
    await page.getByTestId('request-amount').fill(String(whole));
    await page.getByTestId('request-collateral').fill('1500');
    await page.getByTestId('request-rate').fill('6');
    await page.getByTestId('request-range').check();

    // Admitted at the smallest part: below the threshold the finer
    // schedules close, though the whole amount clears it.
    const cadence = page.getByTestId('request-cadence');
    const monthly = cadence.getByRole('radio', { name: /Every month/ });
    await page.getByTestId('lend-offer-part').fill('0.01');
    await expect(cadence).toContainText(/Needs a loan worth at least 1,000\.00 [^;]+; this one is worth [\d,.]+ [^.]+\./, { timeout: 60_000 });
    await expect(monthly).toBeDisabled();
    await page.getByTestId('lend-offer-part').fill(String(part));
    await expect(monthly).toBeEnabled({ timeout: 60_000 });
    await monthly.check();

    // The tariff is quoted at the whole amount, the largest loan (a direct take).
    await page.getByTestId('request-tariff-opt').check({ timeout: 60_000 });
    await expect(page.getByTestId('request-tariff').getByText("Pay the Full fee tariff in VPFI from your vault for a larger discount on the protocol's share")).toBeVisible();
    await expect(page.getByTestId('request-tariff-quote')).toContainText(`Today's tariff for a loan of ${whole} WETH:`, { timeout: 60_000 });
    await expect(page.getByTestId('request-summary')).toContainText('all interest plus principal owed to you totals');
    await fitsWidth(page);
    await page.getByTestId('request-review').click();

    const receipt = page.locator('.post-request .receipt').first();
    await expect(receipt).toContainText('Post your lending offer', { timeout: 60_000 });
    await expect(receipt).toContainText('Due every month');
    await expect(receipt).toContainText('Each period, if a borrower takes all of it');
    await expect(receipt).toContainText('Each period, on a loan of the smallest part');
    await expect(receipt).toContainText('instalments paid count toward it');
    await expect(receipt).toContainText(
      /Interest is due every month: if a period is not paid within .+ after it ends, anyone may sell part of the borrower's collateral to pay it to you, and the loan stays open\./,
    );
    await expect(receipt).toContainText('The interest schedule cannot be changed after posting; to change it, cancel the offer and post a new one.');
    await expect(receipt).toContainText('Chosen; set by its own transaction after the offer posts');
    await expect(receipt).toContainText("Today's tariff for the smallest loan");
    await expect(receipt).toContainText("Today's tariff for the largest loan");
    await expect(receipt).toContainText('the tariff adds 10 points to your discount on that share, up to the 50% cap');
    await expect(receipt).toContainText('A loan extended for a new term loses the extra points for that term.');
    await expect(receipt).toContainText('The extra points belong to the lender position');
    await expect(receipt).toContainText('by a borrower taking it or by a match, opens without the tariff.');
    // The wallet holds no VPFI in its vault: stated with the refusal it
    // brings, in the offer's words, rather than blocking the offer.
    await expect(receipt).toContainText(/until you add VPFI, every loan this offer opens is refused\./);
    await fitsWidth(page);

    const flow = page.locator('.post-request');
    await flow.getByTestId('request-consent').check();
    const sent = flags.sentTransactions;
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = flow.locator('[data-phase="measured"]').first();
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    expect(flags.sentTransactions).toBe(sent + 2);
    const id = BigInt((await finish.textContent())!.match(/Offer #(\d+)/)![1]!);

    const arm = page.getByTestId('request-tariff-arm');
    await expect(arm).toContainText('Your offer is posted. This second transaction sets the tariff on it.');
    await expect(arm.locator('.receipt')).toContainText(`Offer #${id}`);
    await expect(arm.locator('.receipt')).toContainText('once the offer is taken in full or closed, the protocol refuses this transaction');
    await finish.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.post-request')).toHaveCount(0);
    // A new offer is held back while the step is open.
    await expect(page.getByTestId('lend-offer-held-for-tariff')).toContainText(`offer #${id}`);
    await expect(page.getByTestId('lend-offer-open')).toBeDisabled();
    await fitsWidth(page);
    await arm.getByRole('button', { name: 'Confirm in wallet' }).click();
    const armFinish = arm.locator('[data-phase="measured"]');
    await expect(armFinish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    expect(flags.sentTransactions).toBe(sent + 3);
    await armFinish.getByRole('button', { name: 'Close' }).click();
    const ended = page.getByTestId('request-tariff-ended');
    await expect(ended).toHaveAttribute('data-ending', 'armed');
    await expect(ended).toContainText(`The Full fee tariff is set on offer #${id}`);
    await ended.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('lend-offer-held-for-tariff')).toHaveCount(0);

    // The chain agrees: the smallest part is the amount the schedule was
    // admitted at, the whole amount the maximum, a monthly schedule, and the
    // creator's tariff opt-in with the ceiling quoted at the whole amount.
    const offer = await sc.read<StoredOffer>('getOffer', [id]);
    expect([offer.amount, offer.amountMax]).toEqual([part * E18, whole * E18]);
    expect(Number(offer.periodicInterestCadence)).toBe(1);
    expect(offer.creatorFull).toBe(true);
    expect(offer.creatorMaxCStar).toBe(cStar);
    expect(offer.creatorAllowFullDowngrade).toBe(false);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});
