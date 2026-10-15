/**
 * A hard cap on the outbound requests one pass may make in one run.
 *
 * Cloudflare's free plan allows an invocation 50 subrequests, shared by
 * every pass the tick launches. A pass whose cost grows with something it
 * does not control (the number of chains, the size of a book, the length
 * of governance's adapter roster) can spend that allowance before the
 * other passes run. Bounding each input separately only moves the problem
 * to the next input, so this bounds the requests themselves.
 *
 * Every request the pass makes goes through {@link SubrequestBudget.fetch}:
 * its RPC reads, its wallet's transaction preparation and send (both viem
 * clients take it as `fetchFn`), and its aggregator quotes. Once `limit`
 * requests have been made, the next one throws {@link SubrequestBudgetExhausted}
 * BEFORE any network call. The caller then reads {@link SubrequestBudget.exhausted}
 * and reports the run as cut short.
 *
 * Fail-closed for a sending pass: the send is the last request an attempt
 * makes, so a run that hits the cap earlier stops before it.
 *
 * Scope: a budget counts only the requests routed through it. Today one
 * pass (graceDefault) has one, so it bounds that pass and not the
 * invocation; sharing one budget across every due pass is #2490.
 */
export class SubrequestBudgetExhausted extends Error {
  constructor(readonly limit: number) {
    super(`subrequest budget of ${limit} spent`);
    this.name = 'SubrequestBudgetExhausted';
  }
}

export interface SubrequestBudget {
  readonly limit: number;
  /** Requests made so far. Never exceeds `limit`. */
  spent(): number;
  /** True once a request was refused for want of budget. */
  exhausted(): boolean;
  /** `fetch`, charged against the budget. */
  fetch: typeof fetch;
}

export function createSubrequestBudget(
  limit: number,
  /** The fetch actually called. Defaults to the global one; tests and the
   *  bench inject theirs. Read at call time, so a mock installed after the
   *  budget is created is still the one used. */
  inner?: typeof fetch,
): SubrequestBudget {
  let spent = 0;
  let refused = false;
  const charged = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (spent >= limit) {
      refused = true;
      return Promise.reject(new SubrequestBudgetExhausted(limit));
    }
    spent += 1;
    return (inner ?? globalThis.fetch)(input, init);
  }) as typeof fetch;
  return {
    limit,
    spent: () => spent,
    exhausted: () => refused,
    fetch: charged,
  };
}
