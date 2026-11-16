import { usePositionBook } from '../positions/usePositionBook';
import { useOwnRead } from '../reads/useOwnRead';
import { readLoanClaimRows } from './loanClaimRows';

/** The connected wallet's loan payouts on its chain, each read as its claim
 *  reads it (LN-50): one read, shared by every page that lists or totals
 *  them, so Claims and Home never disagree. */
export function useLoanClaims() {
  const book = usePositionBook();
  const payouts = book.payouts.data;
  const ids = payouts ? [...payouts.rows, ...payouts.unlisted].map((p) => `${p.side}:${p.loanId}`).join(',') : '';
  const claims = useOwnRead(['claims', 'loans', book.diamond, ids], (c) => readLoanClaimRows(c, book.diamond, payouts!), {
    enabled: book.chain !== null && payouts !== null,
  });
  return { book, payouts, claims };
}
