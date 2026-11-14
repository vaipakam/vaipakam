/**
 * RW-76 — every setting the Console can show, with the group it is listed
 * under and how its value is written. The catalogue is typed over the
 * shared readers' keys (`ProtocolKnobKey`) and the settings bundle's
 * output names, so a setting the readers publish cannot reach the page
 * without a group and a format, and the compiler refuses a label missing
 * from the copy catalog.
 *
 * Values are what the protocol applies now: the getters return the
 * effective value, the documented default included when governance has set
 * none. The few settings whose zero means "none set" are written as such
 * ("unset", "off"), never as 0.
 */
import type { ProtocolKnobKey } from '@vaipakam/lib/protocolKnobs';
import type { CopyKey } from '../copy/useCopy';
import { formatBps, formatExact, formatSpan, formatUnits, formatUtc } from '../ui/format';
import type { SettingValue } from './snapshot';

/** The settings bundle's output names, in the bundle's order. A unit test
 *  pins this list to the compiled ABI. */
export const BUNDLE_SETTING_KEYS = [
  'treasuryFeeBps',
  'loanInitiationFeeBps',
  'liquidationHandlingFeeBps',
  'maxLiquidationSlippageBps',
  'maxLiquidatorIncentiveBps',
  'volatilityLtvThresholdBps',
  'rentalBufferBps',
  'tierThresholds',
  'tierDiscountBps',
  'partialFillEnabled',
  'lifMatcherFeeBps',
  'autoPauseDurationSeconds',
  'maxOfferDurationDays',
] as const;

export type SettingKey = ProtocolKnobKey | (typeof BUNDLE_SETTING_KEYS)[number];

