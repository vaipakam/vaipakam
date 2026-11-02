/**
 * Plain-language text for where a payment to the connected wallet lands
 * (protected account mode), shared by every surface that pays it.
 */
import { copy } from '../content/copy';
import { formatExactSpan, shortAddress } from './format';
import type { OwnPayoutRoute, PayoutOutcome } from '../data/protectedAccount';

/** Before the transaction: null when the payment goes straight to the
 *  wallet, otherwise the sentence that replaces any promise of it. */
export function payoutRouteText(route: OwnPayoutRoute): string | null {
  const p = copy.protection;
  switch (route.kind) {
    case 'wallet':
      return null;
    case 'queued':
      return `${
        route.to
          ? p.payoutRouteQueuedTo(formatExactSpan(route.delaySeconds), shortAddress(route.to))
          : p.payoutRouteQueued(formatExactSpan(route.delaySeconds))
      }${route.cosign ? ` ${p.payoutRouteCosign}` : ''}`;
    case 'vault':
      return p.payoutRouteVault;
    case 'creditedToVault':
      return p.payoutRouteCreditedToVault;
    case 'unread':
      return p.payoutRouteUnknown;
  }
}

/** After the transaction, from its receipt: null when the wallet was paid.
 *  A queued row names its recipient when that is not `wallet` (the
 *  controller of an account moved to a new wallet). */
export function payoutOutcomeText(outcome: PayoutOutcome, wallet: string | undefined): string | null {
  const p = copy.protection;
  switch (outcome.kind) {
    case 'queued':
      return wallet && outcome.recipient.toLowerCase() !== wallet.toLowerCase()
        ? p.payoutOutcomeQueuedTo(shortAddress(outcome.recipient))
        : p.payoutOutcomeQueued;
    case 'held':
      return p.payoutOutcomeHeld;
    case 'inVault':
      return p.payoutOutcomeInVault;
    case 'paid':
      return null;
  }
}
