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
import { SUPPORTED_CHAINS } from '../../chain/chains';
import { parsePendingRemoval, type AlertAction, type AlertAnswer, type PendingRemoval } from './alerts';

type Hex = `0x${string}`;

export type KnownTelegram =
  /** A link code was issued; it lasts ten minutes and is used once. */
  | { state: 'code'; at: number; expiresAt: number }
  /** A test alert reached the linked chat: the link is proven. */
  | { state: 'confirmed'; at: number }
  /** The wallet unlinked, from this network or from every network. */
  | { state: 'unlinked'; at: number; scope: 'wallet' | 'chain' };

export interface KnownAlerts {
  telegram?: KnownTelegram;
  /** The networks whose chat protected mode keeps receiving alerts after an
   *  unlink, and when each hold ends, as the service last answered an
   *  unlink. Kept apart from `telegram`: a new link code or a test alert
   *  cancels no hold, so neither may erase it; only a later unlink answer,
   *  which names the holds as they are then, replaces it. */
  held?: { at: number; pending: PendingRemoval[] };
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
    else if (t.state === 'unlinked' && (t.scope === 'wallet' || t.scope === 'chain')) out.telegram = { state: 'unlinked', at: t.at, scope: t.scope };
  }
  const h = r.held as Record<string, unknown> | undefined;
  if (h && isNum(h.at) && Array.isArray(h.pending)) {
    const pending = h.pending.map((p) =>
      p && typeof p === 'object' ? parsePendingRemoval({ chain_id: (p as PendingRemoval).chainId, effective_at: (p as PendingRemoval).effectiveAt }) : null,
    );
    if (pending.every((p) => p !== null)) out.held = { at: h.at, pending: pending as PendingRemoval[] };
  }
  const b = r.bands as Record<string, unknown> | undefined;
  if (b && isNum(b.warnHf) && isNum(b.alertHf) && isNum(b.criticalHf) && isNum(b.at)) out.bands = { warnHf: b.warnHf, alertHf: b.alertHf, criticalHf: b.criticalHf, at: b.at };
  const d = r.dueDate as Record<string, unknown> | undefined;
  if (d && typeof d.on === 'boolean' && isNum(d.at)) out.dueDate = { on: d.on, at: d.at };
  const p = r.push as Record<string, unknown> | undefined;
  if (p && isNum(p.at) && (p.outcome === 'stored' || p.outcome === 'kept')) out.push = { at: p.at, outcome: p.outcome };
  return out;
}

/** Records this page visit could not write to the browser's storage, by
 *  key. While one is held it is the record: storage then holds an older
 *  copy, or none, and reading it back would undo a change just made. A later
 *  write that does reach storage releases it. */
const unsaved = new Map<string, KnownAlerts>();

export function readKnown(chainId: number, wallet: Hex, storage: Pick<Storage, 'getItem'> | null = safeStorage()): KnownAlerts {
  const held = unsaved.get(key(chainId, wallet));
  if (held) return held;
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
  const k = key(chainId, wallet);
  const next = { ...readKnown(chainId, wallet, storage), ...patch };
  try {
    if (!storage) throw new Error('no storage');
    storage.setItem(k, JSON.stringify(next));
    unsaved.delete(k);
  } catch {
    // Not stored: held for this page visit, so the next change merges into
    // it rather than into what storage still has.
    unsaved.set(k, next);
  }
  snapshots.set(k, next);
  notify();
  return next;
}

/** The record each mounted card shows, by key: kept until a write (from this
 *  tab, or from another tab through the storage event) replaces it, so every
 *  card on every page reads one value and an action that finishes while its
 *  card is unmounted still reaches the card shown next. */
const snapshots = new Map<string, KnownAlerts>();
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

export function subscribeKnown(listener: () => void): () => void {
  if (listeners.size === 0) {
    // Nothing listened for other tabs' writes while no card was mounted, so
    // every cached record may be stale: read storage again. A record this
    // visit could not store is still read first (see readKnown).
    snapshots.clear();
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function onStorage(e: StorageEvent): void {
  if (e.key === null || e.key.startsWith(PREFIX)) {
    if (e.key === null) snapshots.clear();
    else snapshots.delete(e.key);
    notify();
  }
}

export function knownSnapshot(chainId: number, wallet: Hex): KnownAlerts {
  const k = key(chainId, wallet);
  let v = snapshots.get(k);
  if (!v) {
    v = readKnown(chainId, wallet);
    snapshots.set(k, v);
  }
  return v;
}

/** Record what the service did, for the wallet and network that signed,
 *  whichever page is showing when the answer arrives. */
export function recordAnswer(chainId: number, wallet: Hex, action: AlertAction, answer: AlertAnswer, at: number = Math.floor(Date.now() / 1000)): void {
  if (!answer.ok) return;
  if (answer.action === 'link') writeKnown(chainId, wallet, { telegram: { state: 'code', at, expiresAt: at + CODE_LIFETIME_S } });
  else if (answer.action === 'test-alert') writeKnown(chainId, wallet, { telegram: { state: 'confirmed', at } });
  else if (answer.action === 'unlink') {
    const telegram = { state: 'unlinked' as const, at, scope: answer.scope };
    // A wallet-wide unlink cleared every network's link for this wallet, and
    // its answer names every hold protected mode keeps, including on
    // networks this app does not serve: that list replaces the holds on
    // every record. A one-network unlink speaks for this network only, so it
    // replaces this network's hold and keeps the others.
    const chains = answer.scope === 'wallet' ? SUPPORTED_CHAINS.map((c) => c.chainId) : [chainId];
    for (const id of chains) {
      const before = readKnown(id, wallet).held?.pending ?? [];
      const pending = answer.scope === 'wallet' ? answer.pending : [...before.filter((p) => p.chainId !== chainId), ...answer.pending];
      writeKnown(id, wallet, { telegram, held: { at, pending } });
    }
  } else if (typeof action !== 'string') {
    const { bands, dueDateReminders, pushAlerts } = action.save;
    writeKnown(chainId, wallet, {
      ...(bands ? { bands: { ...bands, at } } : {}),
      ...(dueDateReminders !== undefined ? { dueDate: { on: dueDateReminders, at } } : {}),
      ...(pushAlerts && answer.push !== 'not-requested' ? { push: { at, outcome: answer.push } } : {}),
    });
  }
}

/** How long a Telegram link code lasts, as the service issues it. */
export const CODE_LIFETIME_S = 600;

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
