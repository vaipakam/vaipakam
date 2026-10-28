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
  /** An 18-decimal VPFI amount. */
  | 'vpfiAmount'
  /** A health factor in basis points of the HF scale (10000 = 1.0). */
  | 'hfBps'
  /** A short lowercase symbol packed into 32 bytes, shown as its text. */
  | 'symbolText'
  /** A unix time from which something may happen (#2843): said as now
   *  once it has passed, as the time and how long until it otherwise. Zero
   *  means the row's own `zeroMeans`. */
  | 'notBefore';

/** The values with a row of their own; the tier table and the grace
 *  schedule are lists, rendered on their own after the sections. */
export type ConsoleValueKey = Exclude<keyof ProtocolKnobValues, 'tierThresholds' | 'tierDiscountBps' | 'graceBuckets'>;

export interface ConsoleRow {
  key: ConsoleValueKey;
  label: ConsoleCopyKey;
  hint?: ConsoleCopyKey;
  format: RowFormat;
  /** For `secondsOrDefault`: the documented default that applies while the
   *  setting is unset, in seconds. */
  documentedDefaultSeconds?: number;
  /** What a zero value means on this row, in words, when it means more
   *  than "not set": for `notBefore` a zero time, for `address`,
   *  `numeraireAmount` and `symbolText` the zero value. */
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

/** One row of the loan-default grace schedule: loans shorter than
 *  `maxDurationDays` (0 marks the catch-all last row) get `graceSeconds`. */
export interface GraceScheduleRow {
  maxDurationDays: number;
  graceSeconds: number;
}

/**
 * #2680 — the grace schedule that applies while governance never set one.
 * Source: the parameter reference (`docs/ops/AdminConfigurableKnobsAndSwitches.md`,
 * "Loan-default grace buckets", "Default schedule"). The getter answers an
 * empty list in that case, not the schedule in force, so the page states the
 * documented one and marks it as the default. A test holds this against the
 * document's table.
 */
export const GRACE_DOCUMENTED_DEFAULT_SCHEDULE: readonly GraceScheduleRow[] = [
  { maxDurationDays: 7, graceSeconds: 3600 },
  { maxDurationDays: 30, graceSeconds: 86_400 },
  { maxDurationDays: 90, graceSeconds: 3 * 86_400 },
  { maxDurationDays: 180, graceSeconds: 7 * 86_400 },
  { maxDurationDays: 365, graceSeconds: 14 * 86_400 },
  { maxDurationDays: 0, graceSeconds: 30 * 86_400 },
];

/** The grace schedule a source published: `unset` for the empty list
 *  (the documented default applies), `null` when it is absent or not the
 *  shape the reader publishes, which the page shows as not reported. */
export function readGraceSchedule(v: unknown): readonly GraceScheduleRow[] | 'unset' | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return 'unset';
  const rows: GraceScheduleRow[] = [];
  for (const r of v as unknown[]) {
    if (typeof r !== 'object' || r === null) return null;
    const { maxDurationDays, graceSeconds } = r as Record<string, unknown>;
    if (typeof maxDurationDays !== 'string' || typeof graceSeconds !== 'string') return null;
    if (!/^\d+$/.test(maxDurationDays) || !/^\d+$/.test(graceSeconds)) return null;
    const d = Number(maxDurationDays);
    const g = Number(graceSeconds);
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(g)) return null;
    rows.push({ maxDurationDays: d, graceSeconds: g });
  }
  return rows;
}

