/**
 * LN-24 — where a running loan's current interest period stands against its
 * settlement, from the protocol's own preview (`previewPeriodicSettle`), the
 * deployment's periodic-settlement switch and the protocol pause, all read
 * beside it. The preview's "callable now" does not account for the switch or
 * the pause, so this is where they are put together: the switch first, then
 * the pause, then the period's own time. `settlePeriodicInterest` checks the
 * pause before the switch, but a switch that is off outlasts any pause, so
 * it is the sentence that stays true and the one stated. An unread input is a state of its own, stated as
 * unknown, never assumed on or off.
 */
import type { PeriodSchedule } from './loanView';

export type SettlementState =
  /** Settlement is switched off here: no period can be settled and no
   *  collateral is sold at a checkpoint. */
  | { kind: 'off' }
  | { kind: 'switch-unread' }
  /** The protocol is paused: settlement is stopped while it is. */
  | { kind: 'paused' }
  | { kind: 'pause-unread' }
  | { kind: 'time-unread' }
  /** The period is still running, or has ended and is in its grace. */
  | { kind: 'running'; ended: boolean; graceEndsAt: bigint; shortfall: bigint }
  /** Anyone may settle the period now. */
  | { kind: 'due'; shortfall: bigint };

export function settlementState(s: PeriodSchedule, periodicOn: boolean | null, paused: boolean | null, chainNow: bigint | null): SettlementState {
  if (periodicOn === false) return { kind: 'off' };
  if (periodicOn === null) return { kind: 'switch-unread' };
  if (paused === true) return { kind: 'paused' };
  if (paused === null) return { kind: 'pause-unread' };
  // The protocol's own verdict is the last word on "now"; the block time
  // read beside it only places a period that is not yet due.
  if (s.canSettleNow) return { kind: 'due', shortfall: s.shortfall };
  if (chainNow === null) return { kind: 'time-unread' };
  if (chainNow >= s.graceEndsAt) return { kind: 'due', shortfall: s.shortfall };
  return { kind: 'running', ended: chainNow >= s.periodEndAt, graceEndsAt: s.graceEndsAt, shortfall: s.shortfall };
}
