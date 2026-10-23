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
 * SETTINGS, NOT LIVE STATE. Each value here changes only when governance
 * sets it, so a snapshot of it is true as of the block it was read at. A
 * value that moves with the clock (the global pause, whose auto-pause
 * window lapses without any event) is not a setting and is not listed:
 * a snapshot would keep reporting it after it had changed.
 *
 * The ABI is a parameter rather than an import so this package keeps no
 * runtime dependency on `@vaipakam/contracts`; both callers pass the
 * Diamond ABI they already compile against.
 */
import { getAbiItem, toFunctionSelector, type Abi, type Address, type PublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from './multicall.js';

export interface ProtocolKnobGetter {
  /** The name the value is published and displayed under. */
  readonly key: string;
  /** The Diamond view that answers it: no arguments, one output. */
  readonly getter: string;
}

/**
 * The settings, by the name the console and `/config` use. Where the
 * reference doc renamed a storage slot and the getter kept its old name
 * (`pythCrossCheck*` versus `getPythNumeraire*`), the key follows the doc,
 * which is what a reader cross-checks against.
 */
export const PROTOCOL_KNOB_GETTERS = [
  // Risk
  { key: 'minHealthFactor', getter: 'getMinHealthFactor' },
  { key: 'maxSwapToRepaySlippageBps', getter: 'getMaxSwapToRepaySlippageBps' },
  { key: 'rateModel', getter: 'getRateModel' },
  { key: 'rateModelMaxDeviationBps', getter: 'getRateModelMaxDeviationBps' },
  // Oracle stack
  { key: 'secondaryOracleMaxDeviationBps', getter: 'getSecondaryOracleMaxDeviationBps' },
  { key: 'secondaryOracleMaxStalenessSeconds', getter: 'getSecondaryOracleMaxStaleness' },
  { key: 'pythOracle', getter: 'getPythOracle' },
  { key: 'pythCrossCheckFeedId', getter: 'getPythNumeraireFeedId' },
  { key: 'pythMaxStalenessSeconds', getter: 'getPythMaxStalenessSeconds' },
  { key: 'pythCrossCheckMaxDeviationBps', getter: 'getPythNumeraireMaxDeviationBps' },
  { key: 'pythConfidenceMaxBps', getter: 'getPythConfidenceMaxBps' },
  { key: 'sequencerUptimeFeed', getter: 'getSequencerUptimeFeed' },
  // Cross-chain reward reporting
  { key: 'rewardGraceSeconds', getter: 'getRewardGraceSeconds' },
  // Periodic interest and the numeraire
  { key: 'periodicInterestEnabled', getter: 'getPeriodicInterestEnabled' },
  { key: 'numeraireSwapEnabled', getter: 'getNumeraireSwapEnabled' },
  { key: 'numeraireSymbol', getter: 'getNumeraireSymbol' },
  { key: 'minPrincipalForFinerCadence', getter: 'getMinPrincipalForFinerCadence' },
  { key: 'preNotifyDays', getter: 'getPreNotifyDays' },
  // Automation and pauses
  { key: 'autoLendEnabled', getter: 'getAutoLendEnabled' },
  { key: 'autoRefinanceEnabled', getter: 'getAutoRefinanceEnabled' },
  { key: 'autoExtendEnabled', getter: 'getAutoExtendEnabled' },
  { key: 'keepersPaused', getter: 'keepersPaused' },
  // Treasury
  { key: 'treasury', getter: 'getTreasury' },
] as const satisfies readonly ProtocolKnobGetter[];

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

/** The deployment-artifact facet key that hosts each labelled getter. Both
 *  live on ConfigFacet; read by every caller of {@link abiDescribesGetterAt}
 *  so the indexer and the app look the host up under the same key. */
export const LABELLED_GETTER_HOST = {
  getProtocolConfigBundle: 'configFacet',
  getMasterFlags: 'configFacet',
} as const;

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
