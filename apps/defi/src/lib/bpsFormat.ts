/**
 * @file BPS / percent formatting helpers.
 *
 * Per the UX direction ADR (`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`
 * Tier A.6, merged via PR #201), every rate / fee surface in
 * `apps/defi` should:
 *
 *  1. Render a percentage with a sensible precision for the active
 *     surface (sliders, table cells, modal summaries).
 *  2. Expose the underlying **basis-points** value on hover, mirroring
 *     how Binance / Bybit / rate-based AMMs surface fee tiers
 *     (`0.10% (10 bps)` on tooltip).
 *
 * The protocol stores rates and fees exclusively in basis points
 * (`interestRateBps`, `liquidationLtvBps`, `treasuryFeeBps`, etc.;
 * `BASIS_POINTS = 10_000`), and component code crossing from the
 * stored value to the displayed value should never lose that
 * grounding — a user reading a slider at `5.05 %` should be able to
 * confirm via hover that the same value the chain receives is `505`.
 *
 * This module is pure-function — no React, no I/O — so it composes
 * inside any rendering layer (`<BpsValue/>` JSX, server logs, even
 * console diagnostics). The matching React surface is
 * `apps/defi/src/components/app/BpsValue.tsx`.
 *
 * Math discipline: BPS-to-percent is `bps / 100` (not `bps / 10_000`),
 * since 1 % = 100 bps. The protocol's `BASIS_POINTS` constant
 * (`10_000`) is the BPS-to-fraction divisor (`bps / 10_000 = decimal
 * fraction`), a different conversion entirely; the protocol uses
 * fractions for math, the UI uses percent for display.
 */

/**
 * Options for {@link formatBps}.
 */
export interface FormatBpsOptions {
  /**
   * Decimal places to render on the percent. Defaults to 2 — sufficient
   * to disambiguate `5 bps` (0.05 %) from `50 bps` (0.50 %) on the
   * display while not implying false precision on the larger rates.
   *
   * Surface-specific overrides:
   *  - Health-Factor + LTV chips: precision 1 (less noise).
   *  - LIF / treasury-fee rows: precision 2 (default).
   *  - Tier-comparison tables where small deltas matter: precision 3.
   */
  precision?: number;
  /**
   * When true, the tooltip text includes the `bps` qualifier in
   * parentheses (`5.05 % (505 bps)`); when false, the tooltip is just
   * the formatted percent (no BPS hint). Defaults to true.
   *
   * Set to false for surfaces where the BPS value would confuse a
   * non-DeFi reader (e.g., a marketing card embedded in the app).
   */
  withBpsHint?: boolean;
  /**
   * BCP-47 locale tag for percent / number formatting (e.g. `'en'`,
   * `'fr'`, `'de'`, `'hi'`). Routes through `Intl.NumberFormat` so the
   * decimal separator, digit shaping, and grouping match the user's
   * locale — a French user sees `"5,05 %"` instead of `"5.05 %"`.
   *
   * Defaults to undefined → falls back to the JS runtime's default
   * locale (typically the browser UI locale on the client). React
   * surfaces should pass `i18n.language` from `useTranslation()`
   * explicitly so the percent display tracks the active app locale
   * even when it differs from the browser default.
   *
   * The `%` glyph and the `bps` qualifier stay literal — they're
   * technical DeFi terms that don't translate per locale. Localising
   * them would diverge from how other DeFi surfaces (Uniswap,
   * 1inch, Aave) render the same units.
   */
  locale?: string;
}

/**
 * Result of {@link formatBps} — the display string plus the tooltip
 * text. Caller decides where each lands in the DOM (the React
 * companion `<BpsValue/>` puts `display` in the visible slot and
 * `tooltip` in `title=`).
 */
export interface FormattedBps {
  /** Visible percent display, e.g. `"5.05 %"`. */
  display: string;
  /**
   * Tooltip text. With `withBpsHint=true` (default):
   * `"5.05 % (505 bps)"`. With `withBpsHint=false`: same as
   * `display`.
   */
  tooltip: string;
}

/**
 * Format a basis-points value for display.
 *
 * @example
 * formatBps(505)                          // { display: "5.05 %", tooltip: "5.05 % (505 bps)" }
 * formatBps(505, { precision: 1 })        // { display: "5.1 %", tooltip: "5.1 % (505 bps)" }
 * formatBps(10)                           // { display: "0.10 %", tooltip: "0.10 % (10 bps)" }
 * formatBps(0)                            // { display: "0.00 %", tooltip: "0.00 % (0 bps)" }
 * formatBps(505, { withBpsHint: false })  // { display: "5.05 %", tooltip: "5.05 %" }
 *
 * @param bps The raw basis-points value. Negative inputs are accepted
 *            and rendered with a leading minus (e.g. an indicator chip
 *            for a tier downgrade); zero is rendered explicitly.
 * @param opts {@link FormatBpsOptions}.
 */
export function formatBps(
  bps: number,
  opts: FormatBpsOptions = {},
): FormattedBps {
  const { precision = 2, withBpsHint = true, locale } = opts;

  // Coerce non-finite inputs to a stable display. NaN / Infinity must
  // never reach the DOM — every consumer of this helper either has a
  // typed `number` already or is rendering off a viem-read that has
  // its own zero-default; surfacing 'NaN %' would be a regression so
  // worth catching here defensively.
  if (!Number.isFinite(bps)) {
    return { display: '— %', tooltip: '—' };
  }

  // 1 % == 100 bps. Render the percent at the requested precision.
  // The integer BPS is preserved in the tooltip exactly — no rounding
  // — so the on-chain truth stays visible even when display precision
  // is coarse.
  const percent = bps / 100;

  // Locale-aware number formatting — French gets `5,05`, German gets
  // `5,05`, Arabic gets `٥٫٠٥` (Arabic-Indic digits), Hindi gets the
  // Indian-style grouping at higher magnitudes. `Intl.NumberFormat`
  // handles digit shaping + decimal separator + grouping in one call.
  // The `%` glyph and the `bps` qualifier stay literal — see the JSDoc
  // on FormatBpsOptions.locale for the rationale.
  const numberFmt = new Intl.NumberFormat(locale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  const display = `${numberFmt.format(percent)} %`;

  // The BPS qualifier in the tooltip uses Intl too so the integer
  // digit shaping matches the percent on the same display (consistent
  // numerals in `"5,05 % (505 bps)"` → matching Latin digits;
  // `"٥٫٠٥ % (٥٠٥ bps)"` → matching Arabic-Indic digits).
  const tooltip = withBpsHint
    ? `${display} (${new Intl.NumberFormat(locale, {
        maximumFractionDigits: 0,
      }).format(bps)} bps)`
    : display;

  return { display, tooltip };
}

/**
 * Short helper for surfaces that only need the visible string (e.g.,
 * a one-line table cell rendered with `dangerouslySetInnerHTML` or a
 * non-tooltip-capable shell). Equivalent to `formatBps(bps, opts).display`.
 */
export function bpsToDisplay(bps: number, opts: FormatBpsOptions = {}): string {
  return formatBps(bps, opts).display;
}

/**
 * Short helper for the inverse case (tooltip-only). Equivalent to
 * `formatBps(bps, opts).tooltip`.
 */
export function bpsToTooltip(bps: number, opts: FormatBpsOptions = {}): string {
  return formatBps(bps, opts).tooltip;
}
