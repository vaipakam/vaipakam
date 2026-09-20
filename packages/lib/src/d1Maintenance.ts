/**
 * The D1 maintenance barrier — how a Worker is held off a database while its
 * binding is being moved, WITHOUT anybody having to enumerate its writers.
 *
 * ## The problem this exists for (#2239)
 *
 * `docs/ops/D1CutoverArchiveToWarm.md` has to quiesce every writer across a
 * binding change. Four review rounds on #2238 tried to specify that by listing
 * the ways a writer reaches D1, and each round found another: a second Worker,
 * a cron event that traverses no route, a `workers.dev` alias that bypasses a
 * zone rule, the agent's diagnostic routes, a Durable Object alarm that
 * re-arms itself, and `ctx.waitUntil` continuations admitted before the gate.
 * The list was not finished, and it never will be:
 *
 * > **You cannot prove "no writer" by listing writers. You can prove it by
 * > removing the write capability.**
 *
 * A maintenance deployment whose `d1_databases` entry is **absent** makes every
 * write attempt fail regardless of which handler, route, hostname, alarm or
 * continuation makes it — including entry points nobody has enumerated, and
 * ones added next year. That is the primitive, and it lives in wrangler config
 * rather than in this file. Nothing here can be bypassed by forgetting to call
 * it, because it is not what provides the safety.
 *
 * **The guarantee is over work the maintenance deployment ADMITS, and that
 * qualifier is load-bearing** (#2252 r8). A `waitUntil` continuation or a
 * Durable Object alarm admitted by the PREVIOUS deployment keeps the
 * environment it captured — bound, to the database being abandoned — and can
 * still write until it finishes. Removing the binding does not reach inside a
 * running execution. That residual is real, it is what an operator's drain
 * waits out, and it is stated in `docs/FunctionalSpecs/ProjectDetailsREADME.md`
 * §13 and in the cutover runbook. This comment said "including … continuation"
 * without the qualifier while both of those already carried it, which is the
 * one place a future author would come looking for the rule.
 *
 * ## What this module adds on top, and why it is NOT the barrier
 *
 * With the binding gone, `env.DB` is `undefined` and the call sites throw
 * `Cannot read properties of undefined (reading 'prepare')`. That is loud but
 * uninformative, and on a fund-bearing surface the wrong kind of loud: it
 * looks like a bug in the Worker rather than a deliberate, temporary refusal,
 * and it tells the operator reading the log nothing about whether the write
 * landed.
 *
 * So this module converts an absent binding into a **stated** refusal:
 *
 * - `resolveD1Binding` substitutes a stub at the env seam, so every unknown
 *   entry point fails identically and legibly;
 * - the stub's error says which Worker refused, which method was called, and —
 *   the part that matters on a funds surface — that **nothing was read or
 *   written**;
 * - `maintenanceRefusal` gives the entry points one shared 503 to answer with,
 *   so a caller is told the write did not happen rather than being handed a
 *   500 that could mean anything, or a stale read that implies it did.
 *
 * ## Why a Proxy rather than an object with the five D1 methods on it
 *
 * Because "the five D1 methods" is the enumeration trap one level down. A stub
 * listing `prepare`/`batch`/`exec`/`dump`/`withSession` returns `undefined` for
 * anything D1 adds later, and the caller gets `undefined is not a function` —
 * the uninformative failure this module exists to replace, reappearing exactly
 * when the platform changes under us. The Proxy states a rule instead of a
 * list: the JavaScript object protocol keeps working, and anything a *database*
 * would provide refuses by name.
 *
 * Framework-free by design: no D1 types, no `Response`, no viem, no DOM. The
 * stub is returned as `unknown` and cast at each Worker's seam, where the
 * Cloudflare types actually live, and `maintenanceRefusal` returns the parts of
 * an HTTP response rather than constructing one.
 */

/**
 * The marker that identifies a refusal from this module.
 *
 * Checked as a property rather than with `instanceof`, because the three
 * Workers bundle their own copy of this package: an `instanceof` against one
 * bundle's class is false for an error thrown by another's, and the failure
 * mode is a refusal silently reclassified as an unknown error.
 */
export const D1_MAINTENANCE_CODE = 'vaipakam.d1.maintenance';

/** Thrown by the stub when anything tries to use a database that is not bound. */
export class D1MaintenanceError extends Error {
  readonly code = D1_MAINTENANCE_CODE;
  /** The Worker that refused — the label its seam was given. */
  readonly worker: string;
  /** The property that was called, e.g. `prepare`. */
  readonly operation: string;

  constructor(worker: string, operation: string) {
    super(
      `D1 is not available: ${worker} is running a maintenance build with no ` +
        `database binding, so \`${operation}\` was refused. Nothing was read ` +
        `and nothing was written. This is deliberate and temporary — a ` +
        `database binding is being moved.`,
    );
    this.name = 'D1MaintenanceError';
    this.worker = worker;
    this.operation = operation;
  }
}

/**
 * Whether an error is this module's refusal.
 *
 * Deliberately structural. See `D1_MAINTENANCE_CODE` for why `instanceof` is
 * not used.
 */
