/** Flow 4.1 (B1) — two actors: the lender posts through the UI, the
 *  borrower deep-links to that exact offer and accepts through the UI,
 *  and the loan opens on-chain with the borrower's collateral locked. */
import { test, expect } from '../lib/wallet-fixture';
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from '../lib/chain';

test('borrower accepts a matching offer and the loan opens', async ({
  launchWallet,
}) => {
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet('borrower');
  await acceptAsBorrower(borrower.page, offerId);

  const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as {
    status: number;
    borrower: string;
    collateralAmount: bigint;
    offerId: bigint;
  };
  expect(Number(loan.status)).toBe(0); // Active
  expect(loan.borrower.toLowerCase()).toBe(borrower.account.address.toLowerCase());
  expect(loan.collateralAmount).toBeGreaterThan(0n);
  // The loan opened from THE offer this test posted — not a stale
  // look-alike from the forked book.
  expect(BigInt(loan.offerId)).toBe(offerId);
});
