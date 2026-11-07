/** Repay all on the loans one offer filled into (#126).
 *
 *  A borrower's ranged request is filled in two slices by two lenders, so
 *  the borrower holds two open loans that carry the SAME offer id (a match
 *  records the borrower's request on each loan it opens). Positions then
 *  shows one card for that offer, and "Repay all" closes both loans in one
 *  approval and one Diamond `multicall`.
 *
 *  What is asserted, and from where:
 *  - the seed, from the chain: two loans, this borrower, the request's id
 *    on both, both Active (#2183 — a spec proves nothing on a seed it did
 *    not check);
 *  - the card, from the states it publishes (`data-stage`, `data-plan`,
 *    `data-outcome`), never from its wording: the review plans both loans
 *    as ready, and the outcome names both as closed;
 *  - the result, from the chain again: both loans Repaid.
 */
import { parseUnits } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import {
  DIAMOND,
  DIAMOND_ABI_VIEM,
  ERC20_MIN_ABI,
  WETH,
  confirm,
  forkChain,
  pub,
  walletFor,
} from '../lib/chain';
import { accountFor, type Role } from '../lib/wallets';
import { MUSDC, freshTenor, seedDeskOffer } from '../lib/desk';
import { topUpWeth } from '../lib/seed';

type LoanRow = { borrower: string; offerId: bigint; status: number | bigint };

const loanOf = (loanId: bigint) =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  }) as Promise<LoanRow>;

async function musdcDecimals(): Promise<number> {
  return Number(
    await pub.readContract({ address: MUSDC, abi: ERC20_MIN_ABI, functionName: 'decimals' }),
  );
}

async function mintMusdc(role: Role, decimals: number): Promise<void> {
  const account = accountFor(role);
  const hash = await walletFor(account).writeContract({
    address: MUSDC,
    abi: ERC20_MIN_ABI,
    functionName: 'mint',
    args: [account.address, parseUnits('1000', decimals)],
    account,
    chain: forkChain,
  });
  await confirm(hash, 'mint (batch repay seeding)');
}

/** Match a lender offer against the borrower's request from a third
 *  wallet, after the contract's own preview says the pair matches, and
 *  return the loan the match opened. */
async function matchDirect(matcher: Role, lenderOfferId: bigint, borrowerOfferId: bigint): Promise<bigint> {
  const account = accountFor(matcher);
  const preview = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'previewMatch',
    args: [lenderOfferId, borrowerOfferId, account.address, account.address],
  })) as { errorCode: number };
  expect(preview.errorCode, `previewMatch(${lenderOfferId}, ${borrowerOfferId}) must be Ok`).toBe(0);
  const { request, result } = await pub.simulateContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'matchOffers',
    args: [lenderOfferId, borrowerOfferId],
    account,
    chain: forkChain,
  });
  await confirm(await walletFor(account).writeContract(request), 'matchOffers');
  return result as bigint;
}

test('Repay all closes both loans one offer filled into', async ({ launchWallet }) => {
  const enabled = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getPartialFillEnabled',
  })) as boolean;
  expect(enabled, 'partial fills must be on (deploy default)').toBe(true);

  const tenor = await freshTenor(WETH, MUSDC);
  const decimals = await musdcDecimals();
  await mintMusdc('borrower', decimals);
  // Each lender funds 0.001 WETH and the borrower repays both loans; none
  // of them relies on what earlier specs left in the wallet.
  for (const role of ['lender', 'newLender', 'borrower'] as const) await topUpWeth(role, '0.1');

  // The borrower's request is a range of 0.001–0.002 WETH with collateral
  // ranged 40–100 mUSDC, so each 0.001 slice locks its own 40.
  const requestId = await seedDeskOffer({
    role: 'borrower',
    side: 'borrow',
    rateBps: 900,
    amountWeth: '0.001',
    amountMaxWeth: '0.002',
    collateralTliq: '40',
    collateralMaxTliq: '100',
    days: tenor,
    collateralAsset: MUSDC,
    collateralDecimals: decimals,
  });
  // Two single-value lender offers of 0.001 WETH, from two lenders.
  const lenderOffers: bigint[] = [];
  for (const role of ['lender', 'newLender'] as const) {
    lenderOffers.push(
      await seedDeskOffer({
        role,
        side: 'lend',
        rateBps: 600,
        amountWeth: '0.001',
        minAmountWeth: '0.001',
        collateralTliq: '40',
        days: tenor,
        collateralAsset: MUSDC,
        collateralDecimals: decimals,
      }),
    );
  }
  const loanIds: bigint[] = [];
  for (const offerId of lenderOffers) loanIds.push(await matchDirect('newBorrower', offerId, requestId));

  // CONFIRM THE SEED FROM CHAIN STATE: two loans, this borrower, the
  // request's id on both, both Active.
  const borrowerAddr = accountFor('borrower').address.toLowerCase();
  expect(new Set(loanIds).size).toBe(2);
  for (const id of loanIds) {
    const loan = await loanOf(id);
    expect(loan.borrower.toLowerCase(), `loan #${id} is the borrower's`).toBe(borrowerAddr);
    expect(loan.offerId, `loan #${id} carries the request's id`).toBe(requestId);
    expect(Number(loan.status), `loan #${id} is Active`).toBe(0);
  }

  const { page } = await launchWallet('borrower');
  await page.goto('/positions', { waitUntil: 'domcontentloaded' });
  const card = page.locator(`[data-testid="batch-close-out"][data-offer="${requestId}"]`);
  await expect(card).toBeVisible({ timeout: 60_000 });
  for (const id of loanIds) {
    await expect(card).toHaveAttribute('data-loans', new RegExp(`(^|,)${id}(,|$)`));
  }
  await expect(card).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await card.getByTestId('batch-close-out-repay').click();

  // The review plans every loan, and both are ready.
  await expect(card).toHaveAttribute('data-stage', 'review', { timeout: 60_000 });
  await expect(card).toHaveAttribute('data-action', 'repay');
  for (const id of loanIds) {
    await expect(card.locator(`li[data-loan="${id}"]`)).toHaveAttribute('data-plan', 'ready');
  }
  // The review's controls carry markers, so the click never keys on a label.
  const confirmBtn = card.getByTestId('confirm-receipt-confirm');
  await expect(confirmBtn).toBeEnabled({ timeout: 30_000 });
  await confirmBtn.click();

  // The outcome is the chain's, read back at the mined block.
  await expect(card).toHaveAttribute('data-stage', 'done', { timeout: 180_000 });
  for (const id of loanIds) {
    await expect(card.locator(`li[data-loan="${id}"]`)).toHaveAttribute('data-outcome', 'closed');
  }
  for (const id of loanIds) {
    expect(Number((await loanOf(id)).status), `loan #${id} is Repaid`).toBe(1);
  }
});
