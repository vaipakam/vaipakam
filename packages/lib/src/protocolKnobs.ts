/**
 * #2071 / #2074 — the protocol-wide settings the Protocol Console reports
 * beyond `getProtocolConfigBundle`, and the ONE reader both of its sources
 * use.
 *
 * Two places read these values: the indexer, which publishes them in its
 * `/config/:chainId` snapshot, and the connected app, which reads them from
 * the Diamond itself whenever that snapshot is missing, out of date or
 * incomplete. Both go through {@link readProtocolKnobGetters}, so the two
 * sources can never disagree about which getter backs which name.
 *
 * SINGLE-OUTPUT GETTERS ONLY, BY CONSTRUCTION. Every entry names a
 * no-argument view that returns exactly one value, so the value is the
 * getter's whole answer and there is no position inside a tuple to get
 * wrong. A setting that is only readable as one field of a multi-output
 * getter is not listed here: naming such a field safely needs the
 * capture-time binding `getProtocolConfigBundle` carries (#2073), and the
 * console says the setting is not shown yet rather than borrow a position.
 * The package test pins every entry to that shape in the compiled ABI.
 *
 * SETTINGS AND RECORDED FACTS, NOT LIVE STATE. Each value here changes
 * only in a transaction that announces the change (or, for an `eventless`
 * entry, says it does not), so a snapshot of it is true as of the block it
 * was read at. Most are settings governance sets. A few are facts the
 * protocol records and that only an announced transaction moves, such as
 * when the auto-pause cooldown ends (#2843): a stored timestamp, compared
 * with the clock by whoever reads it. A value that moves with the clock
 * itself (the global pause, whose auto-pause window lapses without any
 * event) is not listed: a snapshot would keep reporting it after it had
 * changed.
 *
 * The ABI is a parameter rather than an import so this package keeps no
 * runtime dependency on `@vaipakam/contracts`; both callers pass the
 * Diamond ABI they already compile against.
 */
