/** Flow 4.1 (B1) — two actors: the lender posts through the UI, the
 *  borrower guided-matches and accepts through the UI, and the loan
 *  opens on-chain with the borrower's collateral locked. */
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer, acceptAsBorrower, newestLoanIdFor } from '../lib/flows';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('borrower accepts a matching offer and the loan opens', async ({
  launchWallet,
}) => {
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  await lender.ctx.close();

  const borrower = await launchWallet('borrower');
  await acceptAsBorrower(borrower.page);

  const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { status: number; borrower: string; collateralAmount: bigint };
  expect(Number(loan.status)).toBe(0); // Active
  expect(loan.borrower.toLowerCase()).toBe(borrower.account.address.toLowerCase());
  expect(loan.collateralAmount).toBeGreaterThan(0n);
});
