import { createPublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from './multicall3';
import { RunDeadlinePassed, pastDeadline } from './runDeadline';

/** Result shape viem's `multicall` returns under `allowFailure: true`. */
export type BatchResult = { status: 'success' | 'failure'; result?: unknown; error?: unknown };

/** What bounds one batched read. `deadlineMs` is REQUIRED (#2497 r19): a read
 *  issued past the run's deadline returns every entry unread and costs no
 *  request, and the serial fallback stops at the deadline, so no read can
 *  outlast the run that issued it. */
export interface ReadBounds {
  /** The run's deadline ({@link PassTick.deadlineMs}). */
  deadlineMs: number;
  /** Read every entry at this block — on the aggregate AND on the serial
   *  fallback, so a degraded read still describes the same block. viem's
   *  `multicall` ignores a per-contract `blockNumber`; it must go here. */
  blockNumber?: bigint;
  /** What a rejected or throwing aggregate degrades to. `'serial'` (the
   *  default) retries one read per entry, which costs one subrequest per
   *  entry, until the deadline. `'unread'` returns every entry as a failure
   *  carrying the aggregate's error, so the call costs exactly one subrequest
   *  whatever happens: for a pass whose per-run budget must not depend on the
   *  RPC's health (graceDefault, #2483; the sanctions and delivery-proof
   *  passes, #2497 r18–r19). */
  onAggregateFailure?: 'serial' | 'unread';
}

/**
 * One `aggregate3` for a set of reads, falling back to serial reads per entry.
 *
 * The fallback is the dangerous part and the reason this is a named helper
 * rather than an inline try/catch: a chainless client makes `multicall()` throw
 * LOCALLY, every time, so a swallowed error means the batching silently never
 * happens and the pass still completes normally. That is exactly how the
 * liquidator's batching went unnoticed until #1946. `multicallAddress` is what
 * prevents it; the fallback exists only for a chain genuinely missing
 * Multicall3.
 *
 * Bounded by the run's deadline (see `runDeadline.ts`): past it nothing is
 * issued and every entry reads as a failure carrying {@link RunDeadlinePassed},
 * which every caller already treats as "not read — try next run".
 */
export async function batchedRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  label: string,
  bounds: ReadBounds,
): Promise<BatchResult[]> {
  if (contracts.length === 0) return [];
  const { deadlineMs, blockNumber, onAggregateFailure = 'serial' } = bounds;
  if (pastDeadline(deadlineMs)) return unread(contracts, new RunDeadlinePassed(label));
  const degrade = (error: unknown) =>
    onAggregateFailure === 'serial'
      ? serialRead(client, contracts, blockNumber, deadlineMs)
      : Promise.resolve(unread(contracts, error));
  try {
    const results = (await client.multicall({
      contracts: contracts as never,
      allowFailure: true,
      blockNumber,
      // REQUIRED — see src/multicall3.ts (#1946).
      multicallAddress: MULTICALL3_ADDRESS,
      // Disable viem's byte-size re-split (1024 B default), which would turn
      // one bounded chunk back into several requests (#1965 r2).
      batchSize: 0,
    })) as BatchResult[];

    // A REJECTED aggregate3 does not throw. With `allowFailure: true` viem
    // catches the chunk-level RPC error and hands back one `failure` per
    // contract carrying the SAME error object — so the `catch` below never
    // runs and every entry silently reads as unevaluated. Verified against the
    // installed viem: a chunk-level error returns `["failure"]`, it does not
    // throw. This is the liquidator's #1965 finding, and the watcher's
    // fallback would have been dead code without it.
    //
    // `batchSize: 0` means one batch per call, so "every result failed AND
    // they share one error object identity" is exactly the aggregate-level
    // case; per-entry reverts carry their own decoded errors.
    const aggregateFailed =
      results.length > 0 &&
      results.every(
        (r) => r.status === 'failure' && r.error === results[0].error && r.error !== undefined,
      );
    if (aggregateFailed) {
      console.error(
        `[keeper] ${label} aggregate3 rejected: ${String(results[0].error).slice(0, 200)} — ${
          onAggregateFailure === 'serial' ? 'retrying serially' : 'marking the chunk unread'
        }`,
      );
      return degrade(results[0].error);
    }
    return results;
  } catch (err) {
    console.error(
      `[keeper] ${label} multicall failed, ${
        onAggregateFailure === 'serial' ? 'falling back to serial' : 'marking the chunk unread'
      }: ${String(err).slice(0, 200)}`,
    );
    return degrade(err);
  }
}

/** Every entry as a failure carrying `error`: unread, for the next run. */
function unread(contracts: readonly unknown[], error: unknown): BatchResult[] {
  return contracts.map(() => ({ status: 'failure' as const, error }));
}

/** One read per contract — the degraded path, kept out of `batchedRead` so
 *  both entries share it. Stops at the deadline: the rest read as failures
 *  carrying {@link RunDeadlinePassed}, so a degraded RPC can cost at most the
 *  run's remaining window, never one request per entry past it. */
async function serialRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  blockNumber: bigint | undefined,
  deadlineMs: number,
): Promise<BatchResult[]> {
  const out: BatchResult[] = [];
  for (const c of contracts) {
    if (pastDeadline(deadlineMs)) {
      out.push(...unread(contracts.slice(out.length), new RunDeadlinePassed('serial read')));
      break;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      out.push({
        status: 'success',
        result: await client.readContract(
          (blockNumber === undefined ? c : { ...(c as object), blockNumber }) as never,
        ),
      });
    } catch (e) {
      out.push({ status: 'failure', error: e });
    }
  }
  return out;
}
