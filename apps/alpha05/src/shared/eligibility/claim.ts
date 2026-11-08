/**
 * RB-ELIG for collecting a loan's claim (LN-48 lender, LN-49 borrower): the
 * one rule that decides whether this wallet may run one side's claim now,
 * used by the loan page, the Claims page and the review alike. It reads the
 * inputs `claimAsLender` / `claimAsBorrower` check, in the order they check
 * them, and the dry run stays the protocol's last word (it also screens the
 * wallet against the sanctions list and a frozen claim's recorded party,
 * which no plain read answers the same way).
 *
 * What it holds, and why:
 * - the protocol pause: claims stop under it (RB-SWITCH class 2);
 * - a wallet the sanctions screen flags: every claim screens its caller
 *   first, so what is held for it stays frozen until it is de-listed
 *   (RB-FROZEN; the screen's outage alone never blocks a claim, and a side
 *   frozen for a recorded party is the dry run's to refuse);
 * - a loan state the side cannot claim in: a running loan, a settled one,
 *   and for the borrower a loan in fallback (the lender's claim, or a cure,
 *   resolves it first);
 * - a side already claimed;
 * - any wallet but that side's position holder (the claim pays the holder,
 *   whoever they are, never the party recorded at the start);
 * - nothing left to pay.
 */
import type { CopyAccess } from '../copy/useCopy';
import { sideClaimableStatus, sideOpen, type ClaimSide, type SideClaim } from '../claims/loanClaim';
import { frozenRefusal, type FrozenState } from '../sanctions/posture';
import { closed, OPEN, unknownVerdict, type Refusal, type Verdict } from './types';

type Hex = `0x${string}`;

/** `LibVaipakam.LoanStatus.Active` / `.Settled`. */
const STATUS_ACTIVE = 0;
const STATUS_SETTLED = 3;

export interface ClaimInputs {
  side: ClaimSide;
  status: number;
  loanAssetType: number;
  /** The protocol pause; null when unread. */
  paused: boolean | null;
  /** That side's position holder now; null when unread (or the position
   *  was burned by an earlier claim, which `claim.claimed` then says). */
  holder: Hex | null;
  /** The side's claim; null when unread. */
  claim: SideClaim | null;
  /** The caller's standing with the sanctions screen (RB-FROZEN); undefined
   *  or unknown never blocks: the dry run screens the caller too. */
  frozen?: FrozenState;
}

export function claimVerdict(i: ClaimInputs, caller: Hex, copy: Pick<CopyAccess, 'text'>, readAt: number): Verdict {
  const { text } = copy;
  const refuse = (code: string, reason: string, switchClass: '2' | null = null): Verdict =>
    closed([{ code, reason, reopensAt: null, remedy: null } satisfies Refusal], switchClass, readAt, 'own');
  if (i.paused === null) return unknownVerdict(text('loanClaim.unread'));
  if (i.paused) return refuse('EnforcedPause', text('loanClaim.paused'), '2');
  if (i.frozen === 'flagged') return closed([frozenRefusal('flagged', copy)], null, readAt, 'own');
  if (!sideClaimableStatus(i.side, i.status)) {
    if (i.status === STATUS_ACTIVE) return refuse('InvalidLoanStatus', text('loanClaim.running'));
    if (i.status === STATUS_SETTLED) return refuse('InvalidLoanStatus', text('loanClaim.settled'));
    return refuse('InvalidLoanStatus', text('loanClaim.fallbackWaits'));
  }
  if (i.claim === null) return unknownVerdict(text('loanClaim.unread'));
  // The lender's claim refuses a claimed row first, the borrower's an empty
  // side; each then checks the holder.
  const empty = (): Verdict => refuse(i.claim!.claimed ? 'AlreadyClaimed' : 'NothingToClaim', text(i.claim!.claimed ? 'loanClaim.already' : 'loanClaim.nothing'));
  if (i.side === 'lender' && i.claim.claimed) return empty();
  if (i.side === 'borrower' && !sideOpen('borrower', i.claim, i.loanAssetType)) return empty();
  if (i.holder === null) return unknownVerdict(text('loanClaim.unread'));
  if (i.holder.toLowerCase() !== caller.toLowerCase()) return refuse('NotNFTOwner', text(i.side === 'lender' ? 'loanClaim.notLender' : 'loanClaim.notBorrower'));
  if (!sideOpen(i.side, i.claim, i.loanAssetType)) return empty();
  return { ...OPEN, readAt, rail: 'own' };
}
