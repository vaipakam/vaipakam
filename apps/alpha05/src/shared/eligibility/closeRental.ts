/**
 * RB-ELIG for closing a rental (NFT-05): the one rule that decides whether
 * this wallet may close a running rental now, used by the loan page's action
 * and by the review alike. A rental is closed through `repayLoan`, which on a
 * rental pays the rent owed and any late fee out of the rent and buffer the
 * renter prepaid into their own vault: nothing is taken from the wallet. The
 * dry run before signing stays the protocol's own last word.
 *
 * What it holds, and why:
 * - a rental that is not running has nothing to close;
 * - a wallet that does not hold the renter position: only the renter may
 *   close a rental (the protocol checks the recorded renter after moving the
 *   record to whoever holds the position, so the holder is the reader's own
 *   test, and the dry run catches a record that could not be moved);
 * - a rental past the end of its grace period: the protocol refuses a close
 *   then; the rental ends by its remaining days being settled one at a time
 *   (anyone may) or by a default, whichever comes first.
 * Deliberately NOT held: the protocol pause (a close is a close-out and stays
 * open), the sanctions screen (likewise), and the prepayment's size (the
 * review states the rent and late fee against it and refuses a shortfall
 * there, with the figures).
 */
import type { CopyAccess } from '../copy/useCopy';
import { formatUtc } from '../ui/format';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from './types';
import { STATUS_ACTIVE } from './repay';

type Hex = `0x${string}`;

/** `LibVaipakam.AssetType.ERC20`: a loan, not a rental. */
const ASSET_ERC20 = 0;

export interface CloseRentalInputs {
  status: number;
  assetType: number;
  /** Who holds the renter (borrower) position now; null when unread. */
  borrowerHolder: Hex | null;
  /** The effective end of the grace period (the loan clock); null when unread. */
  graceEnd: bigint | null;
  /** The latest block's time. */
  chainNow: bigint;
}

export function closeRentalVerdict(i: CloseRentalInputs, caller: Hex, copy: Pick<CopyAccess, 'text' | 'format'>, readAt: number): Verdict {
  const { text, format } = copy;
  const refuse = (code: string, reason: string): Verdict => closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], null, readAt, 'own');
  if (i.assetType === ASSET_ERC20) return refuse('NotARental', text('rentClose.notRental'));
  if (i.status !== STATUS_ACTIVE) return refuse('InvalidLoanStatus', text('rentClose.notRunning'));
  if (i.borrowerHolder === null || i.graceEnd === null) return unknownVerdict(text('rentClose.unread'));
  if (i.borrowerHolder.toLowerCase() !== caller.toLowerCase()) return refuse('NotBorrower', text('rentClose.notRenter'));
  if (i.chainNow > i.graceEnd) return refuse('RepaymentPastGracePeriod', format('rentClose.pastGrace', { time: formatUtc(Number(i.graceEnd)) }));
  return { ...OPEN, readAt, rail: 'own' };
}
