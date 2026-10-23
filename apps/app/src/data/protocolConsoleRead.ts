/**
 * #2074 — where the Protocol Console's figures come from.
 *
 * The console reports the protocol's settings as they stand. The indexer's
 * `/config/:chainId` snapshot is the cheap source and the first one tried,
 * but it is only an account of the chain, and it can be missing, behind,
 * undated, unlabelled or missing values. In each of those cases the console
 * reads the same values from the Diamond itself, through the same shared
 * reader the indexer uses (`@vaipakam/lib/protocolKnobs`), and the page says
 * which source it used and why. Only when that read fails too does a
 * snapshot that is not current get shown, and then with its own warnings and
 * a note that the chain could not be read.
 *
 * Display only: nothing here feeds a signature or a transaction.
 */
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  LABELLED_GETTER_HOST,
  PROTOCOL_KNOB_GETTERS,
  abiDescribesGetterAt,
  abiOutputNames,
  readProtocolKnobGetters,
} from '@vaipakam/lib/protocolKnobs';
import { CLOCK_SKEW_ALLOWANCE_SEC, type ProtocolKnobSnapshot, type ProtocolKnobValues } from './indexer';
import { RENDERED_KEYS } from './protocolConsoleRows';

/**
 * How old a snapshot may be and still stand in for the chain on this page.
 *
 * Tighter than the day the snapshot's own staleness banner uses, on
 * purpose. The indexer re-reads the settings on every governance event and,
 * failing any, at least every six hours, so a healthy snapshot is never
 * older than that. One older than six hours and an hour's slack means the
 * re-read has stopped, and a governance change since then would be missing
 * from it while the page went on presenting it as current.
 */
export const CONSOLE_SNAPSHOT_MAX_AGE_SEC = 7 * 3600;

/** The settings read beside the bundle; only these can be named unreported. */
const KNOB_KEYS: ReadonlySet<string> = new Set(PROTOCOL_KNOB_GETTERS.map((k) => k.key));

/** Why the snapshot did not stand in for the chain. */
export type SnapshotGap =
  /** No snapshot: the indexer has none for this chain or could not be reached. */
  | 'missing'
  /** The indexer itself says a later governance change is not in it. */
  | 'known-stale'
  /** Its capture time is missing or unusable. */
  | 'undated'
  /** Older than {@link CONSOLE_SNAPSHOT_MAX_AGE_SEC}. */
  | 'old'
  /** Its values did not arrive with the names this page needs. */
  | 'unlabelled'
  /** It does not account for every value this page shows: a value is not
   *  among its values, and is not a setting the chain was asked for and
   *  named as unreported. */
  | 'incomplete';

/** Whether a snapshot can stand in for the chain right now, and if not, why.
 *  `null` means it can. */
export function snapshotGap(snap: ProtocolKnobSnapshot | null, nowSec: number): SnapshotGap | null {
  if (snap === null) return 'missing';
  if (snap.stale === true) return 'known-stale';
  const at = snap.updatedAt;
  if (typeof at !== 'number' || at <= 0 || nowSec - at < -CLOCK_SKEW_ALLOWANCE_SEC) return 'undated';
  if (nowSec - at >= CONSOLE_SNAPSHOT_MAX_AGE_SEC) return 'old';
  if (snap.labelsUnavailable) return 'unlabelled';
  // EVERY rendered value, the bundle's included (Codex #2683 r2): a fresh
  // snapshot captured by a build whose bundle predates a field the page now
  // shows must not stand in for the chain while that row reads "not
  // reported". Only a setting the snapshot asked the chain for may be
  // accounted for by being named unreported; a bundle field has no such
  // list, so it must be present.
  const reported = new Set(Object.keys(snap.values));
  const unreported = new Set(snap.unreported ?? []);
  for (const key of RENDERED_KEYS) {
    if (reported.has(key)) continue;
    if (KNOB_KEYS.has(key) && unreported.has(key)) continue;
    return 'incomplete';
  }
  return null;
}

export interface ChainConsoleRead {
  values: ProtocolKnobValues;
  /** Settings the chain did not answer. */
  unreported: string[];
  /** The block every value was read at. */
  blockNumber: bigint;
}

function serialize(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(serialize);
  return v;
}

