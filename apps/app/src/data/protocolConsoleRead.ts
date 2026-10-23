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
import {
  PROTOCOL_KNOB_GETTERS,
  abiOutputNames,
  readProtocolKnobGetters,
} from '@vaipakam/lib/protocolKnobs';
import { CLOCK_SKEW_ALLOWANCE_SEC, type ProtocolKnobSnapshot, type ProtocolKnobValues } from './indexer';

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
  /** It does not account for every setting this page shows: a setting is
   *  neither among its values nor named as unreported by the chain. */
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
  const reported = new Set(Object.keys(snap.values));
  const unreported = new Set(snap.unreported ?? []);
  for (const k of PROTOCOL_KNOB_GETTERS) {
    if (!reported.has(k.key) && !unreported.has(k.key)) return 'incomplete';
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
 * configuration bundle, labelled by the names in the compiled ABI exactly as
 * the indexer labels it, and the settings beside it through the shared
 * reader. Throws if the block, the bundle or the batched read fails.
 */
export async function readProtocolConsoleLive(
  client: PublicClient,
  diamond: `0x${string}`,
): Promise<ChainConsoleRead> {
  const names = abiOutputNames(DIAMOND_ABI_VIEM, 'getProtocolConfigBundle');
  if (names === null) throw new Error('the compiled ABI does not name the configuration bundle');
  const blockNumber = await client.getBlockNumber();
  const [bundle, knobs] = await Promise.all([
    client.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getProtocolConfigBundle',
      blockNumber,
    }) as Promise<readonly unknown[]>,
    readProtocolKnobGetters({ client, diamond, abi: DIAMOND_ABI_VIEM, blockNumber }),
  ]);
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
    return { source: 'chain', why: gap ?? 'missing', readAtSec: opts.nowSec(), ...live };
  } catch (err) {
    if (snap !== null) return { source: 'snapshot', snap, chainReadFailed: gap ?? 'missing' };
    throw err;
  }
}
