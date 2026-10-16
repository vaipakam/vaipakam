/**
 * Display rules for the public recycling + loop-closure surfaces (#1349 M5).
 *
 * WHY THESE ARE NOT `formatTokenAmount`. That helper keeps four
 * SIGNIFICANT digits for small values, so a dust amount renders as
 * "0.00000000000000003" — readable on a wallet screen, but on an
 * accounting table it makes one column's precision differ per row, and a
 * reader comparing rows can no longer tell what the page rounded. These
 * surfaces use ONE fixed precision (four fractional digits of VPFI) and
 * state plainly when a figure falls below it. TokenomicsTechSpec
 * (§"Recycling transparency series") is the source of each rule:
 *
 *  - "a positive amount is never presented as zero" → a figure too small
 *    to survive the fixed precision is LABELLED as below it. A rounded-down
 *    zero is indistinguishable from a programme that absorbed nothing,
 *    which is the single reading the surface exists to prevent;
 *  - "a published share rounds in the direction that cannot overstate" →
 *    shares floor, never round, so a day that still drew a fresh floor can
 *    never display as fully self-funded;
 *  - "a caveat is shown only where its condition holds, judged at the
 *    precision the surface displays" → `displayedUnits` is the exact
 *    quantity a reader sees, so a caveat comparing figures compares what is
 *    on screen rather than raw wei the screen cannot show.
 *
 * Amounts arrive as decimal wei STRINGS and stay `bigint` until the final
 * locale format: an 18-decimal figure has more significant digits than a
 * double carries, and rounding a figure on a page that exists so figures
 * can be checked is a factual change, not a cosmetic one.
 */
import { copy } from '../content/copy';
import { localeDecimalString, localeNumber } from './format';

/** VPFI is an 18-decimal token. Every amount these surfaces show is VPFI. */
export const VPFI_DECIMALS = 18;

/** The fixed number of fractional VPFI digits the surfaces display. */
export const DISPLAY_FRACTION_DIGITS = 4;

/**
 * The smallest amount that survives display — 1e14 wei = 0.0001 VPFI.
 * Anything positive below it would truncate to "0", so it is labelled
 * instead.
 */
export const MIN_DISPLAYABLE_WEI =
  10n ** BigInt(VPFI_DECIMALS - DISPLAY_FRACTION_DIGITS);

/** The plain decimal-wei wire format. Nothing else is an amount. */
const WEI = /^\d+$/;

/** Is this value a well-formed decimal-wei amount string? */
export function isWeiString(v: unknown): v is string {
  return typeof v === 'string' && WEI.test(v);
}

/**
 * How many display units (0.0001 VPFI each) a reader SEES for this amount.
 *
 * Truncation, matching the formatter below exactly — the two must agree,
 * or a caveat would compare figures the reader is not shown. Used only to
 * decide whether a caveat's condition holds on screen; never displayed and
 * never summed into a figure of its own.
 */
export function displayedUnits(wei: string): bigint {
  return BigInt(wei) / MIN_DISPLAYABLE_WEI;
}

