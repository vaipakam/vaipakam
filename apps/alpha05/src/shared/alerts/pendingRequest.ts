/**
 * A signed alert request this browser started and the alert service has not
 * answered yet (#3836), kept in this browser so it can be finished later.
 *
 * Every alert request names a key: this browser draws a random secret, the
 * text the wallet signs carries its hash, and the request carries the
 * secret, so only this browser can finish it. A multi-signature wallet can
 * take days to answer, and the page may be closed meanwhile. So the request
 * (the action, the time it names and its key) is kept from before the wallet
 * is asked until the service answers. Finishing asks the wallet for the same
 * approval again (a multi-signature wallet returns the one its owners gave)
 * and sends it.
 *
 * It is dropped once the service answers (except that it could not check
 * the signature yet), when the wallet's owner declines, when the reader
 * discards it, and once it is older than the service accepts: seven days,
 * the window for a contract's approval. One is kept per wallet and network;
 * starting another replaces it.
 *
 * Storage is a convenience here: where it is unavailable the request still
 * runs, it just cannot be finished after the page closes. The data download
 * withholds the key (`dataRights.ts`).
 */
import { isRequestKey, LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS } from '@vaipakam/lib/alertsMessage';
import type { AlertAction } from './alerts';

type Hex = `0x${string}`;

/** Where each pending request is kept, by network and wallet. */
export const PENDING_ALERT_PREFIX = 'alpha05.alerts.pendingRequest.';

/** The longest a request can wait: what the alert service accepts for a
 *  contract's approval. */
export const PENDING_MAX_AGE_S = LINK_SIGNATURE_CHAIN_MAX_AGE_SECONDS;

export interface PendingAlert {
  action: AlertAction;
  /** The time the signed text names, in unix seconds. */
  issuedAt: number;
  /** The secret whose hash the signed text names. Sent only to the alert
   *  service, and only with this request. */
  requestKey: Hex;
}

export type PendingStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

export function browserPendingStore(): PendingStore {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function pendingStorageKey(chainId: number, wallet: string): string {
  return `${PENDING_ALERT_PREFIX}${chainId}.${wallet.toLowerCase()}`;
}

/** The second after which `p` can no longer be finished. */
export function pendingExpiresAt(p: Pick<PendingAlert, 'issuedAt'>): number {
  return p.issuedAt + PENDING_MAX_AGE_S;
}

function actionOk(a: unknown): a is AlertAction {
  if (a === 'link' || a === 'unlink' || a === 'test-alert') return true;
  if (!a || typeof a !== 'object') return false;
  const save = (a as { save?: unknown }).save;
  return !!save && typeof save === 'object' && !Array.isArray(save) && Object.keys(a).length === 1;
}

/** Read a kept request strictly: anything else is `null`. */
export function parsePending(raw: string | null): PendingAlert | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!actionOk(r.action) || !Number.isSafeInteger(r.issuedAt) || (r.issuedAt as number) <= 0 || !isRequestKey(r.requestKey)) return null;
  return { action: r.action, issuedAt: r.issuedAt as number, requestKey: r.requestKey };
}

/** The request kept for (`chainId`, `wallet`), or `null`. An unreadable or
 *  expired one is dropped. */
export function loadPending(chainId: number, wallet: string, nowS: number = Math.floor(Date.now() / 1000), store: PendingStore = browserPendingStore()): PendingAlert | null {
  let raw: string | null;
  try {
    raw = store?.getItem(pendingStorageKey(chainId, wallet)) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  const p = parsePending(raw);
  if (p === null || pendingExpiresAt(p) < nowS) {
    clearPending(chainId, wallet, store);
    return null;
  }
  return p;
}

export function keepPending(chainId: number, wallet: string, p: PendingAlert, store: PendingStore = browserPendingStore()): void {
  try {
    store?.setItem(pendingStorageKey(chainId, wallet), JSON.stringify(p));
  } catch {
    // Storage unavailable: the request still runs, it just cannot be
    // finished after this page closes.
  }
}

/** Forget the kept request. With `requestKey`, only when the kept one is
 *  that request: one that finishes must not drop a newer one another tab
 *  started for the same wallet and network meanwhile. */
export function clearPending(chainId: number, wallet: string, store: PendingStore = browserPendingStore(), requestKey?: string): void {
  try {
    if (requestKey !== undefined) {
      const kept = parsePending(store?.getItem(pendingStorageKey(chainId, wallet)) ?? null);
      if (kept?.requestKey !== requestKey) return;
    }
    store?.removeItem(pendingStorageKey(chainId, wallet));
  } catch {
    // Storage unavailable: nothing was kept.
  }
}