import { getAbiItem, toFunctionSelector, type Abi, type Address, type PublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from './multicall.js';
import { describeShapeMismatch, readStaticReturn } from './staticReturn.js';

interface ProtocolKnobGetterBase {
  /** The name the value is published and displayed under. */
  readonly key: string;
  /** The Diamond view that answers it: no arguments, one output. */
  readonly getter: string;
  /** Codex #2815 r1 — every event emitted by a transaction that changes
   *  this value: its setters' events and, for a recorded fact (#2843), the
   *  event of the transaction that records it. The indexer refreshes its
   *  snapshot on exactly these (plus its own list of bundle setters), so a
   *  value added here cannot be published without naming what announces
   *  its change. The package test pins each name to an event the Diamond
   *  ABI declares. */
  readonly setterEvents: readonly string[];
}

/**
 * One published setting. Either every setter announces its change
 * (`setterEvents` names them), or at least one does not, and the entry says
 * so with `eventless`.
 *
 * `eventless` (Codex #2683 r3): some way of changing the value emits no
 * event, so nothing on chain says when it changed. A snapshot of it is
 * refreshed on the indexer's schedule as well as on any listed event, and
 * can show the previous value until then; every surface that shows a
 * snapshot of it says so. The contract-side fix (an event) is #2685.
 */
export type ProtocolKnobGetter =
  | (ProtocolKnobGetterBase & { readonly eventless?: undefined; readonly setterEvents: readonly [string, ...string[]] })
  | (ProtocolKnobGetterBase & { readonly eventless: true });

/**
 * The settings, by the name the console and `/config` use. Where the
 * reference doc renamed a storage slot and the getter kept its old name
 * (`pythCrossCheck*` versus `getPythNumeraire*`), the key follows the doc,
 * which is what a reader cross-checks against.
 */
export const PROTOCOL_KNOB_GETTERS = [
  // Risk
  { key: 'minHealthFactor', getter: 'getMinHealthFactor', setterEvents: ['MinHealthFactorSet'] },
  { key: 'maxSwapToRepaySlippageBps', getter: 'getMaxSwapToRepaySlippageBps', setterEvents: ['MaxSwapToRepaySlippageBpsSet'] },
  { key: 'rateModel', getter: 'getRateModel', setterEvents: ['RateModelSet'] },
  { key: 'rateModelMaxDeviationBps', getter: 'getRateModelMaxDeviationBps', setterEvents: ['RateModelMaxDeviationBpsSet'] },
  // Oracle stack
  { key: 'secondaryOracleMaxDeviationBps', getter: 'getSecondaryOracleMaxDeviationBps', setterEvents: ['SecondaryOracleMaxDeviationBpsSet'] },
  { key: 'secondaryOracleMaxStalenessSeconds', getter: 'getSecondaryOracleMaxStaleness', setterEvents: ['SecondaryOracleMaxStalenessSet'] },
  { key: 'pythOracle', getter: 'getPythOracle', setterEvents: ['PythOracleSet'] },
  { key: 'pythCrossCheckFeedId', getter: 'getPythNumeraireFeedId', setterEvents: ['PythNumeraireFeedIdSet', 'NumeraireUpdated'] },
  { key: 'pythMaxStalenessSeconds', getter: 'getPythMaxStalenessSeconds', setterEvents: ['PythMaxStalenessSecondsSet'] },
  { key: 'pythCrossCheckMaxDeviationBps', getter: 'getPythNumeraireMaxDeviationBps', setterEvents: ['PythNumeraireMaxDeviationBpsSet'] },
  { key: 'pythConfidenceMaxBps', getter: 'getPythConfidenceMaxBps', setterEvents: ['PythConfidenceMaxBpsSet'] },
  { key: 'sequencerUptimeFeed', getter: 'getSequencerUptimeFeed', setterEvents: [], eventless: true },
  // Cross-chain reward reporting
  { key: 'rewardGraceSeconds', getter: 'getRewardGraceSeconds', setterEvents: ['RewardReporterConfigUpdated'] },
  // Periodic interest and the numeraire
  { key: 'periodicInterestEnabled', getter: 'getPeriodicInterestEnabled', setterEvents: ['PeriodicInterestEnabledSet'] },
  { key: 'numeraireSwapEnabled', getter: 'getNumeraireSwapEnabled', setterEvents: ['NumeraireSwapEnabledSet'] },
  { key: 'numeraireSymbol', getter: 'getNumeraireSymbol', setterEvents: ['NumeraireUpdated'] },
  // Codex #2815 r1 — `setNumeraire` announces it (NumeraireUpdated), but
  // `OracleAdminFacet.setEthUsdFeed` writes the same slot and emits nothing.
  { key: 'ethNumeraireFeed', getter: 'getEthNumeraireFeed', setterEvents: ['NumeraireUpdated'], eventless: true },
  { key: 'minPrincipalForFinerCadence', getter: 'getMinPrincipalForFinerCadence', setterEvents: ['MinPrincipalForFinerCadenceSet', 'NumeraireUpdated'] },
  { key: 'preNotifyDays', getter: 'getPreNotifyDays', setterEvents: ['PreNotifyDaysSet'] },
  // Automation and pauses
  { key: 'autoLendEnabled', getter: 'getAutoLendEnabled', setterEvents: ['AutoLendEnabledSet'] },
  { key: 'autoRefinanceEnabled', getter: 'getAutoRefinanceEnabled', setterEvents: ['AutoRefinanceEnabledSet'] },
  { key: 'autoExtendEnabled', getter: 'getAutoExtendEnabled', setterEvents: ['AutoExtendEnabledSet'] },
  { key: 'keepersPaused', getter: 'keepersPaused', setterEvents: ['KeepersPausedSet'] },
  // #2843 — the gap after an auto-pause window that froze a live protocol
  // before the watcher may open the next one (the effective value: the
  // default when governance has set none).
  { key: 'autoPauseCooldownSeconds', getter: 'autoPauseCooldownSeconds', setterEvents: ['AutoPauseCooldownSet'] },
  // #2843 — a recorded fact, not a setting: when that cooldown ends (zero
  // while no window has ever frozen a live protocol). A window that freezes
  // one moves it (`AutoPaused`), and so does a new cooldown, which applies
  // to the one already running. Nothing else does: it is the stored end of
  // the last such window plus the cooldown, never a reading of the clock.
  {
    key: 'autoPauseAvailableAt',
    getter: 'autoPauseAvailableAt',
    setterEvents: ['AutoPaused', 'AutoPauseCooldownSet'],
  },
  { key: 'lenderIntentEnabled', getter: 'isLenderIntentEnabled', setterEvents: ['LenderIntentEnabledSet'] },
  // #2760 — the effective value: the default when governance has set none.
  { key: 'minIntentFillNumeraire', getter: 'getMinIntentFillNumeraire', setterEvents: ['MinIntentFillNumeraireSet'] },
  // Treasury
  { key: 'treasury', getter: 'getTreasury', setterEvents: ['TreasurySet'] },
] as const satisfies readonly ProtocolKnobGetter[];

/** The settings that can change without announcing it on chain (see
 *  {@link ProtocolKnobGetter}). */
export const EVENTLESS_PROTOCOL_KNOBS: ReadonlySet<string> = new Set(
  PROTOCOL_KNOB_GETTERS.filter((k): boolean => 'eventless' in k && k.eventless === true).map((k) => k.key),
);

/** Codex #2815 r1 — every event that announces a change to a published
 *  value. The indexer's snapshot refreshes on each of these. */
export const PROTOCOL_KNOB_SETTER_EVENTS: ReadonlySet<string> = new Set(
  PROTOCOL_KNOB_GETTERS.flatMap((k): readonly string[] => k.setterEvents),
);

/** Every published setting's name, as a type, so a consumer can prove at
 *  compile time that it declares each one. */
export type ProtocolKnobKey = (typeof PROTOCOL_KNOB_GETTERS)[number]['key'];

/** A published value: integers as decimal strings (a `uint256` does not
 *  survive a JSON number), flags as booleans, addresses and 32-byte ids as
 *  their hex text. */
export type ProtocolKnobValue = string | boolean;

export interface ProtocolKnobRead {
  /** Every setting the chain answered, by key. */
  values: Record<string, ProtocolKnobValue>;
  /** Every listed setting the chain did NOT answer (a Diamond without that
   *  getter, or a call that reverted). Stated, never left implicit: a key
   *  in neither list means the reader did not ask for it. */
  unreported: string[];
}

function toKnobValue(v: unknown): ProtocolKnobValue | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v)) return v;
  return null;
}

