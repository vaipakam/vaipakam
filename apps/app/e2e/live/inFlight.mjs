/**
 * A registry of handlers still running, so a verdict can wait for them
 * before it is read (#1633 item 6).
 *
 * `live-position-observe.mjs` proxies every page request through a route
 * handler, and a handler records its outcome (an answer in the response
 * ledger, or a route failure) only when it finishes. Two readings were
 * taken without waiting for that. The chooser wait gave up after 45s and
 * the page was judged at once, so a dependency still answering read as a
 * missing chooser; and the report was read as soon as the browser closed,
 * so a request still in flight was judged by nobody. Each now waits for
 * the handlers running at that moment, and counts the ones that outlive
 * the bound, so a handler that never finishes cannot drop out of the
 * verdict either.
 *
 * Each call can carry a KEY (the drive uses the page's cohort), so one
 * page's wait is not held up by another page's traffic.
 *
 * Imports nothing, so a unit test can run it without a browser.
 */

/**
 * @returns {{
 *   track: (fn: (...args: any[]) => any, keyOf?: (...args: any[]) => unknown) => (...args: any[]) => Promise<any>,
 *   drain: (boundMs: number, key?: unknown) => Promise<number>,
 *   size: (key?: unknown) => number,
 * }}
 */
export function createInFlight() {
  /** @type {Map<Promise<unknown>, unknown>} running call → its key */
  const running = new Map();
  const now = (key) =>
    [...running].filter(([, k]) => key === undefined || k === key).map(([run]) => run);
  return {
    /**
     * Wrap `fn` so every call is tracked until it settles. `keyOf` is
     * given the call's arguments; a key that cannot be computed leaves the
     * call unkeyed, which a keyed drain does not wait for but an unkeyed
     * one does.
     */
    track(fn, keyOf) {
      return (...args) => {
        let key;
        try {
          key = keyOf ? keyOf(...args) : undefined;
        } catch {
          key = undefined;
        }
        const run = Promise.resolve().then(() => fn(...args));
        running.set(run, key);
        run.then(
          () => running.delete(run),
          () => running.delete(run),
        );
        return run;
      };
    },
    /**
     * Wait for the calls running NOW (every call, or only those with
     * `key`) to settle, or for `boundMs`, whichever is first. Calls begun
     * during the wait are not waited for, so a page that keeps polling
     * cannot hold it open. Resolves to how many of them had still not
     * settled at the bound: zero means every outcome is recorded.
     */
    async drain(boundMs, key) {
      const pending = now(key);
      if (pending.length === 0) return 0;
      let timer;
      const bound = new Promise((resolve) => {
        timer = setTimeout(resolve, boundMs);
      });
      await Promise.race([Promise.allSettled(pending), bound]);
      clearTimeout(timer);
      return pending.filter((run) => running.has(run)).length;
    },
    /** How many calls are running (with `key`, when given). */
    size(key) {
      return now(key).length;
    },
  };
}
