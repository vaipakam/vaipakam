/**
 * #2071 — what the Protocol Console renders, as data.
 *
 * One list of sections and rows, so the page renders exactly these and the
 * coverage check (`protocolConsoleDocCoverage.ts`) can hold them against the
 * canonical knob reference. A row names its value by KEY, never by position
 * (the console's founding rule), and says how the value is written.
 */
import type { copy } from '../content/copy';
import type { ProtocolKnobValues } from './indexer';

type ConsoleCopy = (typeof copy)['protocolConsole'];
/** A `copy.protocolConsole` entry that is a plain string. */
export type ConsoleCopyKey = {
  [K in keyof ConsoleCopy]: ConsoleCopy[K] extends string ? K : never;
}[keyof ConsoleCopy];

export type RowFormat =
  /** Basis points, shown as a percent with the raw bps beside it. */
  | 'bps'
  /** A duration in seconds. */
  | 'seconds'
  /** A duration in seconds where zero means "unset, the documented
   *  default applies" (#2681); the row names that default. */
  | 'secondsOrDefault'
  /** A whole number of days. */
  | 'days'
  /** An on/off switch. */
  | 'flag'
  /** A pause switch: paused / running. */
  | 'pause'
  /** An address; the zero address reads as "not set". */
  | 'address'
  /** A 32-byte id; all zeros reads as "not set". */
  | 'bytes32'
  /** A short symbol packed into 32 bytes. */
  | 'symbol'
  /** An 18-decimal ratio (a health factor). */
  | 'wad'
  /** An 18-decimal amount in the protocol's numeraire. */
  | 'numeraireAmount'
  /** A unix time from which something may happen (#2843): said as now
   *  once it has passed, as the time and how long until it otherwise. Zero
   *  means the row's own `zeroMeans`. */
  | 'notBefore';

export type ConsoleValueKey = Exclude<keyof ProtocolKnobValues, 'tierThresholds' | 'tierDiscountBps'>;

export interface ConsoleRow {
  key: ConsoleValueKey;
  label: ConsoleCopyKey;
  hint?: ConsoleCopyKey;
  format: RowFormat;
  /** For `secondsOrDefault`: the documented default that applies while the
   *  setting is unset, in seconds. */
  documentedDefaultSeconds?: number;
  /** For `notBefore`: what a zero time means on this row, in words. */
  zeroMeans?: ConsoleCopyKey;
}

export interface ConsoleSection {
  id: string;
  heading: ConsoleCopyKey;
  rows: readonly ConsoleRow[];
}

/** Every section of value rows, in page order. The VPFI tier table is
 *  rendered on its own after these (two parallel arrays, keyed by tier). */
/**
 * Codex #2683 r3 — the day-close grace window that applies while governance
 * never set one. Source: the parameter reference
 * (`docs/ops/AdminConfigurableKnobsAndSwitches.md`, "Reward grace seconds":
 * "Default is 4 hours"). The app states it because the contract's getter
 * returns the raw zero instead of the window in force (#2681); once #2681
 * lands the getter answers the effective value and this constant goes.
 */