/**
 * Read every listed setting in ONE `eth_call` (Multicall3 `aggregate3`,
 * failures allowed per call) at `blockNumber`, so all of them describe the
 * same block. A setting whose call fails is listed in `unreported`; a
 * failure of the batch itself (the RPC is down) throws, and the caller
 * decides what that means for its own source.
 */
export async function readProtocolKnobGetters(opts: {
  client: PublicClient;
  diamond: Address;
  abi: Abi;
  blockNumber: bigint;
}): Promise<ProtocolKnobRead> {
  const results = await opts.client.multicall({
    contracts: PROTOCOL_KNOB_GETTERS.map((k) => ({
      address: opts.diamond,
      abi: opts.abi,
      functionName: k.getter,
    })),
    allowFailure: true,
    blockNumber: opts.blockNumber,
    multicallAddress: MULTICALL3_ADDRESS,
  });
  const values: Record<string, ProtocolKnobValue> = {};
  const unreported: string[] = [];
  PROTOCOL_KNOB_GETTERS.forEach((k, i) => {
    const r = results[i];
    const v = r && r.status === 'success' ? toKnobValue(r.result) : null;
    if (v === null) unreported.push(k.key);
    else values[k.key] = v;
  });
  return { values, unreported };
}

/**
 * Field names for a getter's return tuple, taken from the COMPILED ABI —
 * never hand-typed (a hand-typed positional tuple is how a parameter once
 * shifted under the wrong label). Null if the getter or any output name is
 * missing, which suppresses a labelled view rather than guessing at it.
 */
export function abiOutputNames(abi: Abi, functionName: string): readonly string[] | null {
  const entry = (abi as readonly unknown[]).find(
    (e): e is { type: string; name: string; outputs?: readonly { name?: string }[] } =>
      typeof e === 'object' &&
      e !== null &&
      (e as { type?: string }).type === 'function' &&
      (e as { name?: string }).name === functionName,
  );
  const outputs = entry?.outputs;
  if (!outputs || outputs.length === 0) return null;
  const names = outputs.map((o) => o.name ?? '');
  return names.every((n) => n.length > 0) ? names : null;
}

/** The deployment-artifact facet key that hosts each labelled getter; read
 *  by every caller of {@link abiDescribesGetterAt} so the indexer and the
 *  app look the host up under the same key. (`getMasterFlags` was the
 *  second entry until #2812 retired it with the range flags.) */
export const LABELLED_GETTER_HOST = {
  getProtocolConfigBundle: 'configFacet',
} as const;

