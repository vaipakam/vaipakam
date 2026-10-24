/**
 * Was a read the page made left unserved? Asked of the page's query cache,
 * not reconstructed from the wire (#1672, superseding the #1583 approach).
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
 * The query cache knows. It owns the retry policy, and a read that spent
 * it settles in error once. The app reports those settlements to a driver
 * that installed {@link QUERY_PROBE_BINDING} before load
 * (`src/lib/queryStateProbe.ts`), and announces itself on every document
 * load so a build without the report is told apart from a clean page.
 *
 * What this module decides, per page:
 *
 *   - a settlement whose cause is the provider not answering is an
 *     UNSERVED read: the page ran without data it asked for, so nothing
 *     observed on it can be trusted (BLOCKED);
 *   - one whose cause is a reachable provider rejecting the request as
 *     malformed is a defect in what the page sent (FAIL);
 *   - one whose cause is the EVM answering (a revert) is information the
 *     app is expected to handle, and one the app cancelled itself is no
 *     failure to serve; both are reported, neither decides;
 *   - a page that loaded and never announced the report cannot be judged
 *     on this question at all (BLOCKED, naming the build).
 *
 * The cause is classified by `classifyRpcFailure`, the one rule the drives
 * have for a failed RPC, over the cause chain the app sends. Anything that
 * rule does not positively recognise as an answer is unserved, which is
 * the loud direction: an indexer read that failed is a read the page did
 * not get.
 *
 * WHAT IT DOES NOT SEE: a read made outside the query cache. On the pages
 * this drive watches those are the pre-checks a submit runs, which a
 * watch-only drive never triggers, and the forced-close card's
 * confirmation reads, which that card's own verdict judges with its own
 * reads. The wire ledger still records every attempt, and the report
 * names the failed ones beside any verdict, for attribution.
 */
import { classifyRpcFailure } from './rpc-verdict.mjs';

/** The page global the app reports through (`queryStateProbe.ts`). */
export const QUERY_PROBE_BINDING = '__vaipakamQueryProbe';
/** The one report shape this drive reads (`queryStateProbe.ts`). */
export const QUERY_PROBE_VERSION = 1;

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
 * What a settled error says about the read.
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

/**
 * A per-page record of what the app reported.
 *
 * Keyed by the caller's page identity (the drive's cohort). An event in a
 * shape this file does not know is kept as REFUSED rather than read: a
 * newer report read with old field names would pass unserved reads as
 * clean.
 */
export function createQueryProbe() {
  const pages = new Map();
  const pageOf = (id) => {
    let p = pages.get(id);
    if (!p) {
      p = { armed: 0, settled: [], refused: [] };
      pages.set(id, p);
    }
    return p;
  };
  return {
    /** The binding's body: one event from the page `id`. */
    record(id, event) {
      const p = pageOf(id);
      if (!event || typeof event !== 'object' || event.v !== QUERY_PROBE_VERSION) {
        p.refused.push(`report version ${JSON.stringify(event?.v)} (this drive reads ${QUERY_PROBE_VERSION})`);
        return;
      }
      if (event.kind === 'armed') {
        p.armed += 1;
        return;
      }
      if (
        event.kind === 'settled-error' &&
        typeof event.queryKey === 'string' &&
        Array.isArray(event.error)
      ) {
        p.settled.push({
          queryKey: event.queryKey,
          failureCount: typeof event.failureCount === 'number' ? event.failureCount : null,
          hadData: event.hadData === true,
          error: event.error,
        });
        return;
      }
      p.refused.push(`report kind ${JSON.stringify(event.kind)} carrying unexpected fields`);
    },
    /** What page `id` reported, as judged by {@link judgeQueryProbe}. */
    of(id) {
      return judgeQueryProbe(pages.get(id));
    },
  };
}

/**
 * One page's report, judged.
 *
 * @returns {{ armed: boolean, refused: string[],
 *   unserved: string[], faults: string[], answered: string[], cancelled: number }}
 */
export function judgeQueryProbe(page) {
  const out = {
    armed: (page?.armed ?? 0) > 0,
    refused: [...(page?.refused ?? [])],
    unserved: [],
    faults: [],
    answered: [],
    cancelled: 0,
  };
  for (const s of page?.settled ?? []) {
    const verdict = classifyQueryError(s.error);
    if (verdict === 'cancelled') {
      out.cancelled += 1;
      continue;
    }
    const attempts = s.failureCount === null ? 'an unknown number of' : String(s.failureCount);
    const line =
      `${s.queryKey.slice(0, 160)} — settled in error after ${attempts} failed attempt(s)` +
      `${s.hadData ? ', over data from an earlier fetch' : ''}: ${causeText(s.error)}`;
    if (verdict === 'unreachable') out.unserved.push(line);
    else if (verdict === 'client-fault') out.faults.push(line);
    else out.answered.push(line);
  }
  return out;
}
