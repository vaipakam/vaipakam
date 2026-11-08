/**
 * Protected account mode in words: the one way every flow that pays the
 * wallet states where a payment goes before signing and where it went
 * after. Each flow names its own plain wallet route (a take-back says the
 * collateral comes from the vault, a claim does not); everything the mode
 * changes is said here, once, so two flows cannot describe the same queue
 * differently.
 */
import type { CopyAccess } from '../copy/useCopy';
import { formatSpan, formatUtc } from '../ui/format';
import type { PayoutOutcome, PayoutRoute, Protection } from './payout';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** Where a payment the mode routes away from the wallet lands, or null for
 *  the plain wallet route (the flow names it) and for an unread mode. A
 *  queued release that needs a secondary signer says so. */
export function routedDestination(route: PayoutRoute, protection: Protection | null, copy: Copy): string | null {
  switch (route) {
    case 'queued':
      return copy.format(protection?.requireCosign ? 'payout.toQueuedCosign' : 'payout.toQueued', { delay: formatSpan(protection?.delaySeconds ?? 0) });
    case 'held':
      return copy.text('payout.toHeld');
    case 'vault':
      return copy.text('payout.toVault');
    case 'wallet':
    case 'unknown':
      return null;
  }
}

/** The consequences the route adds to a receipt. */
export function routeNotes(route: PayoutRoute, protection: Protection | null, copy: Pick<CopyAccess, 'text'>): string[] {
  switch (route) {
    case 'queued':
      return [copy.text('payout.queuedNote'), ...(protection?.requireCosign ? [copy.text('payout.cosignNote')] : [])];
    case 'held':
      return [copy.text('payout.heldNote')];
    case 'vault':
      return [copy.text('payout.vaultNote')];
    case 'unknown':
      return [copy.text('payout.protectionUnread')];
    case 'wallet':
      return [];
  }
}

/** A routed payment's finish-card line: `what` (an amount or an NFT, in
 *  words) queued, kept in the vault, or paid into it. */
export function routedLeg(o: PayoutOutcome, what: string, protection: Protection | null, copy: Copy): string {
  if (o.kind === 'queued') return copy.format(protection?.requireCosign ? 'payout.legQueuedCosign' : 'payout.legQueued', { what, time: formatUtc(Number(o.releaseAt)) });
  if (o.kind === 'held') return copy.format('payout.legHeld', { what });
  return copy.format('payout.legVault', { what });
}

/** Whether a re-read moved anything the review said about the route: the
 *  route itself, or, for a queued payment, the delay or the secondary
 *  signer it states. */
export function routeChanged(a: { route: PayoutRoute; protection: Protection | null }, b: { route: PayoutRoute; protection: Protection | null }): boolean {
  if (a.route !== b.route) return true;
  return a.route === 'queued' && (a.protection?.delaySeconds !== b.protection?.delaySeconds || a.protection?.requireCosign !== b.protection?.requireCosign);
}
