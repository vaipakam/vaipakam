/**
 * The invocation's outbound-request allowance, counted rather than asserted
 * (#2221).
 *
 * A Cloudflare Worker invocation is bounded at 50 outbound subrequests on the
 * tier this repository sizes against, and A BINDING CALL IS ONE OF THEM.
 * Going over does not degrade a chain pass — it aborts before the scan cursor
 * is recorded, so the next tick re-reads the same range and the chain never
 * advances. A frozen chain is the failure this module exists to make
 * impossible.
 *
 * ── WHAT IS COUNTED, AND WHERE ──
 *
 * Two rules, which between them have no gap:
 *
 *   1. **Bindings are counted at the binding.** D1 goes out over a binding,
 *      not over `fetch`, so `meterD1` wraps the handle itself. Secrets Store
 *      reads are counted the same way, at `readSecret`.
 *   2. **HTTP is counted at egress.** Everything else a Worker sends leaves
 *      through `fetch`, so `meterFetch` wraps the function that sends it —
 *      not the objects that happen to call it.
 *
 * Rule 2 is the correction #2227 r1 forced, and the distinction is not
 * pedantic. The first version of this module wrapped a viem client's METHODS
 * and called the result an egress count. It was not one: viem retries a failed
 * request up to three more times UNDER one method call, a second client
 * constructed anywhere else was invisible, and a plain `fetch()` to OpenSea
 * went uncounted entirely. Counting the objects that were remembered is the
 * same defect as counting by hand, arrived at through a Proxy.
 *
 * ── WHY A WRAPPER AND NOT A DECREMENT AT EVERY CALL SITE ──
 *
 * The agent's pre-notify lane got a counter in #2213 r27 and spends it by hand:
 * `budget.remaining -= 1` next to each request, at about fifteen sites. That is
 * sound THERE, because fifteen sites can be read in one sitting and a reviewer
 * can see the set is complete.
 *
 * This lane has more than a hundred. Hand-decorating them would reproduce, in
 * new form, the exact defect #2221 was filed for: a hand-maintained enumeration
 * of consumers that nothing verifies, which a later call site escapes silently.
 * That is how the budget note in `chainIndexer.ts` came to assert three
 * different worst cases in three consecutive review rounds and be wrong every
 * time — r29 said 50 and it was 51, r30 said 48 and it was at least 57. Every
 * correction came from a person re-reading the sum, because nothing in the
 * system knew the number.
 *
 * ── WHERE THE D1 COST ACTUALLY IS ──
 *
 * At the TERMINAL, not at `prepare()`. This lane has 204 `prepare()` calls and
 * 85 terminals, and the gap is not waste: a prepared statement is frequently
 * bound and handed to `batch()`, which sends the whole array as ONE subrequest.
 * Counting `prepare()` would therefore charge for statements that never travel
 * on their own and would overcount a batch by its length — turning an honest
 * counter into a differently-wrong number, which is no better than the prose it
 * replaces.
 *
 * Charged, each one request:
 *   - `.run()`, `.all()`, `.first()`, `.raw()` on a prepared statement
 *   - `.batch([...])`, once, whatever the array length
 *   - `.exec(...)`
 *   - one `fetch` — each ATTEMPT, so a retried RPC read costs what it cost
 *   - one Secrets Store read
 *
 * Not charged: `prepare()` and `bind()`, which build a statement locally and
 * send nothing.
 *
 * ── WHAT IS STILL NOT COUNTED ──
 *
 * Stated because an uncounted request is worse when nobody said so. The
 * read-API `fetch()` handler lane (`signedOfferRoutes`, `recycleRoutes`'s HTTP
 * routes) is a DIFFERENT invocation with its own ceiling and is deliberately
 * outside this counter; it is not shared with the cron tick. Within the cron
 * tick, every pass draws on the ONE budget the entry point creates, which is
 * why the figure reported is the invocation's and not any single pass's.
 */

import { createPublicClient, http } from 'viem';

/**
 * One ceiling, and what is left of it.
 *
 * Each meter carries its own `limit` (#2227 r1 `4033546291`): a budget created
 * with a limit and a reader that assumed the default reported a figure neither
 * true nor obviously false — 45 spent on a 5-limit budget that had issued 5.
 * A meter that knows its own ceiling makes that unsayable.
 */
export interface Meter {
  /** What this counts, for the log line and the warning. */
  readonly what: string;
  readonly limit: number;
  remaining: number;
  /** Internal — so a ceiling is announced exactly once, at the crossing. */
  announced: boolean;
}

