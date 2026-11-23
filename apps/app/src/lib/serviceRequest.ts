/**
 * The one way the app talks to its own services (the indexer and the agent)
 * where a failure is shown to the user (#3922, TroubleshootingPictureDesign
 * §4.6).
 *
 * A write carries a fresh request reference; a read carries none, and the
 * service makes one (`@vaipakam/lib/requestReference` says why). Either way
 * the response returns the reference, and this module hands it to the caller
 * so a failure can show it. A user can read it out, and an operator finds the
 * same reference in the service's log line and its service error record.
 *
 * The reference lives in memory only: on the result, or attached to the error
 * a caller throws (a WeakMap, so it goes when the error goes). It is never
 * written to browser storage, and it is shown only beside a failure.
 */
import {
  REQUEST_REF_HEADER,
  appSendsReference,
  newRequestReference,
  readRequestReference,
} from '@vaipakam/lib/requestReference';

export interface ServiceResult {
  res: Response;
  /** The reference the response carried; for a write without one, the one sent. */
  reference: string | null;
}

/** A request that got no response: the reference is the one sent (writes only). */
export class ServiceUnreachableError extends Error {
  readonly aborted: boolean;
  constructor(aborted: boolean, reference: string | null) {
    super(aborted ? 'service timed out' : 'service unreachable');
    this.aborted = aborted;
    noteReference(this, reference);
  }
}

/**
 * `fetch` for a service. Adds the reference header on a write, and returns
 * the response with the reference it carried. A network failure or abort
 * throws `ServiceUnreachableError`, carrying the reference that was sent.
 */
export async function serviceFetch(
  url: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceResult> {
  const sent = appSendsReference(init.method) ? newRequestReference() : null;
  const headers = new Headers(init.headers);
  if (sent) headers.set(REQUEST_REF_HEADER, sent);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers });
  } catch {
    throw new ServiceUnreachableError(init.signal?.aborted ?? false, sent);
  }
  return { res, reference: readRequestReference(res) ?? sent };
}

const references = new WeakMap<object, string>();

/** Attach a service reference to an error (or any object) a caller passes on. */
export function noteReference<T>(target: T, reference: string | null): T {
  if (reference && typeof target === 'object' && target !== null) references.set(target, reference);
  return target;
}

/** The service reference attached to an error, or null. */
export function referenceOf(target: unknown): string | null {
  return typeof target === 'object' && target !== null ? (references.get(target) ?? null) : null;
}
