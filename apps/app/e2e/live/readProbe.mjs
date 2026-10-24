/**
 * Was a read the page made left unserved? Asked of the app itself, not
 * reconstructed from the wire (#1672, superseding the #1583 approach).
 *
 * The drive used to answer this from its RPC ledger: a failed attempt
 * counted unless a later success of the same method and params, in the
 * same page, requested after the failure and within 1.5s, looked like its
 * retry. That rule could not be made sound, and #1672 records why: viem
 * gives every attempt a fresh JSON-RPC id, concurrent duplicate reads are
 * byte-identical, and a retry chain's gaps (viem's 10s timeout, attempts
 * in sequence) overlap the app's 15s polls. So it erred both ways — a slow
 * recovered retry read as an outage, and an exhausted read cleared by an
 * unrelated sibling read as served.
 *
 * The app knows, from two places, and reports both to a driver that
 * installed {@link READ_PROBE_BINDING} before load (`src/lib/readProbe.ts`):
 *
 *   - ITS RPC TRANSPORT reports each request once, with its method, when
 *     the request comes back after viem's retries and fallbacks. This is
 *     what sees a read a hook degrades into a value: `useMyLoansFull`
 *     returns `null` ("unavailable") when its chain read fails, which the
 *     query cache records as a success (#2783 r1).
 *   - ITS QUERY CACHE reports a query that settled in error once its
 *     retries were spent (a decode error, an exception in the query's own
 *     code), and a query waiting to retry, so the drive can wait for it.
 *
 * Both announce nothing until the app calls `armed` on load, so a build
 * without the report is told apart from a clean page.
 *
 * What this module decides, per page:
 *
 *   - an RPC request that failed for good, or a query that settled in
 *     error, because the provider did not answer, is an UNSERVED read: the
 *     page ran without data it asked for, so nothing observed on it can be
 *     trusted (BLOCKED);
 *   - one whose cause is a reachable provider rejecting the request as
 *     malformed is a defect in what the page sent (FAIL);
 *   - one whose cause is the EVM answering (a revert) is information the
 *     app is expected to handle, and one the app cancelled itself is no
 *     failure to serve; both are reported, neither decides. A revert is an
 *     answer only from a method that RUNS EVM code (`EXECUTING_METHODS`,
 *     the rule the wire classifier applies): a revert-shaped error from
 *     `eth_blockNumber` served nothing (#2783 r1);
 *   - a request still in flight, or a query still waiting to retry, when
 *     the page is judged is PENDING: not yet an answer either way. The
 *     drive waits a bounded time for it ({@link createReadProbe}'s
 *     `settle`) and a read still pending then is unserved too;
 *   - a page that loaded and never announced the report cannot be judged
 *     on this question at all (BLOCKED, naming the build).
 *
 * A LATER SUCCESS OF THE SAME READ IS NOT CREDITED. The page may have
 * asked again and been answered, but the drive cannot tell which of the
 * two answers a given observation saw, so a read that failed for good
 * leaves the page unjudged. That direction can only make a run
 * inconclusive, never wrongly judged.
 *
 * Cause classification is `classifyRpcFailure`, the one rule the drives
 * have for a failed RPC, over the cause chain the app sends. Anything that
 * rule does not positively recognise as an answer is unserved.
 *
 * WHAT IT DOES NOT SEE: the indexer reads the app fetches outside both
 * (its `getJson` helper turns any failure into `null`). This drive has
 * never judged indexer availability; the gap is tracked as its own issue.
 */
import { EXECUTING_METHODS, classifyRpcFailure } from './rpc-verdict.mjs';

/** The page global the app reports through (`src/lib/readProbe.ts`). */
export const READ_PROBE_BINDING = '__vaipakamReadProbe';
/** The one report shape this drive reads (`src/lib/readProbe.ts`). */
export const READ_PROBE_VERSION = 1;

/**
 * The app's cause chain as an error `classifyRpcFailure` can read: nested
 * through `cause`, with viem's `walk` (first link the predicate accepts,
 * `null` when none does).
 *
 * @param {ReadonlyArray<{name?: string, code?: number, data?: string, message?: string}>} chain
 */
