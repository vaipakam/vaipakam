/**
 * The grace clock a repayment shows while it is open (#3412).
 *
 * Once a loan is past its due date it is in grace. When grace ends, the
 * protocol refuses a repayment and anyone may file a default, so a
 * repayment sent close to the end races a default: whichever transaction
 * is mined first wins. The clock counts down to the end of grace by the
 * chain's own clock, estimated from the block timestamp the review read
 * plus the time since that read, and says to send early.
 *
 * It is a statement, never a gate: the review's own verdict, re-read
 * before sending, is what refuses a repayment past grace. A protocol pause
 * moves the end of grace later, which the next re-read picks up.
 */

/** Below this much grace left, the clock turns urgent. */
export const GRACE_URGENT_SECONDS = 3600;

export type GraceClock =
  /** Not in grace: not yet due, in fallback, or the dates are unread. */
  | { kind: 'none' }
  | { kind: 'running' | 'urgent'; endsAt: bigint; leftSeconds: number }
  /** Grace has ended by the estimated chain clock since the last read. A
   *  read already past grace shows nothing here: the review's verdict
   *  refuses it in its own words. */
  | { kind: 'ended'; endsAt: bigint };

export interface GraceDates {
  /** The effective due date; null when unread or in fallback. */
  maturity: bigint | null;
  /** The effective end of grace; null when unread or in fallback. */
  graceEnd: bigint | null;
  /** The block timestamp last read. */
  chainNow: bigint;
  /** When that block timestamp was read, in unix milliseconds. Always the
   *  time paired with `chainNow`, never the review's own read time, which
   *  an unchanged refresh keeps while `chainNow` moves on. */
  chainReadAt: number;
}

/** The chain's clock now, in unix seconds: the block timestamp read plus
 *  the whole seconds elapsed since the read (never less than the read). */
export function estimatedChainNow(d: Pick<GraceDates, 'chainNow' | 'chainReadAt'>, nowMs: number): bigint {
  return d.chainNow + BigInt(Math.max(0, Math.floor((nowMs - d.chainReadAt) / 1000)));
}

export function graceClock(d: GraceDates, nowMs: number): GraceClock {
  if (d.graceEnd === null || d.maturity === null) return { kind: 'none' };
  // The protocol accepts a repayment up to and including the last second
  // of grace, and refuses it after (the same rule the verdict applies).
  if (d.chainNow > d.graceEnd) return { kind: 'none' };
  const now = estimatedChainNow(d, nowMs);
  if (now < d.maturity) return { kind: 'none' };
  if (now > d.graceEnd) return { kind: 'ended', endsAt: d.graceEnd };
  const leftSeconds = Number(d.graceEnd - now);
  return { kind: leftSeconds <= GRACE_URGENT_SECONDS ? 'urgent' : 'running', endsAt: d.graceEnd, leftSeconds };
}
