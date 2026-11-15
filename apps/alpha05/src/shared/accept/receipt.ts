/**
 * The acceptance receipt for the side the connected wallet takes: the
 * borrower's when it takes a lender offer, the lender's when it takes a
 * borrow request. One entry point, so the flow never builds the wrong one.
 * A maker's signed order (OFF-60) gets the same receipt for its side, with
 * what the fill draws from the maker's vault, that it takes the whole order,
 * and where the risk-access check is made.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import type { TokenMetaMap } from '../reads/tokens';
import { shortAddress } from '../ui/format';
import type { AcceptReview } from './acceptReview';
import { borrowerReceipt } from './borrowerReceipt';
import { lenderReceipt } from './lenderReceipt';

export function acceptReceipt(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const base = r.role === 'borrower' ? borrowerReceipt(r, meta, copy) : lenderReceipt(r, meta, copy);
  return r.signed === null ? base : signedReceipt(base, r, r.signed, copy);
}

function signedReceipt(base: Receipt, r: AcceptReview, s: NonNullable<AcceptReview['signed']>, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  return {
    ...base,
    title: format(r.role === 'borrower' ? 'signedFill.titleBorrow' : 'signedFill.titleLend', { maker: shortAddress(r.offer.creator) }),
    rows: [
      ...base.rows,
      { label: text('signedFill.rowOrder'), value: { kind: 'text', text: s.orderHash }, binding: false },
      {
        label: text(r.role === 'borrower' ? 'signedFill.rowStakeLender' : 'signedFill.rowStakeBorrower'),
        value: { kind: 'amount', asset: s.stakeAsset, amount: s.stakeRequired },
        binding: false,
      },
      { label: text('signedFill.rowMakerFree'), value: { kind: 'amount', asset: s.stakeAsset, amount: s.makerFreeHolding }, binding: false },
    ],
    consequences: [text('signedFill.loseWhole'), ...(r.riskPreviewed ? [] : [text('signedFill.riskAtDryRun')]), ...base.consequences],
  };
}
