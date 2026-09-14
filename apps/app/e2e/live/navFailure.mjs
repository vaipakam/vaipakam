/**
 * How a failed navigation is described in a route's one-line row.
 *
 * ITS OWN MODULE, importing nothing, and that is the point (#2109 r1
 * P1). This started life in `driver.mjs`, on the reasoning that the
 * shared harness is side-effect free — a claim I made from a grep for
 * top-level `await` at column zero. It is not: `driver.mjs` runs an
 * `await import()` of the egress shim inside a top-level `if`, and calls
 * `blockedSync` when that fails, which EXITS THE PROCESS. A unit test of
 * a string formatter could have killed the test runner, and would have
 * loaded Playwright and viem to do it.
 *
 * A formatter needs none of that. Nothing here imports anything.
 */

/**
 * Why a navigation failed, in a few words fit for a one-line row.
 *
 * `timedOut` is decided at the CATCH SITE, from the error's identity
 * (`errors.TimeoutError`), not from its text. An earlier version matched
 * `/timeout/i` and `/exceed/i` against the message, which is a string
 * test standing in for a question about a value — and it could label a
 * genuine failure as a timeout, which is the dangerous direction: it
 * hands a real defect an infrastructure excuse.
 *
 * WHAT THE TIMEOUT WORDING MAY CLAIM, and may not. A `goto` that waits
 * for `load` can time out after the document committed — responses
 * arrived, scripts ran, console errors were recorded — because one
 * subresource hung. The sweep keeps those observations and prints their
 * counters on the same row. So this says the LOAD never completed, and
 * that the route is not fully reviewed. An earlier version said the
 * route was "NOT OBSERVED", which the counters beside it contradict.
 */
export function navFailureReason({ timedOut, message }, budgetMs) {
  if (timedOut) {
    return (
      `navigation timed out — the page never finished loading within the ` +
      `${budgetMs / 1000}s budget, so this route is NOT FULLY REVIEWED ` +
      `(whatever the counters above did record)`
    );
  }
  const firstLine = String(message ?? '')
    .split('\n')[0]
    .trim();
  return `navigation failed: ${firstLine.slice(0, 120)}`;
}
