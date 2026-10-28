/** The loan page's interest-schedule card, driven through every state a
 *  period can be in (#2524).
 *
 *  A Monthly-cadence loan is opened between the fixture wallets, then the
 *  chain clock is moved through its first two periods:
 *
 *  1. Open, with the deployment's periodic-interest switch OFF (the
 *     posture the e2e chain ships with): the card names the schedule and
 *     the period, and says settling is switched off before the period is
 *     due, so it does not warn of a collateral sale that cannot happen.
 *     No button (Codex #3030 r1).
 *  2. Fully paid, past grace, with the deployment's periodic-interest
 *     switch OFF: the card says settling is switched off on this
 *     deployment and offers nothing. This is the posture the e2e chain
 *     ships with, and the one the card most needs to disclose.
 *  3. The same period with the switch ON: the card offers to record it,
 *     the borrower records it from the page, and the chain's own preview
 *     moves to the next period with nothing paid toward it. That period is
 *     open with settlement running, so the card now says what happens if
 *     it is still short when the grace ends, in each party's terms.
 *  4. The next period left unpaid past its grace: the card says anyone
 *     may now settle it by selling collateral, in the borrower's and the
 *     lender's own terms, and offers no button: the sale needs a swap
 *     route quoted when it runs, which this page does not build.
 *
 *  The switch and the finer-cadence threshold are chain-global
 *  configuration, so every write to them is restored in a `finally`. */
import { erc20Abi, type Address } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect } from '../lib/desk';
import { sendAsAdmin } from '../lib/admin';
import { increaseTime } from '../lib/anvil';
import { accountFor } from '../lib/wallets';
import { pub, walletFor, forkChain, confirm, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

/** The lowest finer-cadence threshold the chain accepts (1,000 in the
 *  numeraire, 1e18-scaled), so a 0.5 WETH principal qualifies for a
 *  Monthly cadence (spec 44 opens the same window). */
const CADENCE_THRESHOLD_FLOOR = 1_000n * 10n ** 18n;

const read = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName,
    args: args as unknown[],
  }) as Promise<T>;

type Preview = readonly [number, bigint, bigint, bigint, bigint, bigint, boolean];
const previewOf = async (loanId: bigint) => {
  const [cadence, periodEndAt, graceEndsAt, expected, paid, shortfall, canSettleNow] =
    await read<Preview>('previewPeriodicSettle', [loanId]);
  return { cadence, periodEndAt, graceEndsAt, expected, paid, shortfall, canSettleNow };
};

const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp;

/** Move the chain clock to `at` (never backwards). */
async function warpTo(at: bigint): Promise<void> {
  const now = await chainNow();
  if (at > now) await increaseTime(Number(at - now));
}

/** The borrower pays `amount` of principal, and the interest accrued so
 *  far rides along, straight from its wallet (spec 28 drives the same
 *  call through the page; here it only sets the period up). */
async function repayPartialAsBorrower(loanId: bigint, amount: bigint): Promise<void> {
  const account = accountFor('borrower');
  const wallet = walletFor(account);
  const loan = await read<{ principalAsset: Address }>('getLoanDetails', [loanId]);
  const approve = await wallet.writeContract({
    address: loan.principalAsset,
    abi: erc20Abi,
    functionName: 'approve',
    args: [DIAMOND, amount * 2n],
    account,
    chain: forkChain,
  });
  await confirm(approve, 'approve (repayPartial allowance)');
  const hash = await wallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'repayPartial',
    args: [loanId, amount],
    account,
    chain: forkChain,
  });
  await confirm(hash, 'repayPartial');
}

