/**
 * The acceptance receipt for the side the connected wallet takes: the
 * borrower's when it takes a lender offer, the lender's when it takes a
 * borrow request. One entry point, so the flow never builds the wrong one.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import type { TokenMetaMap } from '../reads/tokens';
import type { AcceptReview } from './acceptReview';
import { borrowerReceipt } from './borrowerReceipt';
import { lenderReceipt } from './lenderReceipt';

export function acceptReceipt(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  return r.role === 'borrower' ? borrowerReceipt(r, meta, copy) : lenderReceipt(r, meta, copy);
}