/** A value of the config bundle as it is published: integers as decimal
 *  strings, flags as booleans, the fixed tier arrays as lists of those. */
export type ProtocolBundleValue = ProtocolKnobValue | ProtocolKnobValue[];

export type ProtocolBundleRead =
  | {
      kind: 'read';
      /** The bundle in output order, as published in `/config` `bundle`. */
      positional: ProtocolBundleValue[];
      /** The same values under this build's output names. Whether those
       *  names may be PUBLISHED is the separate host binding
       *  ({@link abiDescribesGetterAt}); a caller that cannot establish it
       *  withholds them. */
      values: Record<string, ProtocolBundleValue>;
    }
  /** Nothing was decoded, and why, in words. */
  | { kind: 'unreadable'; reason: string };

function toBundleValue(v: unknown): ProtocolBundleValue | null {
  if (Array.isArray(v)) {
    const items = v.map(toKnobValue);
    return items.every((x): x is ProtocolKnobValue => x !== null) ? items : null;
  }
  return toKnobValue(v);
}

/**
 * #2812 — THE read of `getProtocolConfigBundle`, for the indexer's snapshot
 * and for every chain read in the connected app.
 *
 * The answer is decoded only when its length is the one this build's ABI
 * describes ({@link readStaticReturn}). An answer of another length comes
 * from other code (a Diamond whose ConfigFacet predates or postdates this
 * build), and decoding it by position would put real numbers under the
 * wrong names, so it is reported as `unreadable` and its fields are unknown.
 * A revert or a transport failure throws.
 */
export async function readProtocolConfigBundle(opts: {
  client: PublicClient;
  diamond: Address;
  abi: Abi;
  blockNumber?: bigint;
}): Promise<ProtocolBundleRead> {
  const names = abiOutputNames(opts.abi, 'getProtocolConfigBundle');
  if (names === null) {
    return { kind: 'unreadable', reason: "this build's ABI names no output of getProtocolConfigBundle" };
  }
  const r = await readStaticReturn({
    client: opts.client,
    address: opts.diamond,
    abi: opts.abi,
    functionName: 'getProtocolConfigBundle',
    blockNumber: opts.blockNumber,
  });
  if (r.kind === 'shape-mismatch') {
    return { kind: 'unreadable', reason: describeShapeMismatch('getProtocolConfigBundle', r) };
  }
  const positional = r.outputs.map(toBundleValue);
  if (!positional.every((v): v is ProtocolBundleValue => v !== null)) {
    return { kind: 'unreadable', reason: 'getProtocolConfigBundle answered a value of a kind this reader does not publish' };
  }
  return { kind: 'read', positional, values: Object.fromEntries(names.map((n, i) => [n, positional[i]])) };
}

/**
 * #2073 / #2074 — whether `abi` describes the code that answered
 * `functionName` at `blockNumber`: the Diamond loupe's
 * `facetAddress(selector)` AT THAT BLOCK equals `expectedHost`, the host the
 * caller's deployment artifact records for the getter.
 *
 * Output NAMES are only true of the implementation they were compiled
 * from. An in-place facet refresh that reorders same-typed outputs keeps
 * the tuple's arity, so a length check alone would put a real value under
 * the wrong name. The artifact and the ABI ship together, and a facet
 * address cannot change its code, so a match ties the names to the code
 * that ran. Anything else (no expected host, a different host, a failed
 * loupe read) is "cannot establish", and the caller withholds the names.
 *
 * ONE rule for both readers of the labelled bundle: the indexer before it
 * stores names beside a captured tuple, and the connected app before it
 * labels a bundle it read from the chain itself.
 */
export async function abiDescribesGetterAt(opts: {
  client: PublicClient;
  diamond: Address;
  abi: Abi;
  functionName: string;
  /** The getter's host in the caller's deployment artifact. */
  expectedHost: string | undefined;
  blockNumber: bigint;
}): Promise<boolean> {
  if (!opts.expectedHost) return false;
  try {
    const item = getAbiItem({ abi: opts.abi, name: opts.functionName });
    if (!item || item.type !== 'function') return false;
    const host = (await opts.client.readContract({
      address: opts.diamond,
      abi: opts.abi,
      functionName: 'facetAddress',
      args: [toFunctionSelector(item)],
      blockNumber: opts.blockNumber,
    })) as string;
    return host.toLowerCase() === opts.expectedHost.toLowerCase();
  } catch {
    return false;
  }
}
