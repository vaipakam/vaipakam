/**
 * RW-76 — every switch of the RB-SWITCH table the Console names, with its
 * class and what it blocks. A switch the settings readers publish is read
 * from the same settings as the rest of the page; one they do not publish
 * yet is still named, with its state stated as not read here, so a dark
 * switch is never hidden by silence. The global administrative pause
 * (class 2) is live state and has its own section; asset-level pauses
 * (class 3) are shown on each asset.
 */
import type { CopyKey } from '../copy/useCopy';
import type { SettingKey } from './catalogue';
import type { SettingValues } from './snapshot';

export type SwitchClass = '1a' | '1b' | '4' | 'other';

export interface SwitchSpec {
  id: string;
  cls: SwitchClass;
  /** The setting that holds its state, when the readers publish one. */
  setting?: SettingKey;
  /** The setting's `true` means the switch blocks (a pause), rather than
   *  that the feature is on. */
  trueBlocks?: boolean;
}

export const SWITCHES: readonly SwitchSpec[] = [
  { id: 'partialFill', cls: '1a', setting: 'partialFillEnabled' },
  { id: 'lenderIntent', cls: '1a', setting: 'lenderIntentEnabled' },
  { id: 'autoLend', cls: '1a', setting: 'autoLendEnabled' },
  { id: 'periodicInterest', cls: '1a', setting: 'periodicInterestEnabled' },
  { id: 'fullTariff', cls: '1a' },
  { id: 'serviceCapacity', cls: '1a' },
  { id: 'autoExtend', cls: '1b', setting: 'autoExtendEnabled' },
  { id: 'autoRefinance', cls: '1b', setting: 'autoRefinanceEnabled' },
  { id: 'internalMatch', cls: '1b' },
  { id: 'discountedLiquidation', cls: '1b' },
  { id: 'prepayListing', cls: '1b' },
  { id: 'backstop', cls: '1b' },
  { id: 'keepersPaused', cls: '4', setting: 'keepersPaused', trueBlocks: true },
  { id: 'keeperReward', cls: '4' },
  { id: 'riskAccessGate', cls: 'other' },
  { id: 'discountPriceSource', cls: 'other' },
  { id: 'cutoverArming', cls: 'other' },
  { id: 'horizon', cls: 'other' },
];

/** A switch's state on the page. */
export type SwitchState =
  | 'on'
  | 'off'
  /** A pause switch in force. */
  | 'paused'
  /** A pause switch not in force. */
  | 'running'
  /** The settings were read, but this one was not answered. */
  | 'unanswered'
  /** The settings readers do not publish it yet. */
  | 'notRead'
  /** Neither source answered. */
  | 'unknown';

export function switchState(sw: SwitchSpec, values: SettingValues | null): SwitchState {
  if (!sw.setting) return 'notRead';
  if (values === null) return 'unknown';
  const v = values[sw.setting];
  if (typeof v !== 'boolean') return 'unanswered';
  if (sw.trueBlocks) return v ? 'paused' : 'running';
  return v ? 'on' : 'off';
}

export const switchName = (sw: SwitchSpec): CopyKey => `console.switch.${sw.id}.name` as CopyKey;
export const switchEffect = (sw: SwitchSpec): CopyKey => `console.switch.${sw.id}.effect` as CopyKey;
