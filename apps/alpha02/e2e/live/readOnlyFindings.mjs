// Classifying what the read-only route guard blocked.
//
// A blocked request usually IS a finding: the page attempted a signing
// RPC or a backend write during a review that claims to be read-only.
// Exactly one class is not — Cloudflare's edge injects a
// `POST /cdn-cgi/rum` telemetry beacon into the deployed site, which
// the guard blocks correctly and which says nothing about the
// application.
//
// Shared rather than copied. This predicate took four review rounds to
// get right (#1576 r2-r4) and every one of those rounds narrowed it;
// a second copy would start from the finished shape and then drift on
// its own, which is how one of two identical guards ends up weaker
// than the other (#1590 r4).
//
//   import { splitBlocked } from './readOnlyFindings.mjs';
//   const { telemetry, violations } = splitBlocked(blockedRequests, [SITE]);

/**
 * @param {string[]} origins - the origins this drive actually visits.
 *   Passed in rather than read from a global so a drive pointed at a
 *   preview exempts that preview's beacon and nothing else.
 */
export function makeIsCloudflareBeacon(origins) {
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  return function isCloudflareBeacon({ reason, url: rawUrl }) {
    // The REASON has to match too, not just the URL. `readOnlyViolation`
    // classifies by content: a JSON-RPC body carrying a write method is
    // recorded as `json-rpc eth_sendTransaction`, whatever URL it was
    // posted to. A URL-only filter would therefore have exempted a
    // signing or broadcast attempt aimed at the beacon path — the
    // single worst thing this check exists to catch (Codex #1576 r2).
    //
    // POST specifically, not any method. The documented beacon is a
    // POST; a PUT/PATCH/DELETE to the same path is an anomaly, and
    // accepting the generic shape would have filed it as expected
    // telemetry — contradicting the claim that everything else stays
    // fatal (Codex #1576 r3). Every `json-rpc *` and `wallet rpc *`
    // reason falls through and stays fatal too, as does any reason
    // shape this doesn't recognise: unknown means fatal, the safe
    // direction for a guard.
    if (reason !== 'POST (non-RPC mutating request)') return false;
    try {
      const url = new URL(rawUrl);
      // ORIGIN, not hostname: `hostname` ignores both scheme and port,
      // so `http://alpha02.vaipakam.com/cdn-cgi/rum` (cleartext) and
      // `https://vaipakam.com:8443/cdn-cgi/rum` (odd port) matched a
      // hostname test while being nothing Cloudflare's edge would emit
      // (Codex #1576 r4).
      //
      // The HTTPS check is kept even though every allowed origin is
      // already HTTPS today: it makes "never exempt a cleartext write"
      // a property of this function rather than of how SITE_URL
      // happens to be set.
      return (
        url.protocol === 'https:' &&
        allowed.has(url.origin) &&
        url.pathname === '/cdn-cgi/rum'
      );
    } catch {
      return false;
    }
  };
}

/**
 * Split a `blockedRequests` log into expected edge telemetry and real
 * findings.
 *
 * @returns {{ telemetry: object[], violations: object[] }}
 */
export function splitBlocked(blockedRequests, origins) {
  const isBeacon = makeIsCloudflareBeacon(origins);
  return {
    telemetry: blockedRequests.filter((b) => isBeacon(b)),
    violations: blockedRequests.filter((b) => !isBeacon(b)),
  };
}
