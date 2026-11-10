/**
 * RW-02, RW-04, RW-06, RW-07 — what a VPFI deposit or withdrawal's receipt
 * adds for the fee-discount tier (RB-CONFIDENCE): a deposit counts toward
 * the tier and pledges nothing, the discount applies only while the
 * wallet's consent is on (stated as on, off or unread); a withdrawal works
 * the tier out again from what stays counted, says when it takes the
 * counted VPFI to zero (the holding time then restarts), and leaves the
 * consent as it is. A protected account's withdrawal is queued, and the
 * protocol books it against the counted VPFI only when the payout is
 * released (a cancelled one never is), so its notes put each tier effect
 * on that release; when the route was not read they say so instead of
 * naming either. Away from VPFI's home network a move there changes no
 * tier (the tier is a copy of the home network's), and the notes say so;
 * when that could not be read, they say that instead of a tier effect.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { PayoutRoute } from '../protection/payout';
import { emptiesTier, type VpfiFacts } from './vpfiFacts';

type Copy = Pick<CopyAccess, 'text'>;

function consentNote(f: VpfiFacts, { text }: Copy): string {
  return text(f.consent === true ? 'rewardsVault.consentOn' : f.consent === false ? 'rewardsVault.consentOff' : 'rewardsVault.consentUnread');
}

export function vpfiDepositNotes(f: VpfiFacts, copy: Copy): string[] {
  const { text } = copy;
  if (f.home === false) return [text('rewardsVault.depositAway')];
  return [text(f.home === null ? 'rewardsVault.homeUnread' : 'rewardsVault.depositTier'), consentNote(f, copy)];
}

export function vpfiWithdrawNotes(f: VpfiFacts, amount: bigint, route: PayoutRoute, copy: Copy): string[] {
  const { text } = copy;
  if (f.home === false) return [text('rewardsVault.withdrawAway'), text('rewardsVault.consentStays')];
  if (f.home === null) return [text('rewardsVault.homeUnread'), text('rewardsVault.consentStays')];
  const queued = route === 'queued' || route === 'held';
  if (!queued && route !== 'wallet') return [text('rewardsVault.withdrawRouteUnread'), text('rewardsVault.consentStays')];
  const empties = emptiesTier(f, amount);
  return [
    text(queued ? 'rewardsVault.withdrawQueuedTier' : 'rewardsVault.withdrawTier'),
    ...(empties === true ? [text(queued ? 'rewardsVault.withdrawQueuedEmpties' : 'rewardsVault.withdrawEmpties')] : []),
    ...(empties === null ? [text('rewardsVault.withdrawTrackedUnread')] : []),
    text('rewardsVault.consentStays'),
  ];
}
