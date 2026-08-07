/** #1587 — partial repayment, driven through the UI to an on-chain
 *  principal reduction.
 *
 *  Partial repay is a first-class row in the borrower's early-exit
 *  chooser, but nothing drove it at any tier: `04-repay` settles a
 *  loan IN FULL, the shared helper is `repayLoanInFull`, and there was
 *  no unit coverage either. This spec closes that gap, and the
 *  assertion that carries it is the pair — the principal must SHRINK
 *  and the loan must stay Active. Either alone is satisfiable by the
 *  wrong behaviour: a full repay also reduces what is owed, and a
 *  no-op also leaves the loan open.
 *
 *  The offer is SEEDED rather than posted through the form because the
 *  form defaults `allowsPartialRepay` off, and offer creation is
 *  already covered by `02-post-offer` — driving it again here would
 *  test the wrong surface and make the spec fail for reasons that have
 *  nothing to do with partial repayment.
 */
import { formatUnits } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect } from '../lib/desk';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, ERC20_MIN_ABI } from '../lib/chain';

interface LoanShape {
  principal: bigint;
  principalAsset: `0x${string}`;
  allowsPartialRepay: boolean;
  status: number;
}

async function loanOf(loanId: bigint): Promise<LoanShape> {
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as {
    principal: bigint;
    principalAsset: `0x${string}`;
    allowsPartialRepay: boolean;
    status: number | bigint;
  };
  return { ...loan, status: Number(loan.status) };
}

/** The contract's own floor on a partial (`RepayFacet`: `partialAmount
 *  < principal * minPartialBps / BASIS_POINTS` reverts
 *  `InsufficientPartialAmount`). Read live — a risk-param change on
 *  the forked chain must move this spec's chosen amount with it, not
 *  silently push it under the floor. */
async function minPartialBpsOf(asset: `0x${string}`): Promise<bigint> {
  const params = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getAssetRiskParams',
    args: [asset],
  })) as { minPartialBps: bigint };
  return params.minPartialBps;
}

test('partial repayment shrinks the principal and leaves the loan Active', async ({
  launchWallet,
}) => {
  // A partial-enabled lender offer. `seedDeskOffer` sets
  // `allowsPartialRepay: true`; the offer FORM defaults it off, which
  // is why this is seeded (see the file header).
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
  // Precondition, asserted rather than assumed: without this the whole
  // surface is gated off and the spec would fail on a missing card
  // with no hint as to why.
  expect(
    before.allowsPartialRepay,
    'seeded loan must permit partial repayment',
  ).toBe(true);
  expect(before.status, 'loan should open Active').toBe(0);

  // Half the principal: comfortably above the contract's floor and
  // strictly below the full amount (`partialAmount >= loan.principal`
  // reverts `PartialWouldRetireFullPrincipal` — full retirement must
  // go through `repayLoan`). Both bounds are asserted so a risk-param
  // change fails HERE, naming the cause, instead of surfacing as an
  // opaque revert behind the wallet confirm.
  const pay = before.principal / 2n;
  const floor =
    (before.principal * (await minPartialBpsOf(before.principalAsset))) /
    10_000n;
  expect(pay, 'chosen partial must clear the contract floor').toBeGreaterThanOrEqual(
    floor,
  );
  expect(pay, 'chosen partial must not retire the principal').toBeLessThan(
    before.principal,
  );

  const decimals = Number(
    await pub.readContract({
      address: before.principalAsset,
      abi: ERC20_MIN_ABI,
      functionName: 'decimals',
    }),
  );

  // The partial surface is advanced-mode + borrower-only.
  const adv = await launchWallet('borrower', { advanced: true });
  const { page } = adv;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });

  const card = page.locator('#partial-repay-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card
    .getByLabel(/amount to repay now/i)
    .fill(formatUnits(pay, decimals));

  const repayPart = card.getByRole('button', { name: /^repay part$/i });
  await expect(repayPart).toBeEnabled({ timeout: 30_000 });
  await repayPart.click();

  const confirm = card.getByRole('button', { name: /confirm — repay part/i });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();

  await expect(page.getByText(/partial repayment confirmed/i)).toBeVisible({
    timeout: 120_000,
  });

  // The chain is the verdict, not the banner. `repayPartial`
  // decrements `loan.principal` by exactly the typed amount — the
  // accrued interest rides along in the same transferFrom set but does
  // NOT come off the principal, so this is an exact equality.
  await expect
    .poll(async () => (await loanOf(loanId)).principal, { timeout: 60_000 })
    .toBe(before.principal - pay);

  // Still Active: the half that distinguishes a partial from a repay.
  const after = await loanOf(loanId);
  expect(after.status, 'a partial must not settle the loan').toBe(0);

  await adv.ctx.close();
});
