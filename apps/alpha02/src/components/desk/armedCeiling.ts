/**
 * The armed-ceiling-vs-quote comparison, extracted so it can be ASSERTED.
 *
 * It lived inline in `OpenOrdersPanel` (#1702/#1703), where the only tier that
 * could reach it is a Playwright drive of the desk UI — and the desk
 * components carry no test ids, so such a drive would locate by copy text on a
 * surface whose market must be matched first. A flaky spec is worse than a
 * documented gap, so the logic moved here instead: pure, typed, and covered by
 * `armedCeiling.test.ts` at the tier that can actually run it.
 *
 * Every condition below is a review finding from #1703, kept as code rather
 * than as a comment so a future edit has to confront them:
 *   - r1: the warning must not fire while arming is UNAVAILABLE, or the copy
 *     ("you can save this either way") contradicts a disabled Save button;
 *   - r1: an unparseable or zero ceiling is not "below the quote" — it is a
 *     different, already-surfaced validation failure;
 *   - r2: the quote must be for the fill still POSSIBLE, which is the caller's
 *     job (`principalCeiling` subtracts `amountFilled`) but is named here so
 *     the contract is visible at the comparison.
 */
import { parseUnits } from 'viem';
import { isPlainDecimal } from '../../lib/errors';
import { VPFI_DECIMALS } from '../../data/vpfi';

/** The ceiling the form would authorize, or undefined when the field does not
 *  yet express one (not opted in, blank, malformed, or zero). */
export function armedCeilingOf(fields: {
  full: boolean;
  ceiling: string;
} | null): bigint | undefined {
  if (!fields?.full || !isPlainDecimal(fields.ceiling)) return undefined;
  try {
    const v = parseUnits(fields.ceiling, VPFI_DECIMALS);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

/** True when the form should warn that the live quote has already passed the
 *  ceiling about to be authorized. `quoted` must be the quote for the largest
 *  fill the offer can STILL receive, and `armAllowed` the same availability
 *  state that enables Save. */
export function shouldWarnCeilingBelowQuote(args: {
  armAllowed: boolean;
  quoted: bigint | undefined;
  armedCeiling: bigint | undefined;
}): boolean {
  return (
    args.armAllowed &&
    args.quoted !== undefined &&
    args.armedCeiling !== undefined &&
    args.quoted > args.armedCeiling
  );
}
