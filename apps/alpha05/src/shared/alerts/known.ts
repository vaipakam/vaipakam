/**
 * What THIS browser has done with a wallet's alerts on one network
 * (#3180 Alerts slice 2, ACC-50; RB-ALERT-CHANNELS). The alert service does
 * not tell the app what it has stored, so the page states this record as
 * what this browser knows, never as what the service holds: a link made on
 * another device, or a setting saved there, may exist.
 *
 * Kept per network and wallet in local storage. A read or write that the
 * browser refuses (a private window, storage switched off) leaves the page
 * working, with nothing remembered.
 */
type Hex = `0x${string}`;

export type KnownTelegram =
  /** A link code was issued; it lasts ten minutes and is used once. */
  | { state: 'code'; at: number; expiresAt: number }
  /** A test alert reached the linked chat: the link is proven. */
  | { state: 'confirmed'; at: number }
  /** The wallet unlinked; `pending` names the networks whose chat keeps
   *  alerts until protected mode's delay has passed. */
  | { state: 'unlinked'; at: number; scope: 'wallet' | 'chain'; pending: number[] };

export interface KnownAlerts {
  telegram?: KnownTelegram;
  bands?: { warnHf: number; alertHf: number; criticalHf: number; at: number };
  dueDate?: { on: boolean; at: number };
  /** Push was switched on from here; `kept` when the service could not send
   *  push at that moment and kept an opt-in it already held. */
  push?: { at: number; outcome: 'stored' | 'kept' };
}

const PREFIX = 'alpha05.alerts.v1';

function key(chainId: number, wallet: Hex): string {
  return `${PREFIX}:${chainId}:${wallet.toLowerCase()}`;
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Read a stored record strictly: a field whose shape is wrong is dropped,
 *  never guessed at. */
export function parseKnown(raw: unknown): KnownAlerts {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: KnownAlerts = {};
  const t = r.telegram as Record<string, unknown> | undefined;
  if (t && isNum(t.at)) {
    if (t.state === 'code' && isNum(t.expiresAt)) out.telegram = { state: 'code', at: t.at, expiresAt: t.expiresAt };
    else if (t.state === 'confirmed') out.telegram = { state: 'confirmed', at: t.at };
    else if (t.state === 'unlinked' && (t.scope === 'wallet' || t.scope === 'chain') && Array.isArray(t.pending) && t.pending.every((n) => Number.isSafeInteger(n)))
      out.telegram = { state: 'unlinked', at: t.at, scope: t.scope, pending: t.pending as number[] };
  }
  const b = r.bands as Record<string, unknown> | undefined;
  if (b && isNum(b.warnHf) && isNum(b.alertHf) && isNum(b.criticalHf) && isNum(b.at)) out.bands = { warnHf: b.warnHf, alertHf: b.alertHf, criticalHf: b.criticalHf, at: b.at };
  const d = r.dueDate as Record<string, unknown> | undefined;
  if (d && typeof d.on === 'boolean' && isNum(d.at)) out.dueDate = { on: d.on, at: d.at };
  const p = r.push as Record<string, unknown> | undefined;
  if (p && isNum(p.at) && (p.outcome === 'stored' || p.outcome === 'kept')) out.push = { at: p.at, outcome: p.outcome };
  return out;
}

export function readKnown(chainId: number, wallet: Hex, storage: Pick<Storage, 'getItem'> | null = safeStorage()): KnownAlerts {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key(chainId, wallet));
    return raw ? parseKnown(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the record for one network. */
export function writeKnown(chainId: number, wallet: Hex, patch: Partial<KnownAlerts>, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): KnownAlerts {
  const next = { ...readKnown(chainId, wallet, storage), ...patch };
  if (!storage) return next;
  try {
    storage.setItem(key(chainId, wallet), JSON.stringify(next));
  } catch {
    // Nothing is remembered; the page still shows what was just done.
  }
  return next;
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
