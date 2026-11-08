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
 *
 * The preview and the chain time are read at the same block, so the
 * preview's "callable now" is the last word on whether a period can be
 * settled. A period past its grace that the preview does not call settleable
 * belongs to a loan that is not running (in fallback, or ended at that
 * block): the protocol settles none of its periods, and that is what is
 * stated, never a sale.
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
  /** The period is past its grace but the protocol does not settle it: the
   *  loan is not running. */
  | { kind: 'held' }
  /** Anyone may settle the period now. */
  | { kind: 'due'; shortfall: bigint };

export function settlementState(s: PeriodSchedule, periodicOn: boolean | null, paused: boolean | null, chainNow: bigint | null): SettlementState {
  if (periodicOn === false) return { kind: 'off' };
  if (periodicOn === null) return { kind: 'switch-unread' };
  if (paused === true) return { kind: 'paused' };
  if (paused === null) return { kind: 'pause-unread' };
  // The protocol's own verdict is the last word on "now"; the block time,
  // read at the same block, only places a period that is not settleable.
  if (s.canSettleNow) return { kind: 'due', shortfall: s.shortfall };
  if (chainNow === null) return { kind: 'time-unread' };
  if (chainNow >= s.graceEndsAt) return { kind: 'held' };
  return { kind: 'running', ended: chainNow >= s.periodEndAt, graceEndsAt: s.graceEndsAt, shortfall: s.shortfall };
}
