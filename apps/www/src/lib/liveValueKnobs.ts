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

/**
 * `percent`: BPS in, a bare figure out. `count`: whole tokens, grouped.
 * `currency2` / `currency6`: a money amount at fixed precision — used by
 * the derived worked-example figures, which are USDC rather than BPS.
 */
export type KnobFormat = 'percent' | 'count' | 'currency2' | 'currency6';

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
  format: KnobFormat;
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
 * The worked example's own numbers (#1664 item 1).
 *
 * These are NARRATIVE, not configuration — the Overview walks through a
 * 1,000 USDC loan at 8% for 30 days, and those three are the story's
 * choice, not something governance can retune. They live here so the
 * figures derived from them sit next to the arithmetic that uses them
 * rather than being restated in prose in ten locales.
 */
export const EXAMPLE = {
  principal: 1_000,
  aprPercent: 8,
  days: 30,
} as const;

/** The example's interest, in USDC. Depends on no knob. */
const exampleInterest = () =>
  (EXAMPLE.principal * (EXAMPLE.aprPercent / 100) * EXAMPLE.days) / 365;

export type DerivedName =
  | 'exampleBorrowerReceives'
  | 'exampleLenderNet'
  | 'exampleTreasuryYieldFee'
  | 'exampleTreasuryYieldFeeExact';

export interface DerivedFigure {
  /**
   * Knobs this figure is computed from. Load-bearing for PROVENANCE, not
   * decoration: a derived figure may only claim `published` when EVERY
   * input was read live. One knob falling back to its bundled default
   * makes the whole result bundled, and a badge saying otherwise would
   * be the same over-claim the tooltip rules exist to prevent.
   */
  dependsOn: readonly KnobName[];
  /** Pure function of the resolved knob values (live-or-default). */
  compute: (k: Record<KnobName, number>) => number;
  format: KnobFormat;
}

/**
 * Figures the docs state as arithmetic, derived from the same config the
 * rates beside them come from.
 *
 * Why this exists: `Overview.en.md` printed `998`, `1,006.44` and `0.13`
 * as literals next to `{liveValue:loanInitiationFeeBps}` and
 * `{liveValue:treasuryFeeBps}`. All correct at 0.2% / 2% — and all
 * wrong the moment either is retuned, while the live half beside them
 * moves AND carries a `published` badge, so the contradiction reads as
 * authoritative rather than stale. That is the #1613 defect class
 * ("the rate says 2% and the arithmetic beneath says 1%") rebuilt on a
 * timer. Deriving them makes it unrepeatable rather than swept again.
 */
export const DERIVED_FIGURES: Record<DerivedName, DerivedFigure> = {
  // Principal minus the initiation fee — what actually reaches the
  // borrower.
  exampleBorrowerReceives: {
    dependsOn: ['loanInitiationFeeBps'],
    compute: (k) =>
      EXAMPLE.principal * (1 - k.loanInitiationFeeBps / 10_000),
    format: 'currency2',
  },
  // Principal + interest, less the treasury's cut of the INTEREST only.
  exampleLenderNet: {
    dependsOn: ['treasuryFeeBps'],
    compute: (k) =>
      EXAMPLE.principal +
      exampleInterest() * (1 - k.treasuryFeeBps / 10_000),
    format: 'currency2',
  },
  exampleTreasuryYieldFee: {
    dependsOn: ['treasuryFeeBps'],
    compute: (k) => exampleInterest() * (k.treasuryFeeBps / 10_000),
    format: 'currency2',
  },
  // The same figure unrounded. The page shows both, and the point of
  // the passage is that subtracting one ROUNDED number from another
  // leaves you a cent off — which only reads correctly if the rounded
  // and unrounded figures come from one computation.
  exampleTreasuryYieldFeeExact: {
    dependsOn: ['treasuryFeeBps'],
    compute: (k) => exampleInterest() * (k.treasuryFeeBps / 10_000),
    format: 'currency6',
  },
};

/** Every token name the `{liveValue:...}` namespace resolves. */
export type LiveValueName = KnobName | DerivedName;

export function isDerived(name: string): name is DerivedName {
  return name in DERIVED_FIGURES;
}

/**
 * Resolve a derived figure from the knob values a caller has already
 * resolved, returning the value and whether every input was live.
 *
 * Callers pass the resolved map rather than the raw config so the three
 * consumers (React, search index, markdown export) share one definition
 * of live-or-default per knob instead of each re-deriving it.
 */
export function resolveDerived(
  name: DerivedName,
  knobValues: Record<KnobName, number>,
  liveKnobs: ReadonlySet<KnobName>
): { value: number; isLive: boolean; format: KnobFormat } {
  const fig = DERIVED_FIGURES[name];
  return {
    value: fig.compute(knobValues),
    isLive: fig.dependsOn.every((k) => liveKnobs.has(k)),
    format: fig.format,
  };
}

/**
 * Format a knob value for a given document locale.
 *
 * Locale-aware on purpose. Hard-coding `en-US` was invisible while
 * nothing rendered and actively misleading once substitution worked: in
 * German `1,000` denotes one-point-zero, so an en-US-grouped VPFI
 * threshold reads on a German page as a threshold of ONE token.
 *
 * The two `currency*` formats pin BOTH bounds so a trailing zero is not
 * dropped — `998` where the surrounding prose says `998.00` reads as a
 * different kind of number, and the six-decimal form exists precisely to
 * show the digits the rounded one hides.
 */
export function formatKnob(value: number, format: KnobFormat, locale: string): string {
  switch (format) {
    case 'percent':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value / 100);
    case 'currency2':
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    case 'currency6':
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: 6,
        maximumFractionDigits: 6,
      }).format(value);
    case 'count':
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  }
}

/**
 * The default knob map, plus an empty live-set — what a build-time
 * consumer resolves derived figures against (#1664 item 1).
 *
 * Both callers here substitute compile-time DEFAULTS: neither has a
 * config snapshot. So every derived figure computes from defaults and is
 * correctly not-live, which is the honest answer for an artifact built
 * before any fetch happens.
 */
export function defaultKnobResolution(): {
  values: Record<KnobName, number>;
  live: ReadonlySet<KnobName>;
} {
  const values = {} as Record<KnobName, number>;
  for (const name of Object.keys(KNOB_DEFAULTS) as KnobName[]) {
    values[name] = KNOB_DEFAULTS[name].defaultValue;
  }
  return { values, live: new Set<KnobName>() };
}

/** Matches a whole inline-code token: `{liveValue:knobName}`. */
export const LIVE_VALUE_TOKEN_RE = /^\{liveValue:([a-zA-Z0-9]+)\}$/;