test('the interest card follows a period from open to recorded, and the next one to a sale', async ({
  launchWallet,
}) => {
  const periodicWas = await read<boolean>('getPeriodicInterestEnabled');
  const thresholdWas = await read<bigint>('getMinPrincipalForFinerCadence');
  let offerId: bigint;
  try {
    await sendAsAdmin('setPeriodicInterestEnabled', [true]);
    await sendAsAdmin('setMinPrincipalForFinerCadence', [CADENCE_THRESHOLD_FLOOR]);
    offerId = await seedDeskOffer({
      role: 'lender',
      side: 'lend',
      rateBps: 900,
      amountWeth: '0.5',
      minAmountWeth: '0.5',
      collateralTliq: '10',
      // Long enough that the second period's grace ends well before
      // maturity, so the loan is still running at step 4.
      days: 90,
      terms: { allowsPartialRepay: true, periodicInterestCadence: 1 },
    });
  } finally {
    await sendAsAdmin('setMinPrincipalForFinerCadence', [thresholdWas]);
    await sendAsAdmin('setPeriodicInterestEnabled', [periodicWas]);
  }
  const loanId = await acceptOfferDirect('borrower', offerId);

  // CONFIRM THE SETUP FROM CHAIN STATE (#2183).
  const first = await previewOf(loanId);
  expect(Number(first.cadence), 'the loan should be on a Monthly cadence').toBe(1);
  expect(first.canSettleNow).toBe(false);
  expect(periodicWas, 'the e2e chain ships with periodic settlement off').toBe(false);

  // ── 1. Open ────────────────────────────────────────────────────────────
  const borrower = await launchWallet('borrower');
  const bPage = borrower.page;
  const bCard = bPage.getByTestId('periodic-interest-card');
  await bPage.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  await expect(bCard).toBeVisible({ timeout: 60_000 });
  await expect(bCard.getByText('Every month')).toBeVisible({ timeout: 60_000 });
  await expect(bCard.getByText('This period is open.')).toBeVisible();
  // Switched off: said before the period is due, and no sale is warned of.
  await expect(bCard.getByTestId('periodic-interest-settlement')).toContainText(
    /switched off on this deployment/i,
  );
  await expect(bCard.getByText(/counts toward it/i)).toBeVisible();
  await expect(bCard.getByText(/selling enough of your collateral/i)).toHaveCount(0);
  await expect(bCard.getByRole('button')).toHaveCount(0);

  const lender = await launchWallet('lender');
  const lPage = lender.page;
  const lCard = lPage.getByTestId('periodic-interest-card');
  await lPage.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  await expect(lCard.getByTestId('periodic-interest-settlement')).toContainText(
    /switched off on this deployment/i,
    { timeout: 60_000 },
  );
  await expect(lCard.getByText(/you are paid up to what is owed/i)).toHaveCount(0);

  // ── 2. Fully paid, past grace, switch off ──────────────────────────────
  // Pay a fifth of the principal an hour before the deadline: the
  // interest accrued over almost the whole period rides along, and the
  // period's expected interest drops with the principal, so the period
  // reads fully paid. Before the deadline nothing records it inline.
  await warpTo(first.periodEndAt - 3_600n);
  const loan = await read<{ principal: bigint }>('getLoanDetails', [loanId]);
  await repayPartialAsBorrower(loanId, loan.principal / 5n);
  const paidUp = await previewOf(loanId);
  expect(paidUp.shortfall, 'the period should read fully paid').toBe(0n);
  expect(paidUp.periodEndAt, 'the period must not have advanced yet').toBe(first.periodEndAt);

  await warpTo(paidUp.graceEndsAt + 60n);
  expect((await previewOf(loanId)).canSettleNow).toBe(true);
  await bPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(bCard.getByText(/switched off on this deployment/i)).toBeVisible({
    timeout: 60_000,
  });
  await expect(bCard.getByRole('button')).toHaveCount(0);

  try {
    await sendAsAdmin('setPeriodicInterestEnabled', [true]);

    // ── 3. Record it ─────────────────────────────────────────────────────
    await bPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(bCard.getByText(/this period is fully paid/i)).toBeVisible({
      timeout: 60_000,
    });
    const record = bCard.getByRole('button', { name: 'Record this period' });
    await expect(record).toBeEnabled({ timeout: 30_000 });
    await record.click();
    await expect(bCard.getByText(/next period has started/i)).toBeVisible({
      timeout: 120_000,
    });
    const second = await previewOf(loanId);
    expect(second.periodEndAt, 'the checkpoint moves one interval').toBe(
      first.periodEndAt + 30n * 86_400n,
    );
    expect(second.paid, 'the new period starts with nothing paid').toBe(0n);

    // The next period is open with settlement running: the sale rule is
    // now said, in each party's terms, and the switched-off line is gone.
    await bPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(bCard.getByText(/selling enough of your collateral/i)).toBeVisible({
      timeout: 60_000,
    });
    await expect(bCard.getByTestId('periodic-interest-settlement')).toHaveCount(0);
    await lPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(lCard.getByText(/you are paid up to what is owed/i)).toBeVisible({
      timeout: 60_000,
    });

    // ── 4. The next period, unpaid past its grace ────────────────────────
    await warpTo(second.graceEndsAt + 60n);
    const due = await previewOf(loanId);
    expect(due.canSettleNow).toBe(true);
    expect(due.shortfall > 0n, 'the second period should be short').toBe(true);

    await bPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      bCard.getByText(/anyone may now settle it by selling enough of your collateral/i),
    ).toBeVisible({ timeout: 60_000 });
    await expect(bCard.getByRole('button')).toHaveCount(0);

    await lPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(lCard.getByText(/this page cannot run that sale/i)).toBeVisible({
      timeout: 60_000,
    });
    await expect(lCard.getByRole('button')).toHaveCount(0);
  } finally {
    await sendAsAdmin('setPeriodicInterestEnabled', [periodicWas]);
  }

  await borrower.ctx.close();
  await lender.ctx.close();
});
