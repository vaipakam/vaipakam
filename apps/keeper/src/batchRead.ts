import { createPublicClient } from 'viem';
import { MULTICALL3_ADDRESS } from './multicall3';
import { walkFrom } from './rotate';
import { redactedError } from '@vaipakam/lib/errorDescription';

/** Result shape viem's `multicall` returns under `allowFailure: true`. */
export type BatchResult = { status: 'success' | 'failure'; result?: unknown; error?: unknown };

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
 */
export async function batchedRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  label: string,
  /** Read every entry at this block — on the aggregate AND on the serial
   *  fallback, so a degraded read still describes the same block. viem's
   *  `multicall` ignores a per-contract `blockNumber`; it must go here. */
  blockNumber?: bigint,
  /** What a rejected or throwing aggregate degrades to. `'serial'` (the
   *  default) retries one read per entry, which costs one subrequest per
   *  entry. `'unread'` returns every entry as a failure carrying the
   *  aggregate's error, so the call costs exactly one subrequest whatever
   *  happens: for a pass whose per-run budget must not depend on the
   *  RPC's health (graceDefault, #2483). */
  onAggregateFailure: 'serial' | 'unread' = 'serial',
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]> {
  if (contracts.length === 0) return [];
  const degrade = (error: unknown) =>
    onAggregateFailure === 'serial'
      ? serialRead(client, contracts, blockNumber)
      : Promise.resolve(contracts.map(() => ({ status: 'failure' as const, error })));
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
    })) as { status: 'success' | 'failure'; result?: unknown; error?: unknown }[];

    // A REJECTED aggregate3 does not throw. With `allowFailure: true` viem
    // catches the chunk-level RPC error and hands back one `failure` per
    // contract carrying the SAME error object — so the `catch` below never
    // runs and every entry silently reads as unevaluated. Verified against the
    // installed viem: a chunk-level error returns `["failure"]`, it does not
    // throw. This is the liquidator's #1965 finding, and the watcher's
    // fallback would have been dead code without it. Which results mean that
    // is {@link isAggregateRejection}'s rule.
    const aggregateFailed = isAggregateRejection(results);
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
      }: ${redactedError(err, { stack: false }).slice(0, 200)}`,
    );
    return degrade(err);
  }
}

/**
 * Did the `aggregate3` call ITSELF fail, rather than the reads inside it?
 *
 * viem answers both with one `failure` per entry, so the results have to say
 * which. Two facts tell them apart, and the rule needs both (#2579):
 *
 *   - **One error object shared by every entry.** On a rejected aggregate viem
 *     pushes the same `result.reason` for each call in the batch, while each
 *     entry's own revert is decoded into a fresh error of its own. With
 *     `batchSize: 0` there is one batch per call, so two or more entries
 *     sharing one object can only be the aggregate's rejection.
 *   - **An error that names `aggregate3`.** With ONE entry, "every entry
 *     shares the first entry's error" is true of any failure, so identity
 *     proves nothing: a single loan's own revert used to read as a rejected
 *     aggregate and was retried serially, logged as an RPC fault. The
 *     rejection is the error viem's `readContract` raised for the `aggregate3`
 *     call, and it carries that function's name; an entry's own error carries
 *     the entry's function name. So a one-entry chunk is a rejection only when
 *     its error names `aggregate3`, and a genuine RPC rejection of a one-entry
 *     chunk is still retried.
 */
export function isAggregateRejection(results: readonly BatchResult[]): boolean {
  const first = results[0]?.error;
  if (first === undefined) return false;
  if (!results.every((r) => r.status === 'failure' && r.error === first)) return false;
  return results.length > 1 || namesAggregateCall(first);
}

/** Whether `r` failed on its OWN call (Codex #2607 r14): the contract answered
 *  `functionName` with a revert, or with data that does not decode. viem names
 *  the entry's function on that error and only on that one, so an aggregate
 *  rejection (which names `aggregate3`), a run-deadline refusal and a read
 *  abandoned at its cutoff are all excluded: those are values not read, not
 *  answers. */
export function failedOnOwnCall(r: BatchResult | undefined, functionName: string): boolean {
  if (r?.status !== 'failure') return false;
  const err = r.error;
  return typeof err === 'object' && err !== null && (err as { functionName?: unknown }).functionName === functionName;
}

/** The error was raised for the `aggregate3` call itself (viem's `functionName` on it). */
function namesAggregateCall(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { functionName?: unknown }).functionName === 'aggregate3'
  );
}

/** One read per contract — the degraded path, kept out of `batchedRead` so both entries share it. */
async function serialRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  blockNumber: bigint | undefined,
): Promise<{ status: 'success' | 'failure'; result?: unknown; error?: unknown }[]> {
  const out: { status: 'success' | 'failure'; result?: unknown; error?: unknown }[] = [];
  for (const c of contracts) {
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

/**
 * {@link batchedRead} for a pass whose run has a DEADLINE (#2497 r18, r19): the
 * one read helper every chain read in such a pass goes through, so no read can
 * outlast the run. Past the deadline it issues nothing; a rejected aggregate
 * degrades to `'unread'` (one request, whatever happens) rather than to one
 * serial request per entry. Either way the entries read as failures, which
 * every caller already treats as "not read — try next run".
 */
export async function boundedRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  label: string,
  deadline: number,
  /** Read at this block rather than the head (see {@link batchedRead}). */
  blockNumber?: bigint,
): Promise<BatchResult[]> {
  if (Date.now() >= deadline) {
    const error = new Error(`${label}: past the run deadline — read next run`);
    return contracts.map(() => ({ status: 'failure' as const, error }));
  }
  return batchedRead(client, contracts, label, blockNumber, 'unread');
}

/**
 * {@link boundedRead} that also SETTLES by `deadline` (Codex #2607 r7): a read
 * still in flight then is abandoned, and its entries read as failures like any
 * other unread value. `boundedRead` refuses to START a read past its deadline
 * but awaits one already started, so a single slow RPC can hold its caller
 * well past it; a read phase that feeds sends must not be held so
 * (`runWindow.ts` rule 3). The abandoned request finishes in the background
 * and its answer is dropped.
 */
export async function settledRead(
  client: ReturnType<typeof createPublicClient>,
  contracts: readonly unknown[],
  label: string,
  deadline: number,
  /** Read at this block rather than the head (see {@link batchedRead}). */
  blockNumber?: bigint,
): Promise<BatchResult[]> {
  return settleBy(boundedRead(client, contracts, label, deadline, blockNumber), deadline, () => {
    const error = new Error(`${label}: still in flight at the read deadline — read next run`);
    return contracts.map(() => ({ status: 'failure' as const, error }));
  });
}

/**
 * The keeper's ONE chunked read under a cutoff (Codex #2607 r16): `keys` read
 * `chunk` at a time through {@link settledRead}, starting at a point that moves
 * each run (`runWindow.ts` rule 2). A cutoff ends a run's reads partway, so a
 * fixed order would leave the same tail unread every run; owning the rotation
 * here means no caller can forget it. Each key maps to its result; a key whose
 * chunk was not read maps to a failure like any other unread value.
 */
export async function settledChunkedRead<K>(
  client: ReturnType<typeof createPublicClient>,
  keys: readonly K[],
  chunk: number,
  call: (key: K) => unknown,
  label: string,
  cutoff: number,
  run: number,
  /** Read every chunk at this block rather than the head (see {@link batchedRead}). */
  blockNumber?: bigint,
): Promise<Map<K, BatchResult>> {
  const out = new Map<K, BatchResult>();
  const order = walkFrom(keys, run);
  for (let i = 0; i < order.length; i += chunk) {
    const part = order.slice(i, i + chunk);
    // eslint-disable-next-line no-await-in-loop
    const res = await settledRead(client, part.map(call), `${label} ${i}/${order.length}`, cutoff, blockNumber);
    part.forEach((k, j) => out.set(k, res[j]));
  }
  return out;
}

/** The longest delay `setTimeout` honours (2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `work`, or what `onCut` gives (or throws) if `work` is still in flight at
 * `deadline` — the one primitive behind every "abandon it at the cutoff" in
 * the keeper (`runWindow.ts` rule 3). An abandoned `work` keeps running; its
 * late outcome, a rejection included, is discarded rather than left
 * unhandled. Use it for READS, and for a write whose late landing is harmless
 * either way (an ops alert's de-duplication record or clear, #2565 r1):
 * abandoning a broadcast would lose the record that it was sent.
 *
 * A deadline past a timer's range never cuts: `setTimeout` treats a delay
 * past its 32-bit range (about 24.8 days) as 1 ms, so an `Infinity` ("no
 * deadline"), or any deadline that far off, would otherwise abandon the work
 * at once. No run lasts that long, so such a deadline is no deadline.
 */
export async function settleBy<T>(work: Promise<T>, deadline: number, onCut: () => T): Promise<T> {
  if (!Number.isFinite(deadline) || deadline - Date.now() > MAX_TIMER_MS) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  const cut = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onCut());
      } catch (err) {
        reject(err);
      }
    }, Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, cut]);
  } finally {
    clearTimeout(timer);
  }
}

/** A read refused because the pass's run deadline has passed (#2497 re-cut). */
export class PastRunDeadline extends Error {
  /** What `callErrors.shortErr` reports: the message, which names the read
   *  and the cutoff it missed, so an unread line says why. */
  get shortMessage(): string {
    return this.message;
  }
}

/** The client READ methods a pass uses, each refused past the deadline. */
const DEADLINE_GUARDED = new Set(['readContract', 'multicall', 'simulateContract', 'call', 'getLogs', 'getCode', 'getBytecode', 'getStorageAt']);

/**
 * `client` with every READ refused once `deadline` has passed — the ONE place
 * a deadline-bound pass's reads are bounded, so a read added later (a hint
 * walk, a single `readContract`) cannot slip past it the way per-call checks
 * could (#2497 re-cut review). A refusal throws `PastRunDeadline`, which every
 * caller already treats as an unread value for the next run. Receipt waits are
 * NOT guarded: a sent transaction's outcome is still worth knowing.
 */
export function deadlineClient<T extends object>(client: T, deadline: number): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (!DEADLINE_GUARDED.has(String(prop))) return value.bind(target);
      return (...args: unknown[]) => {
        if (Date.now() >= deadline) throw new PastRunDeadline(`${String(prop)}: past the run deadline — read next run`);
        return value.apply(target, args);
      };
    },
  });
}

/**
 * `client` for a phase that only READS (an attempt's judge, #3069): EVERY
 * method refused once `cutoff` has passed, not only the reads
 * {@link deadlineClient} names, so a phase abandoned at its cutoff cannot
 * start one more request of any kind (the clock, a nonce count, a
 * simulation) when a late answer lets it go on. Never use it for a client
 * that sends or waits for a receipt.
 */
export function readPhaseClient<T extends object>(client: T, cutoff: number): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (Date.now() >= cutoff) throw new PastRunDeadline(`${String(prop)}: past the read cutoff — read next run`);
        return value.apply(target, args);
      };
    },
  });
}

/** `fetchFn`, refusing every request that would start at or after `cutoff`:
 *  the route quotes of a read-only phase (#3069), bounded the way
 *  {@link readPhaseClient} bounds its RPC reads. */
export function deadlineFetch(fetchFn: typeof fetch, cutoff: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Date.now() >= cutoff
      ? Promise.reject(new PastRunDeadline('a quote request: past the read cutoff — read next run'))
      : fetchFn(input, init)) as typeof fetch;
}