export function isD1MaintenanceError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === D1_MAINTENANCE_CODE
  );
}

/** Whether a D1 binding is present at all — the one question the entry points ask. */
export function hasD1Binding(binding: unknown): boolean {
  return typeof binding === 'object' && binding !== null;
}

/**
 * A stand-in for `D1Database` whose every database operation refuses by name.
 *
 * The rule, stated once so there is no list to keep current:
 *
 * - **Symbols** pass through to the target. Anything reading
 *   `Symbol.toStringTag`, an iterator or a private marker sees an ordinary
 *   object rather than a thrown error. (`apps/indexer`'s subrequest meter
 *   reads a `Symbol.for` marker on the binding before wrapping it, and must
 *   not blow up doing so.)
 * - **`then` is `undefined`**, so the stub is not accidentally thenable. A
 *   throwing `then` would make `await db` hang or reject somewhere unrelated
 *   to the call that deserved the error.
 * - **Anything already on the target** — which is `Object.prototype` plus the
 *   two describers below — behaves normally. `toString`, `valueOf`,
 *   `hasOwnProperty` and friends are the JavaScript object protocol, not
 *   database operations, and code that logs or inspects the value should get
 *   a sentence rather than an exception.
 * - **Everything else** is treated as a database operation and returns a
 *   function that throws. `prepare`, `batch`, `exec`, `dump`, `withSession`
 *   and whatever D1 gains next are all covered by that one clause.
 */
export function maintenanceD1Stub(worker: string): unknown {
  const target = {
    toString: () =>
      `[D1 unavailable — ${worker} is running a maintenance build]`,
    toJSON: () => ({ d1: 'unavailable', worker, reason: 'maintenance build' }),
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver);
      if (prop === 'then') return undefined;
      if (prop in t) return Reflect.get(t, prop, receiver);
      return () => {
        throw new D1MaintenanceError(worker, prop);
      };
    },
  });
}

/** Workers already told about, so the disclosure below is once per isolate. */
const disclosed = new Set<string>();

/**
 * The env seam: hand it the raw binding, get back something safe to hand
 * downstream.
 *
 * A present binding is returned untouched — this is a no-op on every ordinary
 * deployment, and the stub only exists on a maintenance build.
 *
 * The absence is disclosed ONCE per isolate rather than per call. A maintenance
 * build refuses every request and every cron tick, so a line per refusal is the
 * log flood that turns a deliberate state into noise; a line per isolate is
 * enough for an operator to confirm from the logs that the build they deployed
 * is the one running.
 *
 * `worker` is a label for the log line and the error text — use the deployed
 * Worker's name, so an operator reading a refusal knows which deployment to
 * look at.
 */
export function resolveD1Binding<T>(binding: T | undefined | null, worker: string): T {
  if (hasD1Binding(binding)) return binding as T;
  if (!disclosed.has(worker)) {
    disclosed.add(worker);
    // eslint-disable-next-line no-console
    console.warn(
      `[d1] ${worker} has NO D1 binding — running as a maintenance build. ` +
        `Every database operation will be refused, and no read or write can ` +
        `reach any database from this isolate. If this is not a maintenance ` +
        `window, the deployed wrangler config is missing its d1_databases ` +
        `entry.`,
    );
  }
  return maintenanceD1Stub(worker) as T;
}

/**
 * The one line a background lane logs when it declines to start.
 *
 * `fetch` has a caller to answer, so it gets `maintenanceRefusal` below. A
 * cron tick and a Durable Object alarm have nobody to answer, so all they can
 * do is say — once, in the log the operator is already tailing — that they
 * stopped and that stopping wrote nothing. Declining at the entry point rather
 * than letting each pass discover the refusal for itself is the difference
 * between one legible line and a dozen stack traces per tick.
 *
 * `lane` is what did not run, in the operator's words: `this tick`,
 * `the ingest alarm`.
 */
export function maintenanceSkipNotice(worker: string, lane: string): string {
  return (
    `[d1] ${worker}: ${lane} did NOT run — this is a maintenance build with ` +
    `no D1 binding. Nothing was read and nothing was written. Work resumes ` +
    `on the next tick after a build with a binding is deployed.`
  );
}

/**
 * The parts of the one HTTP answer a maintenance build gives.
 *
 * Returned as data rather than a `Response` so this module stays free of
 * runtime globals; each Worker does `new Response(body, rest)`.
 *
 * **Retry-After is a real number, not a guess dressed as one.** It is the
 * caller-facing promise that retrying is the right move and roughly when — it
 * is not a claim about how long the cutover takes. A caller that retries early
 * gets another 503 and the same header, which is the correct behaviour for a
 * window whose length the Worker cannot know.
 */
export function maintenanceRefusal(worker: string): {
  body: string;
  status: number;
  headers: Record<string, string>;
} {
  return {
    body:
      `${worker} is temporarily unavailable: a database binding is being ` +
      `moved. No request is being served against a database right now, so ` +
      `nothing you sent has been recorded and nothing you read here would be ` +
      `current. Retry shortly.\n`,
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': '120',
      'cache-control': 'no-store',
    },
  };
}