export const REWARD_GRACE_DOCUMENTED_DEFAULT_SECONDS = 4 * 3600;

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  {
    id: 'pc-fees',
    heading: 'feesHeading',
    rows: [
      { key: 'treasuryFeeBps', label: 'treasuryFee', hint: 'treasuryFeeHint', format: 'bps' },
      { key: 'loanInitiationFeeBps', label: 'loanInitiationFee', hint: 'loanInitiationFeeHint', format: 'bps' },
      { key: 'liquidationHandlingFeeBps', label: 'liquidationHandlingFee', format: 'bps' },
      { key: 'lifMatcherFeeBps', label: 'matcherFee', format: 'bps' },
    ],
  },
  {
    id: 'pc-risk',
    heading: 'riskHeading',
    rows: [
      { key: 'minHealthFactor', label: 'minHealthFactor', hint: 'minHealthFactorHint', format: 'wad' },
      { key: 'maxLiquidationSlippageBps', label: 'maxSlippage', format: 'bps' },
      { key: 'maxLiquidatorIncentiveBps', label: 'maxIncentive', format: 'bps' },
      { key: 'volatilityLtvThresholdBps', label: 'volatilityLtv', hint: 'volatilityLtvHint', format: 'bps' },
      { key: 'rentalBufferBps', label: 'rentalBuffer', format: 'bps' },
      { key: 'maxSwapToRepaySlippageBps', label: 'swapToRepaySlippage', format: 'bps' },
      { key: 'rateModel', label: 'rateModel', hint: 'rateModelHint', format: 'address' },
      { key: 'rateModelMaxDeviationBps', label: 'rateModelMaxDeviation', format: 'bps' },
    ],
  },
  {
    id: 'pc-oracles',
    heading: 'oraclesHeading',
    rows: [
      { key: 'secondaryOracleMaxDeviationBps', label: 'secondaryOracleMaxDeviation', format: 'bps' },
      { key: 'secondaryOracleMaxStalenessSeconds', label: 'secondaryOracleMaxStaleness', format: 'seconds' },
      { key: 'pythOracle', label: 'pythOracle', hint: 'pythOracleHint', format: 'address' },
      { key: 'pythCrossCheckFeedId', label: 'pythFeedId', hint: 'pythFeedIdHint', format: 'bytes32' },
      { key: 'pythMaxStalenessSeconds', label: 'pythMaxStaleness', format: 'seconds' },
      { key: 'pythCrossCheckMaxDeviationBps', label: 'pythMaxDeviation', format: 'bps' },
      { key: 'pythConfidenceMaxBps', label: 'pythConfidenceMax', format: 'bps' },
      { key: 'sequencerUptimeFeed', label: 'sequencerUptimeFeed', hint: 'sequencerUptimeFeedHint', format: 'address' },
    ],
  },
  {
    id: 'pc-limits',
    heading: 'limitsHeading',
    rows: [
      { key: 'autoPauseDurationSeconds', label: 'autoPause', format: 'seconds' },
      // #2843 — the cooldown between windows (#2744) and when the one
      // running ends, beside the window's own length.
      { key: 'autoPauseCooldownSeconds', label: 'autoPauseCooldown', hint: 'autoPauseCooldownHint', format: 'seconds' },
      {
        key: 'autoPauseAvailableAt',
        label: 'autoPauseAvailableAt',
        hint: 'autoPauseAvailableAtHint',
        format: 'notBefore',
        zeroMeans: 'autoPauseNeverFroze',
      },
      { key: 'maxOfferDurationDays', label: 'maxOfferDuration', format: 'days' },
    ],
  },
  {
    id: 'pc-flags',
    heading: 'flagsHeading',
    rows: [
      // The matching kill-switch. The two range flags that sat beside it
      // were retired in #2812: ranged offers are always on.
      { key: 'partialFillEnabled', label: 'partialFill', hint: 'partialFillHint', format: 'flag' },
    ],
  },
  {
    id: 'pc-periodic',
    heading: 'periodicHeading',
    rows: [
      { key: 'periodicInterestEnabled', label: 'periodicInterest', format: 'flag' },
      { key: 'minPrincipalForFinerCadence', label: 'finerCadenceMinPrincipal', hint: 'finerCadenceMinPrincipalHint', format: 'numeraireAmount' },
      { key: 'preNotifyDays', label: 'preNotifyDays', hint: 'preNotifyDaysHint', format: 'days' },
      { key: 'numeraireSymbol', label: 'numeraire', format: 'symbol' },
      { key: 'ethNumeraireFeed', label: 'numeraireFeed', hint: 'numeraireFeedHint', format: 'address' },
      { key: 'numeraireSwapEnabled', label: 'numeraireRotation', hint: 'numeraireRotationHint', format: 'flag' },
    ],
  },
  {
    id: 'pc-automation',
    heading: 'automationHeading',
    rows: [
      // Codex #2683 r4 — each switch states its scope, because none of
      // them stops everything its name suggests.
      { key: 'autoLendEnabled', label: 'autoLend', hint: 'autoLendHint', format: 'flag' },
      { key: 'lenderIntentEnabled', label: 'lenderIntentFills', hint: 'lenderIntentFillsHint', format: 'flag' },
      { key: 'minIntentFillNumeraire', label: 'minIntentFill', hint: 'minIntentFillHint', format: 'numeraireAmount' },
      { key: 'autoRefinanceEnabled', label: 'autoRefinance', hint: 'autoRefinanceHint', format: 'flag' },
      { key: 'autoExtendEnabled', label: 'autoExtend', hint: 'autoExtendHint', format: 'flag' },
      { key: 'keepersPaused', label: 'keepers', hint: 'keepersHint', format: 'pause' },
    ],
  },
  {
    id: 'pc-crosschain',
    heading: 'crossChainHeading',
    rows: [
      {
        key: 'rewardGraceSeconds',
        label: 'rewardGrace',
        hint: 'rewardGraceHint',
        format: 'secondsOrDefault',
        documentedDefaultSeconds: REWARD_GRACE_DOCUMENTED_DEFAULT_SECONDS,
      },
    ],
  },
  {
    id: 'pc-treasury',
    heading: 'treasuryHeading',
    rows: [{ key: 'treasury', label: 'treasuryAddress', format: 'address' }],
  },
];

/** Every value key the page renders, the tier table's included. */
export const RENDERED_KEYS: ReadonlySet<keyof ProtocolKnobValues> = new Set<keyof ProtocolKnobValues>([
  ...CONSOLE_SECTIONS.flatMap((s) => s.rows.map((r) => r.key)),
  'tierThresholds',
  'tierDiscountBps',
]);

/**
 * #2843 — a `notBefore` value against the reader's clock. The time is what
 * the source recorded; only whether it has passed is judged here, so the
 * page always shows the time beside the verdict and the verdict can be
 * checked. `unreadable` is a value that is not a whole number of seconds a
 * date can carry, which the page shows raw rather than as a date.
 */
export type NotBeforeReading =
  | { kind: 'none' }
  | { kind: 'passed'; at: number }
  | { kind: 'ahead'; at: number; inSec: number }
  | { kind: 'unreadable' };

/** Far enough for any timestamp a `Date` can represent (8.64e15 ms). */
const MAX_DATE_SEC = 8_640_000_000_000;

export function readNotBefore(value: string, nowSec: number): NotBeforeReading {
  if (!/^\d+$/.test(value)) return { kind: 'unreadable' };
  const at = Number(value);
  if (!Number.isSafeInteger(at) || at > MAX_DATE_SEC) return { kind: 'unreadable' };
  if (at === 0) return { kind: 'none' };
  return at <= nowSec ? { kind: 'passed', at } : { kind: 'ahead', at, inSec: at - nowSec };
}