export function errorFromChain(chain) {
  let next;
  for (let i = chain.length - 1; i >= 0; i--) {
    const link = chain[i] ?? {};
    const e = {
      name: link.name,
      code: link.code,
      data: link.data,
      shortMessage: link.message,
      cause: next,
      walk(fn) {
        for (let x = this; x; x = x.cause) if (fn(x)) return x;
        return null;
      },
    };
    next = e;
  }
  return next;
}

/**
 * What a query's settled error says about the read.
 *
 * No method is known here, so a revert keeps the general rule. A query
 * whose failure was an RPC failure is also reported by the transport,
 * where the method is known and the stricter rule below applies.
 *
 * @returns {'cancelled' | 'answered' | 'client-fault' | 'unreachable'}
 */
export function classifyQueryError(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return 'unreachable';
  // TanStack's own class for a fetch the app called off. Only a
  // cancellation that keeps nothing to revert to settles in error at all,
  // and it is the app's decision, not the provider's.
  if (chain[0]?.name === 'CancelledError') return 'cancelled';
  return classifyRpcFailure(errorFromChain(chain));
}

/**
 * What an RPC request's final failure says about the read, given the
 * method it carried.
 *
 * @returns {'answered' | 'client-fault' | 'unreachable'}
 */
export function classifyRpcRead(method, chain) {
  if (!Array.isArray(chain) || chain.length === 0) return 'unreachable';
  const verdict = classifyRpcFailure(errorFromChain(chain));
  // An `answered` verdict is an EVM answer, so it only exempts a method
  // that runs EVM code — the wire classifier's rule (round 72 of #1529),
  // which this answer now replaces for unserved reads (#2783 r1).
  if (verdict === 'answered' && !EXECUTING_METHODS.has(String(method))) return 'unreachable';
  return verdict;
}

/** The chain's most specific words, for a report line. */
function causeText(chain) {
  const parts = (chain ?? [])
    .map((l) => [l.name, l.code !== undefined ? `code=${l.code}` : null, l.message].filter(Boolean).join(' '))
    .filter((s) => s !== '');
  // The app sends viem's short message, which names no URL. A URL in it
  // anyway is cut here rather than printed, since an RPC URL can carry a
  // provider key.
  const text = parts.length ? parts.slice(-2).join(' ← ') : 'no cause recorded';
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(url withheld)');
}

const isChain = (c) => Array.isArray(c);
const isCount = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * A per-page record of what the app reported.
 *
 * Keyed by the caller's page identity (the drive's cohort). An event in a
 * shape this file does not know is kept as REFUSED rather than read: a
 * newer report read with old field names would pass unserved reads as
 * clean.
 *
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number }} [deps]
 */
