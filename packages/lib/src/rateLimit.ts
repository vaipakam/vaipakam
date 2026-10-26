/**
 * The one rate-limit rule for every Worker in this repository (#2755,
 * #2756).
 *
 * Every limiter is a Cloudflare rate-limit binding declared in the
 * Worker's `wrangler.jsonc`. Each route used to carry its own copy of the
 * check, and the copies disagreed: some let a request through when the
 * binding was missing, some when it threw, one refused on a throw. A
 * limiter that opens when it cannot count is not a limit.
 *
 * So one rule, read here and nowhere else: a slot is TAKEN only when the
 * binding exists and answered yes. A missing binding is a deployment that
 * does not match its own configuration, and a binding that throws cannot
 * say whether the caller is over; both refuse, each with its own name so
 * the answer says which it was. Each Worker's tests pin that its
 * `wrangler.jsonc` declares every binding it reads and that no source
 * file calls a limiter, or names a limiter failure, outside this module.
 *
 * Budgets are keyed two ways:
 *   - a CALLER budget, keyed by the client IP ({@link takeCallerSlot}),
 *     taken once before the route does any work;
 *   - a budget on a shared resource, keyed by a constant (the agent's
 *     per-API-key credential budgets), taken once per use.
 *
 * What these bindings do not do, stated: Cloudflare counts each rate-limit
 * namespace per Cloudflare location, not across the whole network, and
 * the count is eventually consistent, so a burst can run a little past the
 * limit before the location's count catches up. A budget therefore bounds
 * what callers reaching one location can spend; callers spread across many
 * locations can each spend that much. It is a bound, not an exact global
 * meter (that would need a Durable Object).
 */

/** A Cloudflare built-in rate-limit binding. */
export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

/** What asking a limiter for one slot came to. */
export type SlotOutcome =
  /** The binding answered yes; the caller may proceed. */
  | 'taken'
  /** The binding answered no: the budget is spent for now. */
  | 'refused'
  /** No binding: this deployment does not carry the limiter it declares. */
  | 'unconfigured'
  /** The binding threw, so whether the budget is spent is unknown. */
  | 'unavailable';

/** Ask `binding` for one slot under `key`. Never throws. */
export async function takeSlot(
  binding: RateLimitBinding | undefined,
  key: string,
): Promise<SlotOutcome> {
  if (!binding) return 'unconfigured';
  try {
    return (await binding.limit({ key })).success ? 'taken' : 'refused';
  } catch (err) {
    console.error('[rate-limit] binding threw; refusing the request', err);
    return 'unavailable';
  }
}

/** The caller budget's key: the client IP Cloudflare resolved. A request
 *  without one shares a single bucket rather than escaping the limit. */
export function callerKey(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Take one caller slot for `req`. */
export function takeCallerSlot(
  req: Request,
  binding: RateLimitBinding | undefined,
): Promise<SlotOutcome> {
  return takeSlot(binding, callerKey(req));
}

/**
 * The status and error name for a slot that was not taken, or `null` when
 * it was: the one mapping every refusal uses, so a caller that reports a
 * refusal inside a larger answer (the agent's OpenSea offers walk) names it
 * the same way a whole-route refusal does.
 *
 * `refused` is 429: the caller may try again later. `unconfigured` and
 * `unavailable` are 503 with their own names, because nothing the caller
 * does changes them and the operator needs to know which it is. Neither
 * name may end in `-not-configured`: the app reads a 503 with that suffix
 * from the agent's quote proxy as "this deployment holds no key for the
 * venue" (`apps/app/src/data/closeOutRoute.ts`), which a missing limiter is
 * not.
 */
export function slotRefusalStatus(
  outcome: SlotOutcome,
  refusedError = 'rate-limited',
): { status: 429 | 503; error: string } | null {
  if (outcome === 'taken') return null;
  if (outcome === 'refused') return { status: 429, error: refusedError };
  return {
    status: 503,
    error: outcome === 'unconfigured' ? 'rate-limit-binding-missing' : 'rate-limit-unavailable',
  };
}