export const CONSOLE_SECTIONS: readonly ConsoleSection[] = [
  {
    id: 'pc-fees',
    heading: 'feesHeading',
    rows: [
      { key: 'treasuryFeeBps', label: 'treasuryFee', hint: 'treasuryFeeHint', format: 'bps' },
      { key: 'loanInitiationFeeBps', label: 'loanInitiationFee', hint: 'loanInitiationFeeHint', format: 'bps' },
      { key: 'liquidationHandlingFeeBps', label: 'liquidationHandlingFee', format: 'bps' },
      { key: 'lifMatcherFeeBps', label: 'matcherFee', format: 'bps' },
      { key: 'notificationFeeVpfi', label: 'notificationFee', hint: 'notificationFeeHint', format: 'vpfiAmount' },
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
      { key: 'rateModelMaxDeviationBps', label: 'rateBandPointsCap', hint: 'rateBandHint', format: 'bps' },
      { key: 'rateModelRelativeDeviationBps', label: 'rateBandMarketShare', format: 'bps' },
      { key: 'rateModelMinDeviationBps', label: 'rateBandPointsFloor', format: 'bps' },
    ],
  },
  {
    // #2680 — graduated partial-liquidation sizing (#395) and the
    // liquidator discount per liquidity tier, each read as one part of a
    // multi-part answer.
    id: 'pc-liquidation',
    heading: 'liquidationHeading',
    rows: [
      { key: 'partialLiqTargetHfCeilingBps', label: 'partialLiqCeiling', hint: 'partialLiqCeilingHint', format: 'hfBps' },
      { key: 'partialLiqDeepUnderwaterHfBps', label: 'partialLiqDeep', hint: 'partialLiqDeepHint', format: 'hfBps' },
      {
        key: 'partialLiqDustFloorNumeraire',
        label: 'partialLiqDustFloor',
        hint: 'partialLiqDustFloorHint',
        format: 'numeraireAmount',
        zeroMeans: 'partialLiqDustFloorOff',
      },
      { key: 'tier1LiqDiscountBps', label: 'liqDiscountTier1', hint: 'liqDiscountHint', format: 'bps' },
      { key: 'tier2LiqDiscountBps', label: 'liqDiscountTier2', format: 'bps' },
      { key: 'tier3LiqDiscountBps', label: 'liqDiscountTier3', format: 'bps' },
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
      // #2680 — the registry and the keys the oracle asks it under.
      { key: 'feedRegistry', label: 'feedRegistry', hint: 'feedRegistryHint', format: 'address' },
      { key: 'feedRegistryPrimaryKey', label: 'feedRegistryPrimaryKey', hint: 'feedRegistryPrimaryKeyHint', format: 'address' },
      { key: 'feedRegistryEthKey', label: 'feedRegistryEthKey', hint: 'feedRegistryEthKeyHint', format: 'address' },
      { key: 'wethContract', label: 'wethContract', hint: 'wethContractHint', format: 'address' },
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
    ],
  },
  {
    // #2680 — the reference currency moved here from the periodic section,
    // beside the pricing anchor it is converted from.
    id: 'pc-numeraire',
    heading: 'numeraireHeading',
    rows: [
      { key: 'numeraireSymbol', label: 'numeraire', format: 'symbol' },
      { key: 'ethNumeraireFeed', label: 'numeraireFeed', hint: 'numeraireFeedHint', format: 'address' },
      { key: 'numeraireSwapEnabled', label: 'numeraireRotation', hint: 'numeraireRotationHint', format: 'flag' },
      {
        key: 'predominantDenominator',
        label: 'padDenominator',
        hint: 'padDenominatorHint',
        format: 'address',
        zeroMeans: 'padDenominatorUnset',
      },
      {
        key: 'predominantDenominatorSymbol',
        label: 'padSymbol',
        hint: 'padSymbolHint',
        format: 'symbolText',
      },
      { key: 'ethPadFeed', label: 'padEthFeed', hint: 'padEthFeedHint', format: 'address' },
      { key: 'padNumeraireRateFeed', label: 'padRateFeed', hint: 'padRateFeedHint', format: 'address' },
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
    // #2680 — the swap venues with a protocol-wide switch. The 0x proxy and
    // the Uniswap V3 factory have no read, so they are not here.
    id: 'pc-venues',
    heading: 'venuesHeading',
    rows: [
      { key: 'pancakeswapV3Factory', label: 'pancakeswapV3Factory', format: 'address', zeroMeans: 'venueOff' },
      { key: 'sushiswapV3Factory', label: 'sushiswapV3Factory', format: 'address', zeroMeans: 'venueOff' },
    ],
  },
  {
    id: 'pc-treasury',
    heading: 'treasuryHeading',
    rows: [{ key: 'treasury', label: 'treasuryAddress', format: 'address' }],
  },
];

/** Every value key the page renders, the tier table and the grace
 *  schedule included. */
export const RENDERED_KEYS: ReadonlySet<keyof ProtocolKnobValues> = new Set<keyof ProtocolKnobValues>([
  ...CONSOLE_SECTIONS.flatMap((s) => s.rows.map((r) => r.key)),
  'tierThresholds',
  'tierDiscountBps',
  'graceBuckets',
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