/**
 * What the invocation has left. One object, threaded, mutated in place — so no
 * caller has to remember to report its spending upward.
 *
 * TWO METERS, because the platform enforces two ceilings and one number cannot
 * be honest about both (#2227 r4 `4034041832`). A `batch()` of nine statements
 * is ONE subrequest and NINE D1 queries. Counting it as one under-reports the
 * query ceiling — which on the free tier is also 50, so a lane batching freely
 * can be killed with the counter reading comfortable. Counting it as nine
 * over-reports the subrequest ceiling and would refuse work that fits. Both
 * are true at once, so both are kept, and neither is asked to stand in for the
 * other.
 */
export interface TickBudget {
  /** For the log line, so an operator knows WHICH invocation overspent. */
  readonly label: string;
  /** Requests that leave the Worker: `fetch`, and every binding call. */
  readonly subrequests: Meter;
  /** SQL statements submitted to D1, batched or not. */
  readonly d1Queries: Meter;
}

/**
 * The tier ceilings this lane sizes against — both REAL limits, not
 * self-imposed ones, which is why nothing here may quietly exceed either.
 *
 * Cloudflare documents "Subrequests per invocation: 50" (Free) and counts "any
 * request a Worker makes using the Fetch API or to Cloudflare services like
 * R2, KV, or D1", with "each subrequest in a redirect chain" counting too. D1
 * separately documents "Queries per Worker invocation: 1000 (Workers Paid) /
 * 50 (Free)" and says the per-query limits "apply to each individual statement
 * contained within a batch statement".
 *
 * Sized to the FREE tier deliberately. A paid deployment has more room than
 * this counter believes, which costs a tick some work it could have done;
 * believing the paid figure on a free deployment freezes a chain. The
 * direction of the error is chosen, not inherited.
 */
export const MAX_SUBREQUESTS_PER_INVOCATION = 50;
export const MAX_D1_QUERIES_PER_INVOCATION = 50;

/**
 * Held back so a pass can always record where it got to.
 *
 * A pass that spends its last request on work and then cannot write its cursor
 * has done the work AND frozen the chain — strictly worse than doing less work
 * and advancing. The agent lane learned this as `CURSOR_WRITE_RESERVE` in
 * #2213 r32 (`4017648029`); the same rule holds here for the same reason.
 */
export const CURSOR_WRITE_RESERVE = 1;

export function createBudget(
  limit: number = MAX_SUBREQUESTS_PER_INVOCATION,
  label = 'invocation',
  queryLimit: number = MAX_D1_QUERIES_PER_INVOCATION,
): TickBudget {
  return {
    label,
    subrequests: { what: 'subrequest', limit, remaining: limit, announced: false },
    d1Queries: {
      what: 'D1 query',
      limit: queryLimit,
      remaining: queryLimit,
      announced: false,
    },
  };
}

/**
 * Can this unit of work be STARTED?
 *
 * Asked before beginning, never discovered midway: a unit abandoned halfway has
 * already spent the requests that got it there, and on this lane a half-done
 * reconciliation is what leaves rows in the state #2212 exists to remember.
 *
 * `reserve` is what must still be affordable AFTER the work — the cursor write,
 * normally — so the caller expresses "I need n, and I must still be able to
 * record progress" in one question rather than two that can drift apart.
 *
 * SUBREQUESTS, because that is the ceiling a unit of work is sized in here.
 * A caller whose work is D1-statement-heavy asks about that meter directly.
 */
export function canAfford(
  budget: TickBudget,
  cost: number,
  reserve: number = CURSOR_WRITE_RESERVE,
): boolean {
  return budget.subrequests.remaining >= cost + reserve;
}

/**
 * Spend a subrequest, and say whether it was affordable.
 *
 * DELIBERATELY NOT A THROW. This lane's callers are a scan, a reconciliation
 * pass and a reminder sweep, and an exception in any of them unwinds past the
 * cursor write — the frozen chain again, arrived at by the mechanism meant to
 * prevent it. The counter goes negative, the fact is reported, and the caller
 * decides.
 */
export function spend(budget: TickBudget, cost = 1): boolean {
  return draw(budget, budget.subrequests, cost);
}

/**
 * Spend D1 QUERIES — the second ceiling, which a `batch()` draws on by its
 * length while costing only one subrequest.
 *
 * Separate from `spend` rather than folded into it because the ceilings are
 * separate. A single number would have to pick one to be wrong about.
 */
