/**
 * The recycle bucket, reconciled over a window of chain activity.
 *
 * A scenario that claims value reached the recycle bucket has to show it from
 * two independent sources, and show that they agree:
 *
 *   - the BUCKET itself (`getRecycleBucket`), read when the window opens and
 *     when it closes;
 *   - the ACCOUNTING EVENTS that are the bucket's only doors: every credit is
 *     a `VpfiRecycled` or a `VpfiRecycledPreLaunch` (by `RecycleSource`), and
 *     every debit is a `VpfiRecycleConsumed`.
 *
 * {@link openRecycleWindow} records the first reading and the block it was
 * taken at; `close()` reads the bucket again and collects every such event
 * mined in between. A scenario then asserts the exact equality it relies on,
 * typically: the credits are all of ONE source, nothing was consumed, and the
 * bucket moved by exactly the credited amount. A face-value event such as
 * `RewardEntryExpired.total` is not one of the doors and is never summed here.
 *
 * Open the window as close to the action as the scenario allows: other
 * activity in it (a day finalized, a loan repaid) can legitimately credit or
 * consume, and would then have to be accounted for by name.
 */
import type { Hex } from 'viem';
import type { DecodedEvent, ScenarioChain } from './chain';

/** The chain operations the reconciliation needs. */
type RecycleChain = Pick<ScenarioChain, 'read' | 'diamondEvents' | 'blockNumber'>;

export interface RecycleWindow {
  /** The bucket's balance when the window was opened. */
  bucketBefore: bigint;
  /** The first block the window covers. */
  fromBlock: bigint;
}

export interface RecycleReconciliation extends RecycleWindow {
  /** The bucket's balance when the window was closed. */
  bucketAfter: bigint;
  /** `bucketAfter - bucketBefore`. */
  bucketDelta: bigint;
  /** Every credit event in the window (`VpfiRecycled` / `VpfiRecycledPreLaunch`). */
  credits: DecodedEvent[];
  /** Credited VPFI per `RecycleSource`. */
  creditedBySource: Map<number, bigint>;
  /** Total credited VPFI over every source. */
  credited: bigint;
  /** Every debit event in the window (`VpfiRecycleConsumed`). */
  debits: DecodedEvent[];
  /** Total consumed VPFI. */
  consumed: bigint;
  /** The transactions that carried a credit. */
  creditTxs: Set<Hex>;
}

/** Open a window: read the bucket, and start collecting at the next block. */
export async function openRecycleWindow(sc: RecycleChain): Promise<RecycleWindow & { close(): Promise<RecycleReconciliation> }> {
  const bucketBefore = await sc.read<bigint>('getRecycleBucket');
  const fromBlock = (await sc.blockNumber()) + 1n;
  return {
    bucketBefore,
    fromBlock,
    close: () => closeRecycleWindow(sc, { bucketBefore, fromBlock }),
  };
}

async function closeRecycleWindow(sc: RecycleChain, w: RecycleWindow): Promise<RecycleReconciliation> {
  // A window in which nothing was mined holds no events (and a log query
  // starting past the head is refused by the node).
  const mined = (await sc.blockNumber()) >= w.fromBlock;
  const events = async (name: string): Promise<DecodedEvent[]> => (mined ? sc.diamondEvents(name, w.fromBlock) : []);
  const credits = [...(await events('VpfiRecycled')), ...(await events('VpfiRecycledPreLaunch'))];
  const debits = await events('VpfiRecycleConsumed');
  const bucketAfter = await sc.read<bigint>('getRecycleBucket');
  const creditedBySource = new Map<number, bigint>();
  for (const c of credits) {
    const source = Number(c.args.source);
    creditedBySource.set(source, (creditedBySource.get(source) ?? 0n) + BigInt(c.args.amount as bigint));
  }
  const credited = [...creditedBySource.values()].reduce((a, v) => a + v, 0n);
  const consumed = debits.reduce((a, e) => a + BigInt(e.args.amount as bigint), 0n);
  return {
    ...w,
    bucketAfter,
    bucketDelta: bucketAfter - w.bucketBefore,
    credits,
    creditedBySource,
    credited,
    debits,
    consumed,
    creditTxs: new Set(credits.map((c) => c.transactionHash)),
  };
}
