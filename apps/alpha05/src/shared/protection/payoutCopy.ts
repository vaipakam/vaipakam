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
import type { LegOutcome } from '../tx/outcome';
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

/** A payment's finish-card legs, measured from the transaction's logs: one
 *  per place it went (the queue, kept in the vault, paid into the vault, and
 *  `wallet`, what reached the wallet itself), and whether they come to
 *  `expected` in all. `what` names an amount, `walletLeg` the wallet line,
 *  and `walletOther` a wallet-only payment that is not `expected`. */
export function payoutLegs(
  p: {
    outcomes: readonly PayoutOutcome[];
    wallet: bigint;
    expected: bigint;
    protection: Protection | null;
    what: (amount: bigint) => string;
    exact: (amount: bigint) => string;
    walletLeg: (what: string) => string;
    walletOther: (got: string, expected: string) => string;
  },
  copy: Copy,
): LegOutcome[] {
  const legs: LegOutcome[] = p.outcomes.map((o) => ({ status: 'done', label: routedLeg(o, p.what(o.amount), p.protection, copy) }));
  if (p.wallet > 0n || p.outcomes.length === 0) legs.push({ status: 'done', label: p.walletLeg(p.what(p.wallet)) });
  const total = p.outcomes.reduce((t, o) => t + o.amount, p.wallet);
  if (total === p.expected) return legs;
  const reason =
    p.outcomes.length === 0 ? p.walletOther(p.exact(total), p.exact(p.expected)) : copy.format('payout.totalOther', { amount: p.exact(total), expected: p.exact(p.expected) });
  const last = legs.at(-1)!;
  legs[legs.length - 1] = { status: total === 0n ? 'not-done' : 'unknown', label: last.label, reason };
  return legs;
}