/**
 * Read every value the console shows from the Diamond, all at one block: the
 * configuration bundle, labelled by the names in the compiled ABI, and the
 * settings beside it through the shared reader.
 *
 * The bundle is labelled ONLY when this build's ABI is shown to describe the
 * code that answered it (Codex #2683 r1): the loupe's host for the getter at
 * the read block must be the host this build's deployment artifact records,
 * the same rule the indexer applies before it stores names
 * (`abiDescribesGetterAt`). A length check alone would let an in-place
 * upgrade that reorders same-typed outputs put a real fee under the wrong
 * name. When it cannot be shown, this throws, and the page falls back as
 * for any failed read rather than labelling by position.
 *
 * Throws if the block, the bundle, the host check or the batched read fails.
 */
export async function readProtocolConsoleLive(
  client: PublicClient,
  chainId: number,
  diamond: `0x${string}`,
): Promise<ChainConsoleRead> {
  const names = abiOutputNames(DIAMOND_ABI_VIEM, 'getProtocolConfigBundle');
  if (names === null) throw new Error('the compiled ABI does not name the configuration bundle');
  const blockNumber = await client.getBlockNumber();
  const [labelsHold, bundle, knobs] = await Promise.all([
    abiDescribesGetterAt({
      client,
      diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getProtocolConfigBundle',
      expectedHost: getDeployment(chainId)?.facets?.[LABELLED_GETTER_HOST.getProtocolConfigBundle],
      blockNumber,
    }),
    client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getProtocolConfigBundle',
      blockNumber,
    }) as Promise<readonly unknown[]>,
    readProtocolKnobGetters({ client, diamond, abi: DIAMOND_ABI_VIEM, blockNumber }),
  ]);
  if (!labelsHold) {
    throw new Error('this build cannot show its names describe the deployed configuration code');
  }
  if (bundle.length !== names.length) {
    throw new Error('the configuration bundle does not match the compiled ABI');
  }
  const bundleValues = Object.fromEntries(names.map((n, i) => [n, serialize(bundle[i])]));
  return {
    values: { ...bundleValues, ...knobs.values } as ProtocolKnobValues,
    unreported: knobs.unreported,
    blockNumber,
  };
}

/** What the console shows, and where it came from. */
export type ConsoleReading =
  | {
      source: 'snapshot';
      snap: ProtocolKnobSnapshot;
      /** Set when the snapshot was not current and the chain read meant to
       *  replace it failed: the reason the snapshot fell short. */
      chainReadFailed?: SnapshotGap;
    }
  | ({ source: 'chain'; why: SnapshotGap; readAtSec: number } & ChainConsoleRead);

/**
 * Snapshot first while it can stand in for the chain; the chain otherwise.
 * A snapshot that is not current is shown only when the chain read fails,
 * and the reading says so. With neither, this throws.
 */
export async function loadProtocolConsole(opts: {
  fetchSnapshot: () => Promise<ProtocolKnobSnapshot | null>;
  readChain: () => Promise<ChainConsoleRead>;
  nowSec: () => number;
}): Promise<ConsoleReading> {
  const snap = await opts.fetchSnapshot().catch(() => null);
  const gap = snapshotGap(snap, opts.nowSec());
  if (snap !== null && gap === null) return { source: 'snapshot', snap };
  try {
    const live = await opts.readChain();
    // Codex #2683 r4 — a lagging RPC can answer from a block older than
    // the snapshot it was meant to replace. That is not a fresher reading,
    // so it counts as a failed chain read and the newer snapshot stays,
    // marked as not current.
    // A known-stale snapshot was followed by a governance event after its
    // block, so a read AT that block is no newer either (Codex #2683 r5).
    const snapBlock = snap?.sourceBlock;
    if (snapBlock !== undefined && Number.isSafeInteger(snapBlock)) {
      const floor = BigInt(snapBlock);
      const behind = gap === 'known-stale' ? live.blockNumber <= floor : live.blockNumber < floor;
      if (behind) throw new Error('chain read is not newer than the snapshot');
    }
    return { source: 'chain', why: gap ?? 'missing', readAtSec: opts.nowSec(), ...live };
  } catch (err) {
    if (snap !== null) return { source: 'snapshot', snap, chainReadFailed: gap ?? 'missing' };
    throw err;
  }
}
