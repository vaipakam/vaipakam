/**
 * The browser origins a Worker serves app-only routes to (#2756).
 *
 * The list is a Worker var, `FRONTEND_ORIGIN`: a comma-separated list of
 * exact origins. The agent gates its app-facing routes on it, and the
 * indexer gates its WebSocket push channel on the same list, so both read
 * it here. An absent var is an empty list (nothing matches); empty entries
 * are dropped, so a trailing comma cannot make an empty `Origin` match.
 *
 * What an Origin check is, stated: it stops another site's page from
 * using the route through a visitor's browser. It does not stop a script,
 * which can send any `Origin` header, so it is never authentication and a
 * route behind it still needs its own bound.
 */

/** The configured origins, in order. */
export function parseOriginList(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether `origin` is exactly one of the configured origins. */
export function isListedOrigin(origin: string | null | undefined, csv: string | undefined): boolean {
  return !!origin && parseOriginList(csv).includes(origin);
}
