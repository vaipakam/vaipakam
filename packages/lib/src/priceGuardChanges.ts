/**
 * #3453 — the price guard's pending changes, as the indexer records them and
 * the protocol console shows them.
 *
 * Every pricing setting lives on the standalone price guard (#3272 part 2),
 * and a change to one is PROPOSED, waits the guard's delay, and only then may
 * be executed. The delay exists so that people can see a change coming and
 * react; it only works if a change is shown while it waits. The guard keeps
 * each pending change under its (kind, subject) key and announces it with
 * `ChangeProposed`; a secondary source's removal is the one change kept
 * outside that map, announced with `SecondaryRemovalProposed`.
 *
 * This module is the one place that names the guard's change kinds and says
 * which console setting each one moves. `KIND_NAMES` mirrors the Solidity
 * enum `PriceGuardState.Kind` by position (the ABI carries the enum only as
 * `uint8`); the package test reads the enum from the contract source and
 * fails when the two differ.
 */

/** `PriceGuardState.Kind`, by ordinal. */
export const PRICE_GUARD_KIND_NAMES = [
  'FeedRegistry',
  'Weth',
  'EthNumeraireFeed',
  'EthPadFeed',
  'PadNumeraireRateFeed',
  'SequencerFeed',
  'PythOracle',
  'PythFeedId',
  'PythMaxStaleness',
  'PythMaxDeviationBps',
  'PythConfidenceMaxBps',
  'SecondarySource',
  'SecondaryMaxDeviationBps',
  'SecondaryMaxStaleness',
  'FeedMaxStaleness',
  'FeedMinAnswer',
  'StableRef',
  'AssetDirectFeed',
  'SecondaryEnabled',
  'Delay',
  'RateBinding',
  'RateObservation',
  'RateSourceEnabled',
  'PriceFloor',
] as const;

export type PriceGuardKindName = (typeof PRICE_GUARD_KIND_NAMES)[number];

/** The kind the indexer records a secondary source's proposed REMOVAL under.
 *  Not a guard `Kind`: the guard keeps removals in their own map
 *  (`secondaryRemovalAt`), with the source as the subject. */
export const SECONDARY_REMOVAL_KIND = 255;

/** A recorded kind's name: the enum name, `SecondaryRemoval`, or null for an
 *  ordinal this build does not know (a newer guard). */
export function priceGuardKindName(kind: number): PriceGuardKindName | 'SecondaryRemoval' | null {
  if (kind === SECONDARY_REMOVAL_KIND) return 'SecondaryRemoval';
  return Number.isInteger(kind) && kind >= 0 && kind < PRICE_GUARD_KIND_NAMES.length
    ? PRICE_GUARD_KIND_NAMES[kind]
    : null;
}

/**
 * The console setting (a `PRICE_GUARD_KNOB_GETTERS` key) a change of each
 * UNKEYED kind moves, so the console can show the pending value beside the
 * current one. Keyed kinds (a per-feed, per-asset or per-source entry) and
 * kinds no console row shows have no entry: they are listed on their own.
 */
export const PRICE_GUARD_KIND_KNOB: Partial<Record<PriceGuardKindName, string>> = {
  FeedRegistry: 'feedRegistry',
  Weth: 'wethContract',
  EthNumeraireFeed: 'ethNumeraireFeed',
  EthPadFeed: 'ethPadFeed',
  PadNumeraireRateFeed: 'padNumeraireRateFeed',
  SequencerFeed: 'sequencerUptimeFeed',
  PythOracle: 'pythOracle',
  PythFeedId: 'pythCrossCheckFeedId',
  PythMaxStaleness: 'pythMaxStalenessSeconds',
  PythMaxDeviationBps: 'pythCrossCheckMaxDeviationBps',
  PythConfidenceMaxBps: 'pythConfidenceMaxBps',
  SecondaryMaxDeviationBps: 'secondaryOracleMaxDeviationBps',
  SecondaryMaxStaleness: 'secondaryOracleMaxStalenessSeconds',
  Delay: 'priceGuardDelaySeconds',
};

/** The secondary sources, `PriceGuardState.Source` by ordinal. */
export const PRICE_GUARD_SOURCE_NAMES = ['Tellor', 'Api3', 'Dia'] as const;

/** One pending change as `/config/:chainId` serves it. `subject` and `value`
 *  are the raw 32-byte words the guard stores; `knobKey` names the console
 *  setting it moves, when it moves one. */
export interface PendingPriceGuardChange {
  kind: number;
  kindName: PriceGuardKindName | 'SecondaryRemoval' | null;
  subject: `0x${string}`;
  value: `0x${string}`;
  /** Unix seconds: the earliest the change may be executed. */
  executableAt: number;
  /** The block whose `ChangeProposed` recorded it. */
  proposedBlock: number;
  knobKey?: string;
}

/** The guard events that change what the console shows: a setting, the
 *  guard's own governance, or the list of pending changes. The rate-tracking
 *  events (`RateRecorded`, `RateObserved`, ...) are left out: they report
 *  prices, not settings, and arrive far more often. */
export const PRICE_GUARD_CONFIG_EVENTS: ReadonlySet<string> = new Set([
  'ConfigSet',
  'ChangeProposed',
  'ChangeCancelled',
  'DelaySet',
  'GuardianSet',
  'OwnershipTransferStarted',
  'OwnershipTransferred',
  'EpochAdvanced',
  'PriceFloorRaised',
  'PriceFloorLapsed',
  'SecondaryMuted',
  'SecondaryRemovalProposed',
  'SecondaryRemovalCancelled',
  'SecondaryRemoved',
  'RateSourceMuted',
]);
