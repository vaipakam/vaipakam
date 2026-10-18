/**
 * The keeper's read client, bound by the run's deadline at the RPC boundary
 * (#2497 r21).
 *
 * Every pass builds its read client here. The transport refuses every request
 * once the run's {@link PassTick.deadlineMs} has passed — a contract read, a
 * simulation, a multicall, a log scan, a block lookup — before anything leaves
 * the process, with {@link RunDeadlinePassed}. So no read loop in any pass can
 * carry a run past its own cadence, whatever shape the loop has and whether
 * or not the author remembered the deadline: a read written tomorrow against
 * this client is bound the same way. The batched reader (`batchRead.ts`)
 * turns the refusal into per-entry "unread" results; everything else sees it
 * as the rejection it is.
 *
 * The wallet's transport is NOT bound here. Its gate is the submission queue
 * (`submissionQueue.ts`), which refuses a slot reached past the deadline before
 * the nonce is read; a transaction admitted before the deadline is signed and
 * broadcast whatever the clock says then, because a refusal between the nonce
 * read and the broadcast would leave the slot's bookkeeping guessing. Its
 * receipt is awaited through THIS client, so a run does not wait for inclusion
 * past its deadline either: the next run reads the outcome from the chain,
 * which every pass does at the top of its tick anyway.
 */
import { createPublicClient, http, type PublicClient, type Transport } from 'viem';
import { RunDeadlinePassed, pastDeadline } from './runDeadline';

/** `inner`, refusing every request once `deadlineMs` has passed. Exported
 *  for the tests, which bind a custom transport. */
export function deadlineBoundTransport(inner: Transport, deadlineMs: number): Transport {
  return (params) => {
    const t = inner(params);
    return {
      ...t,
      request: ((args, options) => {
        if (pastDeadline(deadlineMs)) {
          return Promise.reject(new RunDeadlinePassed(String((args as { method?: unknown }).method ?? 'request')));
        }
        return t.request(args, options);
      }) as typeof t.request,
    };
  };
}

/** The keeper's read client on `rpc` for a run ending at `deadlineMs`. The
 *  client is chainless on purpose (see `multicall3.ts`); `fetchFn` is the
 *  fetch a pass's subrequest budget wraps, where it has one. */
export function keeperPublicClient(rpc: string, deadlineMs: number, fetchFn?: typeof fetch): PublicClient {
  return createPublicClient({
    transport: deadlineBoundTransport(http(rpc, fetchFn ? { fetchFn } : undefined), deadlineMs),
  }) as PublicClient;
}
