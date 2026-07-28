/**
 * Bearer authentication for the manual `POST /run` trigger.
 *
 * Its own module so it is directly unit-testable — this is the only
 * security boundary in the Worker, and a boundary that is awkward to test
 * is a boundary that goes untested.
 *
 * **Fail-closed.** A `workers.dev` URL is public, and a tick is not a
 * read-only probe: it performs the whole RPC fan-out, advances the D1
 * streak counters, and sends Telegram. An unauthenticated caller could
 * drain the dedicated RPC quota, or fire enough rapid requests while
 * ordinary commitments were outstanding to manufacture a
 * `stuck-settlement` advisory that is supposed to represent an hour and a
 * half of cron observations — forging the very evidence the operator acts
 * on (Codex #1443 r1). So an unset token CLOSES the endpoint; treating
 * "unset" as "open" is how a public trigger ships by accident.
 */

import type { Env } from './env';

const SCHEME = 'bearer ';

/**
 * Constant-time-ish secret comparison.
 *
 * Compares every character regardless of where the first difference is,
 * so the duration carries no information about the matching prefix. The
 * length check that precedes it is deliberate and unavoidable — a
 * mismatched length cannot be compared position-by-position — and length
 * alone is far weaker information than a prefix oracle.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Extract a bearer token, or `''` when the header is absent or malformed.
 *
 * The scheme is matched case-insensitively per RFC 7235.
 */
export function bearerToken(header: string | null): string {
  if (!header) return '';
  const trimmed = header.trim();
  if (!trimmed.slice(0, SCHEME.length).toLowerCase().startsWith(SCHEME)) {
    return '';
  }
  return trimmed.slice(SCHEME.length).trim();
}

/**
 * Whether this request may run a tick.
 *
 * @returns `false` when no token is configured, when none is presented,
 *          or when they differ.
 */
export function isAuthorized(request: Request, env: Env): boolean {
  const expected =
    typeof env.WATCHER_RUN_TOKEN === 'string' ? env.WATCHER_RUN_TOKEN : '';
  if (expected.length === 0) return false;
  const presented = bearerToken(request.headers.get('authorization'));
  if (presented.length === 0) return false;
  return secretsMatch(presented, expected);
}
