/**
 * What counts as a reported COUNT on the public transparency surfaces.
 *
 * ## Why this is a module and not an inline check
 *
 * `/analytics` already draws a line its own docstring calls load-bearing:
 * "ABSENT IS NOT ZERO … a fabricated zero is worse than an admitted gap".
 * Every counter is optional on the wire, and a missing one renders as
 * "not reported" rather than as `0`.
 *
 * ROUND 54 P2 found the line drawn in only one of the two places it has
 * to be. `resolveActiveSplit` refuses to do arithmetic with a negative,
 * infinite or NaN counter — it answers `unknown` — while the tile beside
 * it printed that same counter verbatim, because "is it a number?" was
 * the whole test there. So a wire response carrying `active: -1`
 * published "-1" as a protocol figure and withheld only the residual
 * derived from it: the page suppressed the CONSEQUENCE of the invalid
 * input while presenting the invalid input itself.
 *
 * Two definitions of "is this figure real" is the defect, not the second
 * one being wrong. There is one now, and both callers use it — the same
 * argument the forced-close card's `settled` note makes about two
 * definitions of "did our transaction take effect".
 *
 * ## What is rejected, and why each
 *
 * These are COUNTS of loans and offers. Every value below is a response
 * this page cannot substantiate, and the standing rule is that it must
 * then say what it does not know rather than render something:
 *
 * - `undefined` — the endpoint did not report the field. The original
 *   case, and the reason "not reported" exists.
 * - `NaN` / `±Infinity` — a number by `typeof` and not by any other
 *   measure. `NaN` in particular compares false against every bound, so
 *   an unguarded check waves it through and it reaches the reader as
 *   "NaN".
 * - Negative — no count is negative. A negative here means the producer
 *   is wrong about something, and the figure inherits that.
 * - Non-integer — likewise. A fractional count of loans is not a count
 *   that was rounded; it is one that was computed by something other
 *   than counting.
 *
 * Zero passes, and must: an empty deployment reports zero honestly, and
 * conflating that with a gap is the failure in the opposite direction.
 */

/** True when `value` is a count this surface may publish as reported. */
export function isReportedCount(value: number | undefined): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

/** The value if it may be published, `undefined` if it may not — so a
 *  caller can hand the result straight to a component whose `undefined`
 *  already means "not reported", without restating the rule. */
export function reportedCount(value: number | undefined): number | undefined {
  return isReportedCount(value) ? value : undefined;
}
