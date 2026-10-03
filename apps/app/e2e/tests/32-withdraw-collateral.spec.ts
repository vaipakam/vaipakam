/** UX3-009 — a borrower takes back collateral the loan no longer needs,
 *  driven through the loan page in BASIC mode to an on-chain collateral
 *  reduction.
 *
 *  The contract side (`partialWithdrawCollateral`, the health-factor and
 *  loan-to-value checks, the `calculateMaxWithdrawable` view) is pinned by
 *  `contracts/test/PartialWithdrawalFacetTest.t.sol`. What nothing drove
 *  was the APP: until UX3-009 it had no surface for this at all. So the
 *  gap this closes is the drive from the borrower's own card to chain
 *  state.
 *
 *  The verdict is a PAIR — collateral shrinks by exactly the typed
 *  amount, AND the loan stays Active — since a close-out would also move
 *  collateral and a no-op would also leave the loan open. The amount is
 *  half the live ceiling, read from the chain rather than assumed, so a
 *  price or risk-param change in the deployed contracts moves the amount
 *  with it instead of pushing it over the limit.
 */
import { formatUnits } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect } from '../lib/desk';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, ERC20_MIN_ABI } from '../lib/chain';

interface LoanShape {
  collateralAmount: bigint;
  collateralAsset: `0x${string}`;
  status: number;
}

async function loanOf(loanId: bigint): Promise<LoanShape> {
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as {
    collateralAmount: bigint;
    collateralAsset: `0x${string}`;
    status: number | bigint;
  };
  return { ...loan, status: Number(loan.status) };
}

test('borrower takes back extra collateral and the loan stays Active', async ({
  launchWallet,
}) => {
  // Generously collateralised so the loan holds more than it needs.
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 900,
    amountWeth: '0.02',
    collateralTliq: '150',
    days: 30,
  });
  const loanId = await acceptOfferDirect('borrower', offerId);

  const before = await loanOf(loanId);
  expect(before.status, 'loan should open Active').toBe(0);

  // Precondition, asserted rather than assumed: with no headroom the card
  // correctly says there is nothing to take back, and this spec would
  // fail on a missing input with no hint as to why.
  const max = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'calculateMaxWithdrawable',
    args: [loanId],
  })) as bigint;
  expect(max, 'seeded loan must hold collateral it does not need').toBeGreaterThan(0n);
  const take = max / 2n;
  expect(take, 'half the ceiling must be a positive amount').toBeGreaterThan(0n);

  const decimals = Number(
    await pub.readContract({
      address: before.collateralAsset,
      abi: ERC20_MIN_ABI,
      functionName: 'decimals',
    }),
  );

  // Basic mode on purpose: this is the borrower's own money, and the
  // surface must not hide behind the advanced toggle.
  const borrower = await launchWallet('borrower');
  const { page } = borrower;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });

  const card = page.locator('#withdraw-collateral-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The ceiling is stated before anything is asked of the user.
  await expect(card.locator('#withdraw-collateral-state')).toContainText(
    /you can take back up to [\d.,]+ \S+/i,
    { timeout: 60_000 },
  );

  // Over the ceiling is refused on the page, before the wallet opens.
  await card.getByLabel(/collateral amount to take back/i).fill(formatUnits(max + max, decimals));
  await expect(card.getByText(/more than you can take back right now/i)).toBeVisible();
  await expect(card.getByRole('button', { name: /^take back$/i })).toBeDisabled();

  await card.getByLabel(/collateral amount to take back/i).fill(formatUnits(take, decimals));
  const takeBack = card.getByRole('button', { name: /^take back$/i });
  await expect(takeBack).toBeEnabled({ timeout: 30_000 });
  await takeBack.click();

  const confirm = card.getByRole('button', { name: /confirm — take back collateral/i });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();

  await expect(page.getByText(/collateral taken back/i)).toBeVisible({ timeout: 120_000 });

  // The chain is the verdict, not the banner.
  await expect
    .poll(async () => (await loanOf(loanId)).collateralAmount, { timeout: 60_000 })
    .toBe(before.collateralAmount - take);
  const after = await loanOf(loanId);
  expect(after.status, 'taking collateral back must not settle the loan').toBe(0);

  await borrower.ctx.close();
});
