/**
 * #3836 — one signed alert request, from the key the browser draws to the
 * answer the alert service gives, and the copy of it this browser keeps
 * until it is finished.
 *
 * Every alert request (link or unlink Telegram, save settings, send a test
 * alert) names a request key: this browser draws a random secret, the text
 * the wallet signs carries its hash, and the request carries the secret. The
 * alert service accepts a request only with the secret its signature names,
 * so only the browser that started a request can finish it.
 *
 * A wallet that needs several owners to approve (a multi-signature wallet)
 * can take days to answer, and the page may be closed meanwhile. So the
 * request (the text to sign, the body and the secret) is kept in this
 * browser's storage from before the wallet is asked until the service has
 * answered, and the card offers to finish it: asking the wallet for the same
 * approval again and sending it. It is dropped once it is answered, when the
 * owner rejects it in the wallet, when the owner discards it, or once it is
 * older than the service accepts (seven days for a contract's approval).
 *
 * Storage is a per-browser convenience: when it is unavailable the request
 * still runs, it just cannot be finished after the page closes.
 */
import {
  LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS,
  alertRequestUnused,
  newRequestKey,
  requestKeyHash,
} from '@vaipakam/lib/alertsMessage';
import { isUserRejection } from '../lib/errors';

/** The signed alert requests. */
export type AlertRequestKind = 'link' | 'unlink' | 'test-alert' | 'save-settings' | 'set-phrase' | 'clear-phrase';

/** A signed alert request this browser started and has not had answered. */
export interface PendingAlertRequest {
  kind: AlertRequestKind;
  wallet: string;
  chainId: number;
  /** The alert service route it is sent to. */
  path: string;
  /** The body fields other than the signed time, the signature and the key. */
  body: Record<string, unknown>;
  /** The exact text the wallet is asked to sign. */
  message: string;
  issuedAt: number;
  /** The secret whose hash `message` names. Never sent anywhere but the
   *  alert service, and only with this request. */
  requestKey: `0x${string}`;
  /** What the card needs to finish its side (the settings a save was for). */
  context?: unknown;
}

/** The longest a request can wait: what the alert service accepts for a
 *  contract's approval. An ordinary wallet answers at once, so its request
 *  never waits. */
export const ALERT_REQUEST_MAX_AGE_SECONDS = LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS;

const KINDS: readonly AlertRequestKind[] = ['link', 'unlink', 'test-alert', 'save-settings', 'set-phrase', 'clear-phrase'];

function storageKey(chainId: number, wallet: string): string {
  return `vaipakam.alerts.pendingRequest.v1.${chainId}.${wallet.toLowerCase()}`;
}

function shapeOk(v: unknown): v is PendingAlertRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    KINDS.includes(r.kind as AlertRequestKind) &&
    typeof r.wallet === 'string' &&
    typeof r.chainId === 'number' &&
    typeof r.path === 'string' &&
    !!r.body &&
    typeof r.body === 'object' &&
    typeof r.message === 'string' &&
    typeof r.issuedAt === 'number' &&
    typeof r.requestKey === 'string' &&
    /^0x[0-9a-f]{64}$/.test(r.requestKey)
  );
}

/** The unix second after which `req` can no longer be finished. */
export function pendingExpiresAt(req: Pick<PendingAlertRequest, 'issuedAt'>): number {
  return req.issuedAt + ALERT_REQUEST_MAX_AGE_SECONDS;
}

/** The request this browser started for (`chainId`, `wallet`) and has not
 *  had answered, or null. An expired or unreadable one is dropped. */
export function loadPendingAlertRequest(
  chainId: number,
  wallet: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PendingAlertRequest | null {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(storageKey(chainId, wallet));
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !shapeOk(parsed) ||
    parsed.chainId !== chainId ||
    parsed.wallet.toLowerCase() !== wallet.toLowerCase() ||
    pendingExpiresAt(parsed) < nowSeconds
  ) {
    clearPendingAlertRequest(chainId, wallet);
    return null;
  }
  return parsed;
}

/** Forget the pending request for (`chainId`, `wallet`). With `requestKey`,
 *  only when the stored request is that one: a request that finishes must not
 *  drop a newer one another tab started for the same wallet meanwhile. */
export function clearPendingAlertRequest(chainId: number, wallet: string, requestKey?: string): void {
  try {
    const key = storageKey(chainId, wallet);
    if (requestKey !== undefined) {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      let stored: unknown;
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = null;
      }
      if (!stored || typeof stored !== 'object' || (stored as { requestKey?: unknown }).requestKey !== requestKey) return;
    }
    localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

function keep(req: PendingAlertRequest): void {
  try {
    localStorage.setItem(storageKey(req.chainId, req.wallet), JSON.stringify(req));
  } catch {
    // Storage unavailable: the request still runs, it just cannot be
    // finished after this page closes.
  }
}

/** A new request: a fresh key, the text naming its hash, the time now. */
export function newAlertRequest(
  kind: AlertRequestKind,
  wallet: string,
  chainId: number,
  path: string,
  body: Record<string, unknown>,
  buildMessage: (issuedAt: number, keyHash: string) => string,
  context?: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PendingAlertRequest {
  const requestKey = newRequestKey();
  return {
    kind,
    wallet,
    chainId,
    path,
    body,
    message: buildMessage(nowSeconds, requestKeyHash(requestKey)),
    issuedAt: nowSeconds,
    requestKey,
    ...(context === undefined ? {} : { context }),
  };
}

/** The alert service's answer, as the alert client's `post` gives it. */
export interface AlertServiceAnswer {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

/**
 * Ask the wallet to sign `req` and send it. A new request (`how` = start)
 * is kept in this browser before the wallet is asked; a kept one being
 * finished (`resume`) is not written again, so a page closed while the owners
 * approve can still finish it. It is dropped once the service answers,
 * except when the service refused it before recording it (a busy or
 * unavailable limiter, or a signature check that could not run:
 * `alertRequestUnused`), so the same signed request may be sent again. It
 * is also dropped when the owner rejects it in the wallet.
 * Any other failure (a wallet that gave up waiting, a network error) keeps
 * it, to be finished later.
 *
 * `unkept` is sent with the request and never stored: the alert phrase
 * (#3346), which the owner types again to finish a request that waited.
 */
export async function signAndSendAlertRequest(
  req: PendingAlertRequest,
  signMessage: (message: string) => Promise<string>,
  send: (path: string, body: Record<string, unknown>) => Promise<AlertServiceAnswer>,
  how: 'start' | 'resume' = 'start',
  unkept: Record<string, unknown> = {},
): Promise<AlertServiceAnswer> {
  // Only a new request is written. Finishing one sends what is already
  // kept and writes nothing: a stale card finishing an older request must
  // not overwrite a newer one another tab started for the same wallet.
  if (how === 'start') keep(req);
  let signature: string;
  try {
    signature = await signMessage(req.message);
  } catch (err) {
    if (isUserRejection(err)) clearPendingAlertRequest(req.chainId, req.wallet, req.requestKey);
    throw err;
  }
  const res = await send(req.path, {
    ...req.body,
    ...unkept,
    issuedAt: req.issuedAt,
    signature,
    requestKey: req.requestKey,
  });
  if (!alertRequestUnused(res.status, res.data?.error)) {
    clearPendingAlertRequest(req.chainId, req.wallet, req.requestKey);
  }
  return res;
}
