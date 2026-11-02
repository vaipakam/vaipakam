/**
 * Plain-language text for where a payment to the connected wallet lands
 * (protected account mode), shared by every surface that pays it.
 */
import { copy } from '../content/copy';
import { formatExactSpan } from './format';
import type { OwnPayoutRoute, PayoutOutcome } from '../data/protectedAccount';

/** Before the transaction: null when the payment goes straight to the
 *  wallet, otherwise the sentence that replaces any promise of it. */
export function payoutRouteText(route: OwnPayoutRoute): string | null {
  const p = copy.protection;
  switch (route.kind) {
    case 'wallet':
      return null;
    case 'queued':
      return `${p.payoutRouteQueued(formatExactSpan(route.delaySeconds))}${route.cosign ? ` ${p.payoutRouteCosign}` : ''}`;
    case 'vault':
      return p.payoutRouteVault;
    case 'unread':
      return p.payoutRouteUnknown;
  }
}

/** After the transaction, from its receipt: null when the wallet was paid. */
export function payoutOutcomeText(outcome: PayoutOutcome): string | null {
  const p = copy.protection;
  return outcome === 'queued'
    ? p.payoutOutcomeQueued
    : outcome === 'held'
      ? p.payoutOutcomeHeld
      : outcome === 'inVault'
        ? p.payoutOutcomeInVault
        : null;
}
