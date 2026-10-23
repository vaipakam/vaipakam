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
  | 'numeraireAmount';

export type ConsoleValueKey = Exclude<keyof ProtocolKnobValues, 'tierThresholds' | 'tierDiscountBps'>;

export interface ConsoleRow {
  key: ConsoleValueKey;
  label: ConsoleCopyKey;
  hint?: ConsoleCopyKey;
  format: RowFormat;
  /** For `secondsOrDefault`: the documented default that applies while the
   *  setting is unset, in seconds. */
  documentedDefaultSeconds?: number;
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
      { key: 'maxOfferDurationDays', label: 'maxOfferDuration', format: 'days' },
    ],
  },
  {
    id: 'pc-flags',
    heading: 'flagsHeading',
    rows: [
      { key: 'rangeAmountEnabled', label: 'rangeAmount', format: 'flag' },
      { key: 'rangeRateEnabled', label: 'rangeRate', format: 'flag' },
      { key: 'partialFillEnabled', label: 'partialFill', format: 'flag' },
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
      { key: 'numeraireSwapEnabled', label: 'numeraireRotation', hint: 'numeraireRotationHint', format: 'flag' },
    ],
  },
  {
    id: 'pc-automation',
    heading: 'automationHeading',
    rows: [
      { key: 'autoLendEnabled', label: 'autoLend', format: 'flag' },
      { key: 'autoRefinanceEnabled', label: 'autoRefinance', format: 'flag' },
      { key: 'autoExtendEnabled', label: 'autoExtend', format: 'flag' },
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
