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
      return route.manager ? p.payoutRouteVaultManaged(shortAddress(route.manager)) : p.payoutRouteVault;
    case 'creditedToVault':
      return route.manager
        ? p.payoutRouteCreditedManaged(shortAddress(route.manager))
        : p.payoutRouteCreditedToVault;
    case 'unread':
      return p.payoutRouteUnknown;
  }
}

/** After the transaction, from its receipt: null when the wallet was paid.
 *  A queued row names its recipient when that is not `wallet` (the
 *  controller of an account moved to a new wallet), and a payment kept in a
 *  vault names who manages that vault when it is not `wallet`
 *  (`managerOf`: the account's controller once it is retired). */
export function payoutOutcomeText(
  outcome: PayoutOutcome,
  wallet: string | undefined,
  managerOf: (account: string) => string | null = () => null,
): string | null {
  const p = copy.protection;
  switch (outcome.kind) {
    case 'queued':
      return wallet && outcome.recipient.toLowerCase() !== wallet.toLowerCase()
        ? p.payoutOutcomeQueuedTo(shortAddress(outcome.recipient))
        : p.payoutOutcomeQueued;
    case 'held': {
      const m = managerOf(outcome.account);
      return m ? p.payoutOutcomeHeldManaged(shortAddress(m)) : p.payoutOutcomeHeld;
    }
    case 'inVault': {
      const m = managerOf(outcome.account);
      return m ? p.payoutOutcomeHeldManaged(shortAddress(m)) : p.payoutOutcomeInVault;
    }
    case 'paid':
      return null;
  }
}

/** Every outcome a receipt shows, each stated once, joined; null when the
 *  wallet was paid. */
export function payoutOutcomesText(
  outcomes: readonly PayoutOutcome[],
  wallet: string | undefined,
  managerOf?: (account: string) => string | null,
): string | null {
  const notes = [...new Set(outcomes.map((o) => payoutOutcomeText(o, wallet, managerOf)).filter((n): n is string => Boolean(n)))];
  return notes.length > 0 ? notes.join(' ') : null;
}
