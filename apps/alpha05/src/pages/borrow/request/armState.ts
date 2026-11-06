/**
 * OFF-22 — the state of the Full tariff arm step that outlives its card:
 * the posted request it is bound to, and how the step ended when its card
 * was closed.
 */
import { tariffMatches, type OfferTariffState, type TariffChoice } from '../../../shared/offers/fullTariff';
import type { TxPhase } from '../../../shared/tx/outcome';

/** The posted request the tariff is armed on: the wallet and network that
 *  posted it (the review identity), its id, and the choice it was posted
 *  with. Every read, check and send is bound to this, never to whichever
 *  network the wallet is on now. */
export interface ArmContext {
  identity: string;
  offerId: bigint;
  choice: TariffChoice;
}

/** How the step ended when its card was closed. `armed` and `not-set` are
 *  read from the chain; `unknown` says a transaction was sent and may have
 *  set it; `skipped` says only that this step sent nothing, so the tariff is
 *  not on the request unless it was set some other way. */
export type ArmEnding = 'armed' | 'not-set' | 'unknown' | 'skipped';

/** The ending a closed card stands for, from the phase it was closed in and
 *  what the step last read of the request. A transaction that was sent and
 *  not measured (pending, unreadable, or replaced by another one) is
 *  unknown, never "not set". A read that found the choice already on the
 *  request (set from another tab or app) is armed, whatever the phase. */
export function armEnding(phase: TxPhase, readSet = false): ArmEnding {
  if (readSet) return 'armed';
  switch (phase.kind) {
    case 'measured':
      return phase.outcome.verdict === 'done' ? 'armed' : phase.outcome.verdict === 'not-done' ? 'not-set' : 'unknown';
    case 'superseded':
      return phase.reason === 'cancelled' ? 'skipped' : 'unknown';
    case 'signing':
    case 'submitted':
    case 'mined':
    case 'receipt-unknown':
      return 'unknown';
    default:
      return 'skipped';
  }
}

/** What a read of the request says about this step's choice, in the order
 *  that keeps every statement substantiated: another wallet's request first
 *  (nothing about it is this step's to say), then the choice already on it
 *  (whether or not a lender has since taken it, since the protocol fixes the
 *  tariff a loan opens under at the accept), then taken without it (the
 *  protocol no longer lets it be set, and that loan did not open under this
 *  choice), then open without it. */
export type ArmRead = 'not-creator' | 'set' | 'taken-unset' | 'open-unset';

export function armRead(now: OfferTariffState, account: string, choice: TariffChoice): ArmRead {
  if (now.creator.toLowerCase() !== account.toLowerCase()) return 'not-creator';
  if (tariffMatches(now.stored, choice)) return 'set';
  return now.accepted ? 'taken-unset' : 'open-unset';
}