export function spendD1Queries(budget: TickBudget, count: number): boolean {
  return draw(budget, budget.d1Queries, count);
}

/**
 * THE CEILING IS ANNOUNCED HERE, AT THE CROSSING, not at the end of a pass
 * (#2227 r1 `4033546277`). A check that ran after the work could not fire in
 * the case that matters: the platform kills the invocation at the request that
 * passed the ceiling, so the code downstream of it never runs. This announces
 * BEFORE the offending request is issued, which is the last moment anything in
 * this Worker is guaranteed to execute.
 */
function draw(budget: TickBudget, meter: Meter, cost: number): boolean {
  meter.remaining -= cost;
  if (meter.remaining < 0 && !meter.announced) {
    meter.announced = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[subrequests] ${budget.label}: OVER the ${meter.limit}-${meter.what} ` +
        `ceiling — issuing ${meter.what} ${meter.limit - meter.remaining}. ` +
        `The platform may kill this invocation here, in which case the cursor ` +
        `write does not land and this range is re-read next tick. This is ` +
        `#2221: report it with the label and the tick.`,
    );
  }
  return meter.remaining >= 0;
}

/** Has this invocation exceeded EITHER ceiling? */
export function overspent(budget: TickBudget): boolean {
  return budget.subrequests.remaining < 0 || budget.d1Queries.remaining < 0;
}

/** How many subrequests this invocation has issued so far. */
export function spent(budget: TickBudget): number {
  return budget.subrequests.limit - budget.subrequests.remaining;
}

/** How many D1 statements this invocation has submitted so far. */
export function spentD1Queries(budget: TickBudget): number {
  return budget.d1Queries.limit - budget.d1Queries.remaining;
}

/**
 * Say what an invocation has spent, in ONE format, from wherever it exits.
 *
 * Three entry points report this — the chain pass, the cron tick and the
 * ingest DO's alarm — and three hand-written log lines would drift in wording
 * and in which fields they carried, which is the small version of the problem
 * this module exists for. `at` names the exit, because the same counter is
 * legitimately read at more than one moment on one invocation.
 *
 * BOTH meters are in the line. A figure that reported subrequests alone would
 * read as comfortable on an invocation about to be killed for its query count.
 *
 * The key is `invocationSpent`, not `spent`: on the cron path several passes
 * share one counter, so a figure printed beside a chain id is the TICK's total
 * and not that chain's share. A per-pass share would have to be a delta, and
 * deltas are not attributable while the passes run concurrently.
 */
export function reportSpend(budget: TickBudget, at: string): void {
  // eslint-disable-next-line no-console
  console.log(
    `[subrequests] ${JSON.stringify({
      scope: budget.label,
      at,
      invocationSpent: spent(budget),
      limit: budget.subrequests.limit,
      d1QueriesSpent: spentD1Queries(budget),
      d1QueryLimit: budget.d1Queries.limit,
      over: overspent(budget),
    })}`,
  );
}

// ── The wrappers ──────────────────────────────────────────────────────────
//
// The wrapped types are PASS-THROUGH GENERICS rather than a local restatement
// of D1's interface, and that is a deliberate choice rather than laziness.
// Declaring the shape here would mean maintaining a second copy of someone
// else's API — a list that has to be updated whenever `@cloudflare/workers-
// types` gains a method, and that silently stops matching when it is not. That
// is the same enumeration-nobody-verifies failure this whole module exists to
// remove, so it is not reintroduced at the type level to remove it at the
// runtime level.
//
// `Proxy` forwards everything it is not told to charge, so methods this lane
// never calls keep working untouched and typed exactly as their owner declared
// them. The unit tests pass plain objects for the same reason.

type Terminal = 'first' | 'run' | 'all' | 'raw';
const TERMINALS: readonly Terminal[] = ['first', 'run', 'all', 'raw'];

/**
 * Marks an already-metered handle.
 *
 * The cron entry point meters the env once and hands it to every pass; a pass
 * that also meters what it was given would charge each of its D1 calls twice.
 * Making the wrapper idempotent means neither side has to know what the other
 * did — which is the same reason the metering is structural in the first
 * place.
 */
const METERED = Symbol.for('vaipakam.indexer.metered');

function alreadyMetered(target: object): boolean {
  return (target as Record<symbol, unknown>)[METERED] === true;
}

