/**
 * RB-CONFIDENCE — the receipt for what is being posted, by side: a
 * borrower's request (requestReceipt) or a lender's offer
 * (lenderPostReceipt). The review is one read for both; only what each
 * side signs against differs.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Posture } from '../capability/types';
import type { Receipt } from '../receipt/types';
import type { TokenMetaMap } from '../reads/tokens';
import { lenderPostReceipt } from './lenderPostReceipt';
import type { PostReview } from './postReview';
import { requestReceipt } from './requestReceipt';

export function postReceipt(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>, advanced = false, keeper: Posture = 'unknown'): Receipt {
  return r.draft.side === 'lender' ? lenderPostReceipt(r, meta, copy) : requestReceipt(r, meta, copy, advanced, keeper);
}