export const SETTING_GROUPS = ['fees', 'tiers', 'risk', 'liquidation', 'offers', 'periodic', 'pause', 'rewards', 'contracts', 'pricing'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export type SettingFormat =
  /** Basis points, written as a percentage. */
  | 'bps'
  /** A health factor scaled by 1e18. */
  | 'hf'
  /** A health factor in basis points (10,000 = 1). */
  | 'hfBps'
  | 'seconds'
  | 'days'
  | 'count'
  /** An amount in the numeraire, scaled by 1e18. */
  | 'numeraire'
  /** A VPFI amount, scaled by 1e18. */
  | 'vpfi'
  /** An address; the zero address is "unset". */
  | 'address'
  /** A short symbol stored as 32 bytes; zero is "unset". */
  | 'symbol'
  /** A 32-byte id; zero is "unset". */
  | 'id'
  /** A moment (unix seconds). */
  | 'time'
  /** A list of VPFI amounts. */
  | 'vpfiList'
  /** A list of basis points. */
  | 'bpsList'
  /** The loan-default grace schedule. */
  | 'graceBuckets'
  /** An on / off switch, listed with the switches rather than as a setting. */
  | 'switch';

export interface SettingSpec {
  group: SettingGroup;
  format: SettingFormat;
  /** What a zero means, when it is not an amount of zero. */
  zero?: 'unset' | 'off' | 'neverPaused';
}

const s = (group: SettingGroup, format: SettingFormat, zero?: SettingSpec['zero']): SettingSpec => (zero ? { group, format, zero } : { group, format });

export const SETTINGS: Readonly<Record<SettingKey, SettingSpec>> = {
  // The settings bundle.
  treasuryFeeBps: s('fees', 'bps'),
  loanInitiationFeeBps: s('fees', 'bps'),
  lifMatcherFeeBps: s('fees', 'bps'),
  liquidationHandlingFeeBps: s('liquidation', 'bps'),
  maxLiquidationSlippageBps: s('liquidation', 'bps'),
  maxLiquidatorIncentiveBps: s('liquidation', 'bps'),
  volatilityLtvThresholdBps: s('risk', 'bps'),
  rentalBufferBps: s('offers', 'bps'),
  tierThresholds: s('tiers', 'vpfiList'),
  tierDiscountBps: s('tiers', 'bpsList'),
  partialFillEnabled: s('offers', 'switch'),
  autoPauseDurationSeconds: s('pause', 'seconds'),
  maxOfferDurationDays: s('offers', 'days'),
  // Risk and rates.
  minHealthFactor: s('risk', 'hf'),
  maxSwapToRepaySlippageBps: s('risk', 'bps'),
  rateModel: s('risk', 'address', 'unset'),
  rateModelMaxDeviationBps: s('risk', 'bps'),
  rateModelRelativeDeviationBps: s('risk', 'bps'),
  rateModelMinDeviationBps: s('risk', 'bps'),
  protocolRegistry: s('contracts', 'address', 'unset'),
  priceGuard: s('contracts', 'address', 'unset'),
  // Rewards.
  rewardGraceSeconds: s('rewards', 'seconds'),
  notificationFeeVpfi: s('fees', 'vpfi'),
  // Periodic interest.
  periodicInterestEnabled: s('periodic', 'switch'),
  numeraireSymbol: s('periodic', 'symbol', 'unset'),
  minPrincipalForFinerCadence: s('periodic', 'numeraire'),
  preNotifyDays: s('periodic', 'days'),
  // Automation and pauses.
  autoLendEnabled: s('offers', 'switch'),
  autoRefinanceEnabled: s('offers', 'switch'),
  autoExtendEnabled: s('offers', 'switch'),
  keepersPaused: s('pause', 'switch'),
  autoPauseCooldownSeconds: s('pause', 'seconds'),
  autoPauseAvailableAt: s('pause', 'time', 'neverPaused'),
  lenderIntentEnabled: s('offers', 'switch'),
  minIntentFillNumeraire: s('offers', 'numeraire'),
  minOfferValueNumeraire: s('offers', 'numeraire'),
  maxOpenOffersPerWallet: s('offers', 'count'),
  treasury: s('contracts', 'address', 'unset'),
  pancakeswapV3Factory: s('contracts', 'address', 'unset'),
  sushiswapV3Factory: s('contracts', 'address', 'unset'),
  // Liquidation sizing and discounts.
  partialLiqTargetHfCeilingBps: s('liquidation', 'hfBps'),
  partialLiqDeepUnderwaterHfBps: s('liquidation', 'hfBps'),
  partialLiqDustFloorNumeraire: s('liquidation', 'numeraire', 'off'),
  tier1LiqDiscountBps: s('liquidation', 'bps'),
  tier2LiqDiscountBps: s('liquidation', 'bps'),
  tier3LiqDiscountBps: s('liquidation', 'bps'),
  graceBuckets: s('risk', 'graceBuckets'),
  // The price guard.
  priceGuardOwner: s('pricing', 'address', 'unset'),
  priceGuardGuardian: s('pricing', 'address', 'unset'),
  priceGuardDelaySeconds: s('pricing', 'seconds'),
  numeraireDenominator: s('pricing', 'address', 'unset'),
  feedRegistryPrimaryKey: s('pricing', 'address', 'unset'),
  feedRegistryEthKey: s('pricing', 'address', 'unset'),
  feedRegistry: s('pricing', 'address', 'unset'),
  wethContract: s('pricing', 'address', 'unset'),
  ethNumeraireFeed: s('pricing', 'address', 'unset'),
  ethPadFeed: s('pricing', 'address', 'unset'),
  padNumeraireRateFeed: s('pricing', 'address', 'unset'),
  sequencerUptimeFeed: s('pricing', 'address', 'unset'),
  pythOracle: s('pricing', 'address', 'unset'),
  pythCrossCheckFeedId: s('pricing', 'id', 'unset'),
  pythMaxStalenessSeconds: s('pricing', 'seconds'),
  pythCrossCheckMaxDeviationBps: s('pricing', 'bps'),
  pythConfidenceMaxBps: s('pricing', 'bps'),
  secondaryOracleMaxDeviationBps: s('pricing', 'bps'),
  secondaryOracleMaxStalenessSeconds: s('pricing', 'seconds'),
};

/** The copy key that names a setting. */
export function settingLabel(key: SettingKey): CopyKey {
  return `console.setting.${key}`;
}

/** Compile-time proof that every setting has a label in the copy catalog. */
const _labelled: `console.setting.${SettingKey}` extends CopyKey ? true : never = true;
void _labelled;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

/** What the page needs from the copy catalog to write a value. */
export interface ValueWords {
  text: (key: CopyKey) => string;
  format: (key: CopyKey, vars: Readonly<Record<string, string>>) => string;
}

const ZERO_ADDRESS = /^0x0{40}$/i;
const ZERO_WORD = /^0x0{64}$/i;
const INTEGER = /^\d+$/;

function bigOf(v: SettingValue): bigint | null {
  return typeof v === 'string' && INTEGER.test(v) ? BigInt(v) : null;
}

/** A 32-byte word holding a short text, as that text; null when it is not
 *  printable text. */
function symbolOf(hex: string): string | null {
  if (!/^0x[0-9a-f]{64}$/i.test(hex)) return null;
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break;
    if (code < 0x20 || code > 0x7e) return null;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * A setting's value as the page writes it. A value whose kind does not
 * match the setting's format is written raw with a note, never coerced: a
 * mismatch means the reader and this page disagree about the setting.
 */
export function writeValue(key: SettingKey, value: SettingValue, w: ValueWords): string {
  const spec = SETTINGS[key];
  const raw = () => w.format('console.value.raw', { value: JSON.stringify(value) });
  if (spec.format === 'switch') return typeof value === 'boolean' ? w.text(value ? 'console.value.on' : 'console.value.off') : raw();
  if (spec.format === 'graceBuckets') {
    if (!Array.isArray(value)) return raw();
    if (value.length === 0) return w.text('console.value.graceDefault');
    const parts: string[] = [];
    for (const b of value) {
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return raw();
      const days = bigOf(b.maxDurationDays ?? '');
      const grace = bigOf(b.graceSeconds ?? '');
      if (days === null || grace === null) return raw();
      parts.push(w.format('console.value.graceBucket', { days: days.toString(), grace: formatSpan(Number(grace)) }));
    }
    return parts.join('; ');
  }
  if (spec.format === 'vpfiList' || spec.format === 'bpsList') {
    if (!Array.isArray(value)) return raw();
    const items = value.map((x) => (typeof x === 'string' ? bigOf(x) : null));
    if (items.some((x) => x === null)) return raw();
    return (items as bigint[]).map((x) => (spec.format === 'vpfiList' ? `${formatExact(x, 18)} VPFI` : `${formatBps(x)}%`)).join(', ');
  }
  if (typeof value !== 'string') return raw();
  if (spec.format === 'address') {
    if (!/^0x[0-9a-f]{40}$/i.test(value)) return raw();
    return ZERO_ADDRESS.test(value) ? w.text('console.value.unset') : value;
  }
  if (spec.format === 'id') {
    if (!/^0x[0-9a-f]{64}$/i.test(value)) return raw();
    return ZERO_WORD.test(value) ? w.text('console.value.unset') : value;
  }
  if (spec.format === 'symbol') {
    if (ZERO_WORD.test(value)) return w.text('console.value.unset');
    const sym = symbolOf(value);
    return sym === null ? raw() : sym;
  }
  const n = bigOf(value);
  if (n === null) return raw();
  if (n === 0n && spec.zero === 'off') return w.text('console.value.off');
  if (n === 0n && spec.zero === 'unset') return w.text('console.value.unset');
  if (n === 0n && spec.zero === 'neverPaused') return w.text('console.value.neverAutoPaused');
  switch (spec.format) {
    case 'bps':
      return `${formatBps(n)}%`;
    case 'hf':
      return formatUnits(n, 18);
    case 'hfBps':
      return formatUnits(n, 4);
    case 'seconds':
      return w.format('console.value.seconds', { span: formatSpan(Number(n)), seconds: formatExact(n, 0) });
    case 'days':
      return w.format('console.value.days', { days: formatExact(n, 0) });
    case 'count':
      return formatExact(n, 0);
    case 'numeraire':
      return w.format('console.value.numeraire', { amount: formatExact(n, 18) });
    case 'vpfi':
      return `${formatExact(n, 18)} VPFI`;
    case 'time':
      return formatUtc(n);
    default:
      return raw();
  }
}
