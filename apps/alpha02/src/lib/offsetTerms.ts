/**
 * Term bound for the offset exit (#1535).
 *
 * Split out of OffsetFlow because it is pure arithmetic on a contract
 * boundary, and getting it wrong is silent: the form simply offers a
 * maximum that reverts, with an on-chain message about
 * lender-favourability that reads like the terms were unfair rather
 * than one second too long.
 */

/** Head-room between the replacement loan's maturity and the original's.
 *
 *  `PrecloseFacet` judges
 *  `block.timestamp + durationDays·1d > startTime + durationDays·1d`
 *  at MINE time, while the app judges it at READ time. The gap between
 *  the two is unbounded in principle — a slow block, a wallet sitting
 *  on the prompt — so the bound needs real slack rather than whatever
 *  flooring to whole days happens to leave behind. An hour is far
 *  beyond any plausible quote-to-mine delay, and costs a day of offered
 *  duration only when the remaining term sits within an hour of a day
 *  boundary. */
export const OFFSET_MATURITY_MARGIN_SEC = 3_600n;

/**
 * Longest replacement term the offset form may offer, in whole days.
 *
 * Two ceilings apply and the tighter wins: the original loan's maturity
 * (minus the margin above) and the protocol's live offer-duration cap.
 * Returns 0 when no term fits — the caller renders the
 * "too close to the due date" note rather than a form.
 *
 * @param loanEnd   original maturity, unix seconds
 * @param chainNow  chain clock the bound is computed against, unix seconds
 * @param capDays   protocol offer-duration ceiling, or undefined while unread
 */
export function offsetMaxDurationDays(
  loanEnd: bigint,
  chainNow: bigint,
  capDays: bigint | undefined,
): bigint {
  // Subtract the margin BEFORE flooring. Flooring alone looks like it
  // leaves slack, and usually does — but when the remaining term is an
  // exact multiple of a day (a loan opened moments ago, which is
  // precisely when someone reaches for an offset) it floors to the
  // loan's OWN duration and leaves none at all.
  const usableEnd = loanEnd - OFFSET_MATURITY_MARGIN_SEC;
  const remaining = usableEnd > chainNow ? (usableEnd - chainNow) / 86_400n : 0n;
  if (capDays === undefined) return remaining;
  return remaining < capDays ? remaining : capDays;
}