/** The fixed-precision decimal a reader sees, before locale formatting. */
function truncatedDecimal(value: bigint): string {
  const scale = 10n ** BigInt(VPFI_DECIMALS);
  const whole = value / scale;
  // TRUNCATED, not rounded: rounding up could show 1.0000 for an amount
  // that is genuinely below one, overstating in the one direction a
  // published account must not.
  const fraction = ((value % scale) / MIN_DISPLAYABLE_WEI)
    .toString()
    .padStart(DISPLAY_FRACTION_DIGITS, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * A VPFI amount, from decimal wei, in the reader's locale.
 *
 * Zero renders as zero — a true zero is a fact the platform can state, and
 * the below-precision label must mean "small", never "unknown". A positive
 * amount below the precision renders as "less than 0.0001" (in the
 * reader's number format), never as 0.
 *
 * @throws RangeError when `wei` is not a decimal wei string — callers
 *         validate first; a malformed figure is never coerced to zero.
 */
export function formatVpfiWei(wei: string, locale: string | undefined): string {
  if (!isWeiString(wei)) {
    throw new RangeError('formatVpfiWei: not a decimal wei string');
  }
  const value = BigInt(wei);
  if (value > 0n && value < MIN_DISPLAYABLE_WEI) {
    return copy.recycling.belowPrecision(
      localeDecimalString(truncatedDecimal(MIN_DISPLAYABLE_WEI), locale),
    );
  }
  return localeDecimalString(truncatedDecimal(value), locale);
}

/**
 * A SHORTFALL in VPFI, from decimal wei, rounded UP to the display unit.
 *
 * WHY A SEPARATE FORMATTER. Every other amount truncates, because for a
 * balance or a reserve the safe error is the one that understates. A
 * shortfall is the opposite kind of figure: understating it flatters the
 * platform — a published gap of 25.00009 VPFI truncates to "short by 25",
 * smaller than the breach actually is. Shares already round in the
 * direction that cannot overstate the platform's own health; this keeps a
 * breach figure consistent with that by rounding AWAY from the flattering
 * side: the shown gap is never smaller than the published one.
 *
 * The below-precision rule is unchanged: a positive gap under 0.0001 VPFI
 * is "less than 0.0001", never 0 — and never rounded up to "0.0001",
 * which would state a figure the indexer did not publish when a truthful
 * label is available. Zero renders as zero (the callers only pass a
 * shortfall the indexer published as non-null, but the formatter does not
 * assume it).
 *
 * Display-only: the rounded value is never compared or summed — a caveat
 * keyed on displayed precision uses `displayedUnits`, which truncates to
 * match `formatVpfiWei`, and no caveat is computed from a shortfall.
 *
 * @throws RangeError when `wei` is not a decimal wei string.
 */
export function formatVpfiWeiCeil(wei: string, locale: string | undefined): string {
  if (!isWeiString(wei)) {
    throw new RangeError('formatVpfiWeiCeil: not a decimal wei string');
  }
  const value = BigInt(wei);
  if (value > 0n && value < MIN_DISPLAYABLE_WEI) {
    return copy.recycling.belowPrecision(
      localeDecimalString(truncatedDecimal(MIN_DISPLAYABLE_WEI), locale),
    );
  }
  // Round up to the next whole display unit; an exact multiple is unchanged,
  // so `truncatedDecimal` then drops nothing.
  const rem = value % MIN_DISPLAYABLE_WEI;
  const ceiled = rem === 0n ? value : value - rem + MIN_DISPLAYABLE_WEI;
  return localeDecimalString(truncatedDecimal(ceiled), locale);
}

/**
 * The exact integer number of millionths in a value the indexer published
 * at six decimal places.
 *
 * The indexer computes every ratio in `bigint` and serves it as
 * `integer / 1e6`, so the integer is recoverable exactly — but
 * `value * 1e6` in floating point can land a hair below it (4.1 * 1e6 is
 * 4099999.9999999995), and flooring THAT would show a published runway of
 * exactly 4.1 days as 4.0. Snapping to the nearest integer when the
 * product is within float noise of one recovers the published value; a
 * value with genuinely more than six decimals (which the indexer never
 * sends) floors instead, so the recovery itself can never round a figure
 * up.
 */
function millionths(value: number): number {
  const scaled = value * 1_000_000;
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) < 1e-6 ? nearest : Math.floor(scaled);
}

/**
 * A published ratio as tenths of a percent, ROUNDED DOWN.
 *
 * `Math.round` would turn 0.9995 into 100%, presenting a day that still
 * drew a fresh floor as fully self-funded — and contradicting the runway
 * figure beside it, whose self-funded state is exact. Flooring means the
 * error can only understate, which is the safe direction for a figure the
 * platform publishes about itself (and, for loop closure, the metric is
 * defined as a conservative lower bound that may never overstate).
 *
 * No upper clamp: the self-funded share cannot exceed 1 by construction,
 * and loop closure's ratio may legitimately exceed it (absorption is not
 * bounded by the day's distribution), so clamping would misstate it.
 */
export function roundedDownTenthsOfPercent(ratio: number): number {
  return Math.floor(millionths(ratio) / 1_000);
}

/** The smallest share the surfaces display: one tenth of a percent. */
const MIN_DISPLAYABLE_PERCENT = 0.1;

/**
 * A published ratio as a rounded-down percentage, in the reader's locale.
 *
 * A POSITIVE ratio that floors to zero tenths is labelled "less than
 * 0.1%", never "0%". Flooring is what keeps a share from overstating, but
 * flooring a real 0.05% all the way to "0%" states the opposite fact — that
 * nothing was self-funded, or nothing stayed inside — which is the same
 * "a positive figure is never presented as zero" rule amounts follow
 * (TokenomicsTechSpec). A genuine zero ratio still renders as "0%".
 */
export function formatRoundedDownPercent(
  ratio: number,
  locale: string | undefined,
): string {
  const tenths = roundedDownTenthsOfPercent(ratio);
  if (ratio > 0 && tenths === 0) {
    return copy.recycling.shareBelowPrecision(
      localeNumber(MIN_DISPLAYABLE_PERCENT, locale),
    );
  }
  return copy.recycling.sharePct(
    localeNumber(tenths / 10, locale, {
      maximumFractionDigits: 1,
    }),
  );
}

/**
 * Does a set of PARTS visibly exceed a TOTAL, judged at the displayed
 * precision?
 *
 * WHY THIS IS NOT ONLY A UNITS COMPARISON. Comparing truncated display
 * units (`Σ displayedUnits(part) > displayedUnits(total)`) is exactly
 * right for figures shown as numbers — truncation can only lose, so a
 * units excess is both visible and real. But `displayedUnits` counts a
 * positive amount labelled "less than 0.0001" as 0 units, the same as a
 * true "0". A reader does not: "less than 0.0001" is visibly positive, so
 * parts of "less than 0.0001" and "0" over a total of "0" are on-screen
 * evidence the parts exceed the total even though every units count is 0.
 *
 * The precise rule, reading each displayed figure as the interval it
 * stands for — a shown number `u` units is [u, u+1) (truncated), "less than
 * 0.0001" is (0, 1), and a shown "0" is exactly 0 because a positive
 * amount would have been labelled instead:
 *  - against a TRUE ZERO total, any positive part is a visible excess;
 *  - against any other total, the parts must exceed it by at least one
 *    whole displayed unit, which is the units comparison (a below-precision
 *    part adds only an open (0, 1) and can never close that gap by itself —
 *    claiming an excess there could describe parts that equal the total).
 *
 * Both branches imply a REAL excess too, so the caveat this gates never
 * asserts a difference that does not exist. Amounts are decimal wei
 * strings; nothing here is displayed or published as a figure.
 */
export function partsVisiblyExceed(parts: string[], total: string): boolean {
  if (BigInt(total) === 0n) return parts.some((p) => BigInt(p) > 0n);
  const partUnits = parts.reduce((sum, p) => sum + displayedUnits(p), 0n);
  return partUnits > displayedUnits(total);
}

/**
 * A published day count (the runway) in tenths, ROUNDED DOWN.
 *
 * The runway is a programme-longevity figure; rounding it up would claim
 * more longevity than the published value supports.
 */
export function roundedDownTenths(value: number): number {
  return Math.floor(millionths(value) / 100_000);
}
