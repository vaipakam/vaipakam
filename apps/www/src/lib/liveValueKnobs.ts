/**
 * The knob registry behind `{liveValue:...}` doc tokens — the single
 * source of truth for what each token resolves to and how it formats.
 *
 * Why this is separate from `LiveValue.tsx` (#1606 review)
 * -------------------------------------------------------
 * Two different consumers substitute these tokens, and they must not
 * disagree:
 *
 *  - `LiveValue.tsx` renders them in the React doc pages.
 *  - `scripts/liveValueMarkdown.ts` substitutes the same tokens in the
 *    raw markdown published as machine-readable artifacts (`/docs/*.md`,
 *    `llms-full.txt`) that `llms.txt` advertises to AI crawlers.
 *
 * The React fix alone left 420 raw tokens in those artifacts — crawlers
 * were still being served the internal syntax the fix was meant to
 * eliminate. Rather than duplicate the defaults into a build script and
 * let them drift, both import this module.
 *
 * React-free on purpose: the build script imports it, and pulling React
 * into a prebuild step would be gratuitous.
 */

export type KnobName =
  | 'treasuryFeeBps'
  | 'loanInitiationFeeBps'
  | 'tier1Min'
  | 'tier2Min'
  | 'tier3Min'
  | 'tier4Min'
  | 'tier1DiscountBps'
  | 'tier2DiscountBps'
  | 'tier3DiscountBps'
  | 'tier4DiscountBps';

export interface KnobDefault {
  /** Compile-time default, mirroring the on-chain library constant. */
  defaultValue: number;
  /**
   * `percent`: BPS in, a bare figure out — no `%` sign. The sign lives
   * in the markdown so translators control placement (French puts a
   * non-breaking space before it).
   *
   * `count`: whole tokens, grouped.
   */
  format: 'percent' | 'count';
}

export const KNOB_DEFAULTS: Record<KnobName, KnobDefault> = {
  // 2% since the #1352 fee freeze (mirrors LibVaipakam.TREASURY_FEE_BPS).
  treasuryFeeBps: { defaultValue: 200, format: 'percent' },
  // 0.2% since the #1352 fee freeze (LibVaipakam.LOAN_INITIATION_FEE_BPS).
  loanInitiationFeeBps: { defaultValue: 20, format: 'percent' },
  tier1Min: { defaultValue: 100, format: 'count' },
  tier2Min: { defaultValue: 1_000, format: 'count' },
  tier3Min: { defaultValue: 5_000, format: 'count' },
  tier4Min: { defaultValue: 20_000, format: 'count' },
  tier1DiscountBps: { defaultValue: 1_000, format: 'percent' },
  tier2DiscountBps: { defaultValue: 1_500, format: 'percent' },
  tier3DiscountBps: { defaultValue: 2_000, format: 'percent' },
  tier4DiscountBps: { defaultValue: 2_400, format: 'percent' },
};

/**
 * Format a knob value for a given document locale.
 *
 * Locale-aware on purpose. Hard-coding `en-US` was invisible while
 * nothing rendered and actively misleading once substitution worked: in
 * German `1,000` denotes one-point-zero, so an en-US-grouped VPFI
 * threshold reads on a German page as a threshold of ONE token.
 */
export function formatKnob(value: number, format: 'percent' | 'count', locale: string): string {
  return format === 'percent'
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 100)
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** Matches a whole inline-code token: `{liveValue:knobName}`. */
export const LIVE_VALUE_TOKEN_RE = /^\{liveValue:([a-zA-Z0-9]+)\}$/;
