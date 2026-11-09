/**
 * RW-02, RW-04, RW-06, RW-07 — what a VPFI deposit or withdrawal's receipt
 * adds for the fee-discount tier (RB-CONFIDENCE): a deposit counts toward
 * the tier and pledges nothing, the discount applies only while the
 * wallet's consent is on (stated as on, off or unread); a withdrawal works
 * the tier out again from what stays counted, says when it takes the
 * counted VPFI to zero (the holding time then restarts), and leaves the
 * consent as it is.
 */
import type { CopyAccess } from '../copy/useCopy';
import { emptiesTier, type VpfiFacts } from './vpfiFacts';

type Copy = Pick<CopyAccess, 'text'>;

function consentNote(f: VpfiFacts, { text }: Copy): string {
  return text(f.consent === true ? 'rewardsVault.consentOn' : f.consent === false ? 'rewardsVault.consentOff' : 'rewardsVault.consentUnread');
}

export function vpfiDepositNotes(f: VpfiFacts, copy: Copy): string[] {
  return [copy.text('rewardsVault.depositTier'), consentNote(f, copy)];
}

export function vpfiWithdrawNotes(f: VpfiFacts, amount: bigint, copy: Copy): string[] {
  const { text } = copy;
  const empties = emptiesTier(f, amount);
  return [
    text('rewardsVault.withdrawTier'),
    ...(empties === true ? [text('rewardsVault.withdrawEmpties')] : []),
    ...(empties === null ? [text('rewardsVault.withdrawTrackedUnread')] : []),
    text('rewardsVault.consentStays'),
  ];
}
