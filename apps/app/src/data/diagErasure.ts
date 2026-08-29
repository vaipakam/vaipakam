/**
 * Signed erasure of server-side error-diagnostics records (#2002) —
 * the client half of the agent's T-075 service.
 *
 * The Privacy Policy promises, as a statement of legal right, that a
 * user can have the error-diagnostics records associated with their
 * wallet erased "by signing an erasure request with that wallet in
 * the app". The service has existed since T-075
 * (`apps/agent/src/diagErasure.ts`); this module is the missing
 * client. Ownership is proven by an EIP-191 `personal_sign` over the
 * canonical message in `@vaipakam/lib/erasureMessage` — ONE builder,
 * imported by both sides, because the Worker reconstructs the exact
 * bytes to recover the signer and a drifted character rejects every
 * request. No gas, no transaction.
 *
 * THE RESPONSES DO NOT BRANCH, AND NEITHER MAY THIS CLIENT. The
 * erasure endpoint returns the same uniform `processed` whether it
 * deleted a hundred rows, deleted none, or skipped everything under
 * a (possibly gagged) legal hold — deliberately, so the response
 * cannot tip a user off that their records are under a retention
 * order. This module surfaces exactly the distinctions the service
 * chose to make and no others: `processed`, the explicitly-disclosed
 * `retained_by_law` (status endpoint only, operator-enabled), the
 * service being unconfigured, and a plain failure. Anything finer —
 * a row count, an "there was nothing to erase" — would reintroduce
 * client-side the signal the service refuses to emit.
 *
 * Fail-closed like `alerts.ts`: with `VITE_AGENT_ORIGIN` unset the
 * card says the control is not available in this build and no
 * request is ever fired.
 */
import {
  ERASURE_SIGNATURE_MAX_AGE_SECONDS,
  buildErasureMessage,
  buildErasureStatusMessage,
} from '@vaipakam/lib/erasureMessage';

const TIMEOUT_MS = 10_000;

/** Validity reserved for the request to actually REACH the Worker
 *  (#2008 round 4 P2): the service checks its own clock only after
 *  receipt, so a signature sent in the window's final seconds can
 *  pass the pre-send check here and still be rejected as stale over
 *  there. Comfortably covers the fetch timeout plus transit. */
const TRANSPORT_MARGIN_SECONDS = 30;

