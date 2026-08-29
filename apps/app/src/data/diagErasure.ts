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
import { buildErasureMessage } from '@vaipakam/lib/erasureMessage';

const TIMEOUT_MS = 10_000;

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
  | { status: 'error' };

async function postSigned(
  path: '/diag/erasure' | '/diag/erasure/status',
  wallet: string,
  signMessage: (message: string) => Promise<string>,
): Promise<Response> {
  const origin = agentOrigin();
  if (!origin) throw new Error('diagnostics erasure backend not configured');
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await signMessage(buildErasureMessage(wallet, issuedAt));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet, issuedAt, signature }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
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
  const res = await postSigned('/diag/erasure', wallet, signMessage);
  if (res.ok) return 'processed';
  if (res.status === 503) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (data?.error === 'erasure_not_configured') return 'unavailable';
  }
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
  const res = await postSigned('/diag/erasure/status', wallet, signMessage);
  if (res.ok) {
    const data = (await res.json().catch(() => null)) as {
      status?: string;
      note?: string;
    } | null;
    if (data?.status === 'retained_by_law' && typeof data.note === 'string') {
      return { status: 'retained_by_law', note: data.note };
    }
    return { status: 'processed' };
  }
  if (res.status === 503) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (data?.error === 'erasure_not_configured') return { status: 'unavailable' };
  }
  return { status: 'error' };
}
