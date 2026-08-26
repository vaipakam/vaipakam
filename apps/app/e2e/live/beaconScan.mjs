/**
 * The injected-analytics-beacon scan for `live-ux-sweep.mjs` (#1826).
 *
 * Extracted so it can be unit-tested, for the same reason `redact.mjs`
 * was. The first revision of this traversal read `report.passes[].console`
 * — a level that does not exist; console entries live at
 * `report.passes[].routes[].console`. It would have found nothing,
 * printed nothing and exited 0 on every run: a privacy verdict silently
 * turned into a no-op, which looks exactly like a clean deployment
 * (Codex #1859 r3 P2). A wrong level or a renamed field is a test
 * failure here rather than a permanently green sweep.
 *
 * TWO states, and each is invisible to the other's signal:
 *
 *   REFUSED   The zone injects the beacon and the site's CSP refuses it.
 *             A console error is logged, the request is attempted and
 *             then failed with `errorText: 'csp'`, and no response ever
 *             arrives. Today's state on app. Wrong configuration,
 *             but nothing is sent.
 *
 *   PERMITTED The beacon loads and answers 200. There is NO console
 *             error at all, so the refusal signal goes quiet in the one
 *             case that matters most — a CSP that is missing, stale, or
 *             widened to admit this host. Strictly worse than REFUSED:
 *             a collector nobody consented to is actually running.
 *
 * The PERMITTED signal is a RESPONSE, never a request. Measured against
 * the deployed site: under the live CSP the beacon's request event still
 * fires before the block, so keying on requests would report today's
 * correctly-refused deployment as running the collector — a false
 * accusation of the worse defect, inside a check whose purpose is to
 * report this one honestly. With `bypassCSP` the same request answers
 * 200, and only then.
 *
 * Both states fail the sweep, and both are reported once per RUN rather
 * than per route: this is a property of the deployment — every page sees
 * it — so an occurrence count would describe the length of the route
 * list rather than the defect.
 */

/** The origin Cloudflare's Web Analytics beacon is served from. */
export const BEACON_ORIGIN = 'https://static.cloudflareinsights.com';

/**
 * Is this URL on the beacon's origin?
 *
 * Compares the PARSED origin — never a substring or an un-anchored
 * regex, so `static.cloudflareinsights.com.evil.tld` cannot match. Same
 * shape as the #1145 CodeQL fix (`js/regex/missing-regexp-anchor`).
 */
export function isBeaconUrl(url) {
  try {
    return new URL(url).origin === BEACON_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Tag a console message that is the CSP refusing the beacon.
 *
 * Extracts the first URL token and tests its origin, because the URL
 * sits mid-message and so cannot be `^`-anchored.
 */
export function isBeaconRefusalMessage(text) {
  const urlToken = String(text).match(/https?:\/\/[^\s'"]+/);
  return urlToken !== null && isBeaconUrl(urlToken[0]);
}

/**
 * Reduce a finished sweep report to the beacon verdict.
 *
 * @param report            the sweep's own report object
 * @param backgroundBeacon  beacon responses that arrived while no route
 *                          sink was active (between routes, during
 *                          connect). They belong to no route but still
 *                          prove the injection is live and permitted,
 *                          so they must not be dropped for want of an
 *                          owner.
 * @returns `{ refusedRoutes, permittedRequests, failed }` — `failed` is
 *          true if EITHER state was seen.
 */
export function scanBeacon(report, backgroundBeacon = []) {
  const refused = new Set();
  const permitted = [...backgroundBeacon];
  for (const pass of report?.passes ?? []) {
    for (const route of pass?.routes ?? []) {
      // `?? []` on every level on purpose: a probe-only run, a route
      // that threw before its sink was populated, and an older report
      // all legitimately omit these keys. Throwing on a missing key
      // would turn a partial report into a crash; treating it as
      // "nothing seen" is correct, because nothing was.
      if ((route?.console ?? []).some((c) => c?.noise === 'csp-beacon')) {
        refused.add(route.route);
      }
      for (const entry of route?.beacon ?? []) {
        permitted.push(`${route?.route}: ${entry}`);
      }
    }
  }
  return {
    refusedRoutes: [...refused],
    permittedRequests: permitted,
    failed: refused.size > 0 || permitted.length > 0,
  };
}