function agentOrigin(): string | null {
  const url = import.meta.env.VITE_AGENT_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

export function diagErasureConfigured(): boolean {
  return agentOrigin() !== null;
}

/** The four outcomes the ERASURE call can honestly report. */
export type DiagErasureOutcome =
  /** The service processed the request — the uniform answer, never a
   *  claim about what (if anything) was deleted. */
  | 'processed'
  /** The service exists but its erasure storage is not configured
   *  (the operator has not set the deletion key) — a config state,
   *  not a retention signal, and worth its own honest message. */
  | 'unavailable'
  /** The wallet prompt was approved AFTER the request's validity
   *  window had already passed (#2008 round 3 P2) — the signature
   *  is stale by the service's own rule, so nothing was sent: the
   *  user is told to try again rather than shown a generic failure
   *  for an approval they gave. */
  | 'expired'
  /** Transport or service failure — the request may not have been
   *  processed; the user should try again. */
  | 'error';

/** The status call adds one more: the operator-disclosed legal
 *  retention note. A gagged or absent hold is indistinguishable from
 *  "processed" BY DESIGN — see the module header. */
export type DiagErasureStatus =
  | { status: 'processed' }
  | { status: 'retained_by_law'; note: string }
  | { status: 'unavailable' }
  | { status: 'expired' }
  | { status: 'error' };

interface SignedPostResult {
  ok: boolean;
  httpStatus: number;
  /** True when the signature outlived the replay window before it
   *  could be sent — see the check in `postSigned`. */
  expired?: boolean;
  /** The parsed JSON body, or null when it was absent/malformed —
   *  parsed HERE, under the same abort deadline as the request
   *  itself (#2008 round 2 P2): headers can arrive within the
   *  timeout while the body stalls forever, and a `res.json()` back
   *  in the caller would then hang with no timer left to cut it. */
  data: Record<string, unknown> | null;
}

async function postSigned(
  path: '/diag/erasure' | '/diag/erasure/status',
  wallet: string,
  signMessage: (message: string) => Promise<string>,
  // Per-operation message (#2008 round 2 P1): the status check signs
  // its OWN frozen words, so the signature a user gave to LOOK can
  // never be replayed as authority to DELETE — the Worker verifies
  // the matching builder per endpoint.
  buildMessage: (wallet: string, issuedAt: number) => string,
): Promise<SignedPostResult> {
  const origin = agentOrigin();
  if (!origin) throw new Error('diagnostics erasure backend not configured');
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signMessage(buildMessage(wallet, issuedAt));
  // The wallet prompt is UNBOUNDED, and `issuedAt` started aging the
  // moment it was stamped (#2008 round 3 P2): a signature approved
  // after the service's replay window has passed can only be
  // rejected as stale. It is not sent — the caller reports expiry,
  // an outcome the user can act on, instead of a generic failure
  // for an approval they actually gave. The margin reserves enough
  // of the window for the request to reach the Worker's clock
  // (round 4 P2) — and the caller ALSO maps the Worker's own stale
  // rejection to expiry, because no client-side margin can cover a
  // skewed local clock.
  if (
    Math.floor(Date.now() / 1000) - issuedAt >
    ERASURE_SIGNATURE_MAX_AGE_SECONDS - TRANSPORT_MARGIN_SECONDS
  ) {
    return { ok: false, httpStatus: 0, data: null, expired: true };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, issuedAt, signature }),
      signal: ctrl.signal,
    });
    // Read the body while the timer is still armed — an abort during
    // the read rejects `json()`, which lands in the catch and reads
    // as a malformed body, i.e. a failure. Never a hang.
    const data = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { ok: res.ok, httpStatus: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

/** The Worker's own stale-timestamp rejection (#2008 round 4 P2) —
 *  the exact 400 body `verifySignedRequest` emits. Reaching it means
 *  the signature aged out in transit, or the local clock that
 *  stamped `issuedAt` is skewed from the Worker's; either way the
 *  honest outcome is "expired, try again", not a generic failure
 *  for an approval the user actually gave. */
function staleRejected(res: SignedPostResult): boolean {
  return (
    res.httpStatus === 400 &&
    res.data?.error === 'verification_failed' &&
    res.data?.reason === 'request timestamp is stale'
  );
}

/**
 * Ask the service to erase the wallet's error-diagnostics records.
 * The wallet prompt (the only user-visible step before the request)
 * is the signature over the canonical message; a user who dismisses
 * it surfaces here as a thrown rejection, which callers treat as a
 * cancel rather than a failure.
 */
export async function requestDiagErasure(
  wallet: `0x${string}`,
  signMessage: (message: string) => Promise<string>,
): Promise<DiagErasureOutcome> {
  const res = await postSigned('/diag/erasure', wallet, signMessage, buildErasureMessage);
  if (res.expired) return 'expired';
  if (res.ok) {
    // A 2xx alone is not the service's acknowledgement (#2008 round
    // 1 P1): a misconfigured origin or an intermediary can return a
    // 204 or a fallback page, and reporting THAT as processed would
    // falsely confirm a legal-right request the erasure handler
    // never saw. Only the service's own uniform payload counts.
    return res.data?.status === 'processed' ? 'processed' : 'error';
  }
  if (res.httpStatus === 503 && res.data?.error === 'erasure_not_configured') {
    return 'unavailable';
  }
  if (staleRejected(res)) return 'expired';
  return 'error';
}

/**
 * Ask whether anything was retained. Uniformly `processed` unless an
 * operator has explicitly enabled disclosure of a legal hold for
 * this wallet — the service's gag-safe invariant, passed through
 * untouched.
 */
export async function requestDiagErasureStatus(
  wallet: `0x${string}`,
  signMessage: (message: string) => Promise<string>,
): Promise<DiagErasureStatus> {
  const res = await postSigned(
    '/diag/erasure/status',
    wallet,
    signMessage,
    buildErasureStatusMessage,
  );
  if (res.expired) return { status: 'expired' };
  if (res.ok) {
    if (
      res.data?.status === 'retained_by_law' &&
      typeof res.data.note === 'string'
    ) {
      return { status: 'retained_by_law', note: res.data.note };
    }
    // Same rule as the erasure call (#2008 round 1 P1): only the
    // service's own uniform payload may render as the reassuring
    // answer — an unparseable or unknown 2xx body is a failure, not
    // a green light.
    if (res.data?.status === 'processed') return { status: 'processed' };
    return { status: 'error' };
  }
  if (res.httpStatus === 503 && res.data?.error === 'erasure_not_configured') {
    return { status: 'unavailable' };
  }
  if (staleRejected(res)) return { status: 'expired' };
  return { status: 'error' };
}
