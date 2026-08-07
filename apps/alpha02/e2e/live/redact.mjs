/**
 * URL redaction for live-drive output.
 *
 * Extracted from `live-position-observe.mjs` so it can be unit-tested:
 * this function is the only thing between an operator's provider key and
 * a public PR thread, and the live-review workflow says to paste a
 * drive's output into that thread. Round 19 shipped it verified by a
 * throwaway script; round 20 found three key shapes it let through, which
 * is precisely what a committed regression test prevents (#1529).
 */

/** Alchemy (32 alphanumeric), Infura/Ankr/QuickNode (hex runs). */
export const OPAQUE_SEGMENT = /^[A-Za-z0-9]{24,}$/;
/** Blast, Chainstack and friends key on a hyphenated UUID. */
export const UUID_SEGMENT = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
/** Short hex keys — under OPAQUE_SEGMENT's 24-char floor. */
export const HEXISH_SEGMENT = /^[0-9a-fA-F]{12,}$/;

/** Does this path segment look like it could carry a secret? */
export const isSecretish = (s) =>
  OPAQUE_SEGMENT.test(s) || UUID_SEGMENT.test(s) || HEXISH_SEGMENT.test(s);

/**
 * A URL safe to PRINT.
 *
 * `rpcOrigin` decides the important case, not the shape of the path.
 * Round 19's first version masked only segments that LOOKED like keys —
 * 24+ characters, no hyphen — which is a denylist wearing an allowlist's
 * clothes: every key shape it failed to anticipate printed in full.
 * Measured against real endpoints, three got through:
 *
 *   Blast       /12345678-9abc-def0-1234-56789abcdef0   UUID, hyphenated
 *   Chainstack  /a1b2c3d4-e5f6-7890-abcd-ef1234567890   UUID, hyphenated
 *   short key   /k/ab12cd34ef56                         under 24 chars
 *
 * A secret must fail CLOSED, so the host we know carries one is handled
 * categorically: any URL on the RPC's origin prints as its origin, path
 * discarded unread, whatever shape the key takes. Nothing to keep
 * current, and a provider we have never heard of is covered on the day
 * it is configured.
 *
 * Other hosts (the site, its CDN) keep a legible path — that is what
 * makes route-failure output useful — with the shape heuristics above
 * retained as second-line defence. Basic auth and query VALUES are
 * always masked; query names are useful and never secret.
 */
export function redactUrl(raw, rpcOrigin = null) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    // The one host we KNOW may carry a credential: never print its path.
    if (rpcOrigin && u.origin === rpcOrigin) return `${u.origin}/***`;
    u.pathname = u.pathname
      .split('/')
      .map((s) => (isSecretish(s) ? '***' : s))
      .join('/');
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    // Never fall back to the raw string: unparseable is exactly when a
    // credential is most likely to survive a naive redaction.
    return '(unparseable url)';
  }
}
