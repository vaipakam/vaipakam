/**
 * The invocation's outbound-request allowance, counted rather than asserted
 * (#2221).
 *
 * A Cloudflare Worker invocation is bounded at 50 outbound subrequests on the
 * tier this repository sizes against, and A D1 BINDING CALL IS ONE OF THEM.
 * Going over does not degrade a chain pass — it aborts before the scan cursor
 * is recorded, so the next tick re-reads the same range and the chain never
 * advances. A frozen chain is the failure this module exists to make
 * impossible.
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
 * So the counting is STRUCTURAL here: the D1 binding is wrapped once, and every
 * call through it is counted wherever it lives and whenever it is added. A
 * request that nobody remembered to account for is not possible, rather than
 * merely not present today.
 *
 * ── WHERE THE COST ACTUALLY IS ──
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
 *
 * Not charged: `prepare()` and `bind()`, which build a statement locally and
 * send nothing.
 */

/**
 * What the invocation has left. One object, threaded, mutated in place — so no
 * caller has to remember to report its spending upward.
 */
export interface TickBudget {
  remaining: number;
}

/**
 * The tier ceiling this lane sizes against.
 *
 * It is the REAL limit, not a self-imposed one, which is why nothing here may
 * quietly exceed it.
 */
export const MAX_SUBREQUESTS_PER_INVOCATION = 50;

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
): TickBudget {
  return { remaining: limit };
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
 */
export function canAfford(
  budget: TickBudget,
  cost: number,
  reserve: number = CURSOR_WRITE_RESERVE,
): boolean {
  return budget.remaining >= cost + reserve;
}

/**
 * Spend, and say whether it was affordable.
 *
 * DELIBERATELY NOT A THROW. This lane's callers are a scan, a reconciliation
 * pass and a reminder sweep, and an exception in any of them unwinds past the
 * cursor write — the frozen chain again, arrived at by the mechanism meant to
 * prevent it. The counter goes negative, the fact is reported, and the caller
 * decides; `overspent()` is how a pass notices at a boundary it chose.
 */
export function spend(budget: TickBudget, cost = 1): boolean {
  budget.remaining -= cost;
  return budget.remaining >= 0;
}

/** Has this invocation already exceeded the real ceiling? */
export function overspent(budget: TickBudget): boolean {
  return budget.remaining < 0;
}

/** How many requests this invocation has issued so far. */
export function spent(
  budget: TickBudget,
  limit: number = MAX_SUBREQUESTS_PER_INVOCATION,
): number {
  return limit - budget.remaining;
}

// ── The D1 wrapper ────────────────────────────────────────────────────────
//
// Only the surface this lane actually uses is wrapped, and the types are
// structural rather than imported from `@cloudflare/workers-types`, so the unit
// tests can pass a plain object. Anything the lane does not call is passed
// through untouched by `Proxy`, which keeps this from becoming a second
// enumeration to maintain — the failure mode being fixed.

type Terminal = 'first' | 'run' | 'all' | 'raw';
const TERMINALS: readonly Terminal[] = ['first', 'run', 'all', 'raw'];

interface StatementLike {
  bind?: (...args: unknown[]) => StatementLike;
  first?: (...args: unknown[]) => Promise<unknown>;
  run?: (...args: unknown[]) => Promise<unknown>;
  all?: (...args: unknown[]) => Promise<unknown>;
  raw?: (...args: unknown[]) => Promise<unknown>;
}

interface DbLike {
  prepare: (sql: string) => StatementLike;
  batch?: (statements: unknown[]) => Promise<unknown>;
  exec?: (sql: string) => Promise<unknown>;
}

/**
 * Wrap one prepared statement so its terminals are charged and `bind()` is not.
 *
 * `bind()` returns a NEW statement object in the D1 API, so the wrapper has to
 * re-wrap what it returns; forgetting that is how a bound statement — which is
 * most of them here — would slip through uncounted.
 */
function wrapStatement(stmt: StatementLike, budget: TickBudget): StatementLike {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      if (prop === 'bind') {
        return (...args: unknown[]) =>
          wrapStatement(
            (value as (...a: unknown[]) => StatementLike).apply(target, args),
            budget,
          );
      }

      if (TERMINALS.includes(prop as Terminal)) {
        return (...args: unknown[]) => {
          spend(budget);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/**
 * Wrap the D1 binding so every call through it is counted.
 *
 * Returned as the same structural type it was given, so call sites are
 * unchanged — the point being that nobody has to know the budget exists for
 * their request to be counted.
 */
export function meterD1<T extends DbLike>(db: T, budget: TickBudget): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      if (prop === 'prepare') {
        return (sql: string) =>
          wrapStatement(
            (value as (s: string) => StatementLike).call(target, sql),
            budget,
          );
      }

      // ONE request for the whole array. Charging per statement would make the
      // counter overstate a batch badly enough to refuse work that fits.
      if (prop === 'batch' || prop === 'exec') {
        return (...args: unknown[]) => {
          spend(budget);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }

      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as T;
}

/**
 * Wrap a viem-style chain client so its reads are counted too.
 *
 * Every method is charged one request, because on this client every method that
 * exists IS a network round trip; there is no local-only method to exempt, and
 * guessing at a list of exemptions would be the enumeration problem again.
 */
export function meterRpc<T extends object>(client: T, budget: TickBudget): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        spend(budget);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as T;
}