export function createReadProbe({
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const pages = new Map();
  const pageOf = (id) => {
    let p = pages.get(id);
    if (!p) {
      p = { armed: 0, rpc: new Map(), retrying: new Map(), settled: [], refused: [] };
      pages.set(id, p);
    }
    return p;
  };
  const refuse = (p, event) =>
    p.refused.push(`report kind ${JSON.stringify(event.kind)} carrying unexpected fields`);
  /** The page's reads that have not reached an outcome, as stable keys. */
  const pendingKeys = (p) => [
    ...[...p.rpc.entries()].filter(([, r]) => !r.done).map(([seq]) => `rpc:${seq}`),
    ...[...p.retrying.keys()].map((h) => `query:${h}`),
  ];
  return {
    /** The binding's body: one event from the page `id`. */
    record(id, event) {
      const p = pageOf(id);
      if (!event || typeof event !== 'object' || event.v !== READ_PROBE_VERSION) {
        p.refused.push(`report version ${JSON.stringify(event?.v)} (this drive reads ${READ_PROBE_VERSION})`);
        return;
      }
      switch (event.kind) {
        case 'armed':
          p.armed += 1;
          return;
        case 'rpc-start':
          if (!isCount(event.seq) || !isCount(event.chainId) || typeof event.method !== 'string') break;
          p.rpc.set(event.seq, { chainId: event.chainId, method: event.method, done: false });
          return;
        case 'rpc-settled': {
          if (!isCount(event.seq) || !isCount(event.chainId) || typeof event.method !== 'string') break;
          if (typeof event.ok !== 'boolean' || (!event.ok && !isChain(event.error))) break;
          p.rpc.set(event.seq, {
            chainId: event.chainId,
            method: event.method,
            done: true,
            ok: event.ok,
            error: event.ok ? null : event.error,
          });
          return;
        }
        case 'query-retrying':
          if (typeof event.queryHash !== 'string' || typeof event.queryKey !== 'string') break;
          p.retrying.set(event.queryHash, { queryKey: event.queryKey, failureCount: event.failureCount });
          return;
        case 'query-settled': {
          if (typeof event.queryHash !== 'string' || typeof event.queryKey !== 'string') break;
          if (!['ok', 'error', 'cancelled'].includes(event.outcome)) break;
          if (event.outcome === 'error' && !isChain(event.error)) break;
          p.retrying.delete(event.queryHash);
          if (event.outcome === 'error') {
            p.settled.push({
              queryKey: event.queryKey,
              failureCount: isCount(event.failureCount) ? event.failureCount : null,
              hadData: event.hadData === true,
              error: event.error,
            });
          }
          return;
        }
        default:
          break;
      }
      refuse(p, event);
    },
    /**
     * Wait, at most `timeoutMs`, for every read page `id` had not settled
     * when this was called. Reads started after the call are not waited
     * for: a polling page always has one in flight, and the observations
     * being judged were all made before it.
     */
    async settle(id, { timeoutMs, pollMs = 100 }) {
      const p = pages.get(id);
      if (!p) return;
      const waiting = new Set(pendingKeys(p));
      const deadline = now() + timeoutMs;
      while (waiting.size > 0 && now() < deadline) {
        await sleep(pollMs);
        const still = new Set(pendingKeys(p));
        for (const k of [...waiting]) if (!still.has(k)) waiting.delete(k);
      }
    },
    /** What page `id` reported, as judged by {@link judgeReadProbe}. */
    of(id, options) {
      return judgeReadProbe(pages.get(id), options);
    },
  };
}

/**
 * One page's report, judged. `chainId` is the chain the drive observes;
 * a read on any other chain (the app's ENS lookups on Ethereum) is listed
 * under `elsewhere` and decides nothing.
 *
 * @returns {{ armed: boolean, refused: string[], unserved: string[],
 *   pending: string[], faults: string[], answered: string[],
 *   cancelled: number, elsewhere: string[] }}
 */
export function judgeReadProbe(page, { chainId = null } = {}) {
  const out = {
    armed: (page?.armed ?? 0) > 0,
    refused: [...(page?.refused ?? [])],
    unserved: [],
    pending: [],
    faults: [],
    answered: [],
    cancelled: 0,
    elsewhere: [],
  };
  const place = (verdict, line) => {
    if (verdict === 'unreachable') out.unserved.push(line);
    else if (verdict === 'client-fault') out.faults.push(line);
    else out.answered.push(line);
  };
  for (const r of page?.rpc?.values() ?? []) {
    const offChain = chainId !== null && r.chainId !== chainId;
    if (!r.done) {
      const line = `rpc ${r.method} on chain ${r.chainId} — still in flight when the page was judged`;
      if (offChain) out.elsewhere.push(line);
      else out.pending.push(line);
      continue;
    }
    if (r.ok) continue;
    const verdict = classifyRpcRead(r.method, r.error);
    const line = `rpc ${r.method} on chain ${r.chainId} — failed after the client's retries: ${causeText(r.error)}`;
    if (offChain) out.elsewhere.push(line);
    else place(verdict, line);
  }
  for (const q of page?.retrying?.values() ?? []) {
    out.pending.push(`query ${q.queryKey} — still waiting to retry when the page was judged`);
  }
  for (const s of page?.settled ?? []) {
    const verdict = classifyQueryError(s.error);
    if (verdict === 'cancelled') {
      out.cancelled += 1;
      continue;
    }
    const attempts = s.failureCount === null ? 'an unknown number of' : String(s.failureCount);
    const line =
      `query ${s.queryKey} — settled in error after ${attempts} failed attempt(s)` +
      `${s.hadData ? ', over data from an earlier fetch' : ''}: ${causeText(s.error)}`;
    place(verdict, line);
  }
  return out;
}