/**
 * Wrap one prepared statement so its terminals are charged and `bind()` is not.
 *
 * `bind()` returns a NEW statement object in the D1 API, so the wrapper has to
 * re-wrap what it returns; forgetting that is how a bound statement — which is
 * most of them here — would slip through uncounted.
 */
function wrapStatement<T extends object>(stmt: T, budget: TickBudget): T {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === METERED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      if (prop === 'bind') {
        return (...args: unknown[]) =>
          wrapStatement(
            (value as (...a: unknown[]) => object).apply(target, args),
            budget,
          );
      }

      if (TERMINALS.includes(prop as Terminal)) {
        return (...args: unknown[]) => {
          // One statement, sent on its own: one subrequest AND one query.
          spend(budget);
          spendD1Queries(budget, 1);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as T;
}

/**
 * Wrap the D1 binding so every call through it is counted.
 *
 * Returned as the same structural type it was given, so call sites are
 * unchanged — the point being that nobody has to know the budget exists for
 * their request to be counted.
 */
export function meterD1<T extends object>(db: T, budget: TickBudget): T {
  if (alreadyMetered(db)) return db;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === METERED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      if (prop === 'prepare') {
        return (sql: string) =>
          wrapStatement(
            (value as (s: string) => object).call(target, sql),
            budget,
          );
      }

      // ONE subrequest for the whole array — it is one round trip — and as
      // many D1 QUERIES as it carries statements. Cloudflare's own limits say
      // both: a batch is one request, and the per-query limits "apply to each
      // individual statement contained within a batch statement" (#2227 r4
      // `4034041832`). Charging one of each would let a batching lane reach
      // the 50-query ceiling with the counter reading comfortable; charging
      // the length to BOTH would refuse work that fits.
      if (prop === 'batch') {
        return (...args: unknown[]) => {
          spend(budget);
          const statements = args[0];
          spendD1Queries(budget, Array.isArray(statements) ? statements.length : 1);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      // `exec` takes one or more statements separated by newlines, so its
      // query cost is the number of non-empty lines. Counted from what was
      // actually submitted rather than assumed to be one.
      if (prop === 'exec') {
        return (...args: unknown[]) => {
          spend(budget);
          spendD1Queries(budget, countExecStatements(args[0]));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as T;
}

/**
 * How many statements a `.exec()` call submits.
 *
 * D1 splits the string on newlines, so that is what is counted — blank lines
 * excluded. An unrecognisable argument counts as one rather than zero: a cost
 * this cannot read is still a cost, and guessing low is the direction that
 * freezes a chain.
 */
function countExecStatements(sql: unknown): number {
  if (typeof sql !== 'string') return 1;
  const statements = sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return Math.max(1, statements.length);
}

/**
 * Count at EGRESS: one charge per outbound HTTP request, whoever issued it and
 * however many times it is attempted.
 *
 * This is the whole of rule 2. A request that reaches the network reaches it
 * through a `fetch` function, so a `fetch` function is where a count can be
 * complete rather than merely thorough. Pass the result wherever a `fetch` is
 * accepted — viem's `fetchFn`, an OpenSea POST, a Durable Object stub — and
 * the caller needs to know nothing about the budget.
 *
 * `base` exists so a non-global sender (a DO stub's `fetch`) is metered by the
 * same primitive rather than by a second mechanism that can drift from it.
 *
 * NOT a swap of `globalThis.fetch`, which would catch even more and would be
 * wrong: a Worker isolate serves concurrent invocations, so a global swap
 * charges one invocation for another's requests and leaves whichever finishes
 * last holding a counter it never spent.
 */
export function meterFetch(
  budget: TickBudget,
  base: typeof fetch = fetch,
): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    // ── THIS LANE DOES NOT FOLLOW REDIRECTS, AND THAT IS THE POINT ──
    //
    // The platform bills every hop of a redirect chain (#2227 r2
    // `4033723749`), so a counter that charges once and lets the runtime chase
    // the rest reports a figure it cannot know is wrong — the confident-but-
    // incorrect number this module exists to retire. There are exactly two
    // ways to be exact: follow the hops yourself and count them, or do not
    // follow.
    //
    // Round 2 took the first. Round 3 returned FOUR findings against it, three
    // of them the same defect in different clothes: a hand-written redirect
    // algorithm diverging from `fetch`'s own — 301/302 rewriting a PUT where
    // the standard rewrites only POST, 303 turning a HEAD into a GET, an
    // `AbortSignal` dropped, a replacement body refused. That class has no
    // bottom. Matching a standard algorithm by hand is a commitment to keep
    // matching it, and every round would have found the next clause.
    //
    // So the re-implementation is gone. `redirect: 'manual'` on the Workers
    // runtime returns the real 3xx with its `Location` and follows nothing, so
    // ONE request is issued and ONE is counted — exact, with no second
    // implementation of anybody's spec to keep in step. Everything else passes
    // through to the sender untouched: method, headers, body, signal, and a
    // `Request` input handled by the runtime that defines what a `Request`
    // means.
    //
    // WHAT THIS COSTS, said plainly: an endpoint that answers with a redirect
    // is no longer chased. The caller receives the 3xx and fails. On this lane
    // that is the right failure — the peers are a configured RPC URL, a
    // marketplace API and a Durable Object, none of which should redirect, and
    // if one starts the fix is the configured URL rather than an indexer
    // quietly following a provider somewhere new. The warning below names the
    // destination so that fix is one log line away, and this is a deliberate
    // behaviour change rather than a gap: see the PR.
    const response = await (() => {
      spend(budget);
      return base(input, {
        ...((init ?? {}) as RequestInit),
        redirect: 'manual',
      });
    })();

    if (REDIRECT_STATUSES.has(response.status)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[subrequests] ${budget.label}: ${response.status} redirect NOT ` +
          `followed, to ${safeDestination(response.headers.get('location'))}. ` +
          `This lane does not chase redirects — the caller sees the 3xx. If ` +
          `this is a provider that has moved, update the configured URL.`,
      );
    }
    return response;
  }) as typeof fetch;
}

/**
 * A redirect destination an operator can act on, WITHOUT its credentials.
 *
 * The `RPC_*` secrets carry billable API keys, normally in the path (#2227 r4
 * `4034041828`), and a `Location` can echo them straight back — so the origin
 * is printed and everything after it is not. That is enough to act on: it
 * names the host the provider is sending traffic to, which is the fact that
 * decides whether the configured URL should change.
 *
 * The same rule and the same reason are already recorded in `settledHead.ts`,
 * where viem's error text was refused for putting a request URL in a log.
 */
function safeDestination(location: string | null): string {
  if (!location) return '(no Location)';
  try {
    const url = new URL(location);
    // Never the userinfo, never the path, never the query.
    return `${url.protocol}//${url.host}/… (path and query withheld)`;
  } catch {
    // A relative Location resolves against a URL that itself carries the key,
    // so not even the fragment of it that was sent back is printed.
    return '(a relative Location, withheld)';
  }
}

/** Redirects a `fetch` would have followed. 304 is deliberately absent — it is
 *  a cache response, not a hop. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Meter a whole invocation in one move: the D1 binding AND the HTTP sender,
 * on the object every pass already carries.
 *
 * This is what makes the counting structural rather than thorough. A pass
 * takes `env`, so a pass takes both counted handles; a helper five calls deep
 * that reaches OpenSea writes `env.fetchFn ?? fetch` and is counted without
 * being told about any of this. The alternative — a `fetchFn` parameter
 * threaded from the entry point to each sender — is a hand-maintained path
 * that the next helper does not join.
 *
 * Idempotent through `meterD1`, so metering at the entry point and again
 * inside a pass counts each request once.
 */
export function meterEnv<T extends { DB: object }>(
  env: T,
  budget: TickBudget,
): T & { fetchFn: typeof fetch } {
  return {
    ...env,
    DB: meterD1(env.DB, budget),
    fetchFn: meterFetch(budget),
  };
}

/**
 * Build a chain client that sends through `send`.
 *
 * Pass `env.fetchFn` and every read the client makes is counted — INCLUDING
 * viem's retries, which are extra HTTP attempts underneath one method call and
 * which #2227 r1 (`4033546264`) found uncounted. Pass nothing and it uses the
 * global `fetch` and is not counted, which is right for the read-API lane.
 *
 * One factory, so a second client built somewhere else cannot quietly escape
 * the count the way `_runLoanReconcilePass`'s did (`4033546268`). The cron
 * module does not import viem's constructor at all, and
 * `test/meteredEgress.test.ts` holds it to that.
 */
export function createChainClient(
  rpcUrl: string,
  send: typeof fetch = fetch,
  transportOptions: { retryCount?: number; timeout?: number } = {},
) {
  return createPublicClient({
    transport: http(rpcUrl, { ...transportOptions, fetchFn: send }),
  });
}
