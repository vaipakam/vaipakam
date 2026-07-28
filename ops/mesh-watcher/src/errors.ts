/**
 * ROOT-CAUSE FIX #1 — third-party error text never leaves this Worker.
 *
 * Four review rounds found four different paths by which a secret escaped
 * (#1443 r4, r5, r6, r7, r8), and every one had the same shape: some
 * library's error message was forwarded outward, and that message
 * contained a URL, or a token, or a credential the library had helpfully
 * interpolated. Each fix redacted one more path. That is unwinnable —
 * every new outward path is a new leak, and the redactor can only ever
 * chase shapes it already knows (the raw URL, then userinfo, then a bare
 * echoed key, then its percent-decoded form).
 *
 * So the source is closed instead: errors are CLASSIFIED into this
 * module's own vocabulary, and only that vocabulary is emitted. Nothing a
 * provider says is ever quoted. A future call site cannot leak a secret
 * because it has no third-party text to forward — the only thing it can
 * emit is a {@link Failure}, whose fields this module produces.
 *
 * Redaction still exists (`redact.ts`) as a second layer at the single
 * output boundary, so a regression that reintroduces raw text is caught
 * rather than shipped. But it is no longer load-bearing.
 */

export type FailureKind =
  | 'timeout'
  | 'http'
  | 'rpc-error'
  | 'contract-revert'
  | 'decode'
  | 'network'
  | 'storage'
  | 'unknown';

export interface Failure {
  kind: FailureKind;
  /** HTTP status, when the classifier could establish one. */
  status?: number;
  /**
   * Operator-facing description, built ENTIRELY from this module's own
   * strings plus structured fields it extracted itself. Never a quoted
   * provider message.
   */
  summary: string;
}

/** Error shapes viem and the platform actually produce, structurally. */
interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  shortMessage?: unknown;
  cause?: unknown;
}

function asErrorLike(err: unknown): ErrorLike {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : {};
}

/** Numeric HTTP status, if one is present anywhere in the cause chain. */
function findStatus(err: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined;
  const e = asErrorLike(err);
  if (typeof e.status === 'number') return e.status;
  return e.cause === undefined ? undefined : findStatus(e.cause, depth + 1);
}

/**
 * Does the cause chain carry a marker for `needle`?
 *
 * Matches against the error's own class NAME and a small set of known
 * marker substrings only. The message is inspected but NEVER retained —
 * it decides a branch and is then discarded, which is the whole point.
 */
function hasMarker(err: unknown, markers: readonly string[], depth = 0): boolean {
  if (depth > 4) return false;
  const e = asErrorLike(err);
  const haystack = [
    typeof e.name === 'string' ? e.name : '',
    typeof e.message === 'string' ? e.message : '',
    typeof e.shortMessage === 'string' ? e.shortMessage : '',
  ]
    .join(' ')
    .toLowerCase();
  if (markers.some((m) => haystack.includes(m))) return true;
  return e.cause === undefined ? false : hasMarker(e.cause, markers, depth + 1);
}

/**
 * Classify an unknown thrown value.
 *
 * @returns A {@link Failure} whose `summary` contains only strings from
 *          this module and structured fields (status codes) it extracted.
 */
export function classify(err: unknown, context?: string): Failure {
  const where = context ? `${context}: ` : '';
  const status = findStatus(err);

  if (hasMarker(err, ['aborterror', 'timed out', 'timeout', 'deadline'])) {
    return { kind: 'timeout', status, summary: `${where}no response before the deadline` };
  }
  if (status !== undefined) {
    const hint =
      status === 429
        ? 'rate limited by the endpoint'
        : status >= 500
          ? 'endpoint returned a server error'
          : status === 401 || status === 403
            ? 'endpoint rejected our credentials'
            : 'endpoint returned an error status';
    return { kind: 'http', status, summary: `${where}HTTP ${status} — ${hint}` };
  }
  if (hasMarker(err, ['revert', 'execution reverted'])) {
    return { kind: 'contract-revert', summary: `${where}the contract call reverted` };
  }
  if (hasMarker(err, ['decode', 'abi', 'size mismatch'])) {
    return {
      kind: 'decode',
      summary: `${where}response could not be decoded against the compiled ABI — check for a facet re-export`,
    };
  }
  if (hasMarker(err, ['d1_', 'sqlite', 'database', 'prepared statement'])) {
    return { kind: 'storage', summary: `${where}the alert-state database rejected the operation` };
  }
  if (hasMarker(err, ['fetch failed', 'network', 'econn', 'socket', 'dns'])) {
    return { kind: 'network', summary: `${where}the endpoint could not be reached` };
  }
  return {
    kind: 'unknown',
    summary: `${where}an unclassified error occurred (details deliberately not forwarded — see Worker logs by request id)`,
  };
}

/** Render a failure for an operator. Safe by construction. */
export function describeFailure(failure: Failure): string {
  return failure.summary;
}
