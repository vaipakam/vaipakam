/**
 * #3415 — the reader's saved addresses on one network, for one wallet
 * (RB-ADDRESS-GUARD). An address that may receive payouts is chosen from
 * here, never typed into the payout form itself. Two kinds join the book:
 *
 *  - a wallet the reader proved they control, by a signature from it
 *    (`proof.ts`);
 *  - an exchange deposit address, which cannot sign: saved unverified, under
 *    the exchange's name, which every later confirmation shows.
 *
 * Kept in this browser's local storage, so another browser or device has
 * its own book; the page says so. A read or write the browser refuses (a
 * private window, storage switched off) leaves the page working for this
 * visit, with nothing remembered after it.
 */
import { getAddress, isAddress } from 'viem';
import { parseChallenge, type ControlChallenge, type ProofPurpose } from './proof';

type Hex = `0x${string}`;

export interface SavedAddress {
  address: Hex;
  /** The reader's own name for it. */
  label: string;
  kind: 'wallet' | 'exchange';
  /** For a wallet: when its signature was checked, and for what. */
  proof: { at: number; purpose: ProofPurpose } | null;
  /** For an exchange deposit address: the exchange, as the reader named it. */
  exchange: string | null;
  savedAt: number;
}

/** A proof request this browser made and is waiting on. */
export interface PendingProof {
  challenge: ControlChallenge;
  label: string;
}

export interface AddressBook {
  entries: SavedAddress[];
  pending: PendingProof[];
}

const EMPTY: AddressBook = { entries: [], pending: [] };
const PREFIX = 'alpha05.addressBook.v1';
/** Longest name kept for an address or an exchange. */
export const LABEL_MAX = 40;

function key(chainId: number, account: Hex): string {
  return `${PREFIX}:${chainId}:${account.toLowerCase()}`;
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function cleanLabel(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const t = x.trim().slice(0, LABEL_MAX);
  return t === '' ? null : t;
}

function parseEntry(raw: unknown): SavedAddress | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const label = cleanLabel(r.label);
  if (typeof r.address !== 'string' || !isAddress(r.address, { strict: false }) || !label || !isNum(r.savedAt)) return null;
  const address = getAddress(r.address);
  if (r.kind === 'wallet') {
    const p = r.proof as Record<string, unknown> | null;
    if (!p || !isNum(p.at) || (p.purpose !== 'destination' && p.purpose !== 'keeper')) return null;
    return { address, label, kind: 'wallet', proof: { at: p.at, purpose: p.purpose }, exchange: null, savedAt: r.savedAt };
  }
  if (r.kind === 'exchange') {
    const exchange = cleanLabel(r.exchange);
    if (!exchange) return null;
    return { address, label, kind: 'exchange', proof: null, exchange, savedAt: r.savedAt };
  }
  return null;
}

/** Read a stored book strictly: an entry of the wrong shape is dropped,
 *  never guessed at. */
export function parseBook(raw: unknown): AddressBook {
  if (raw === null || typeof raw !== 'object') return EMPTY;
  const r = raw as Record<string, unknown>;
  const entries = Array.isArray(r.entries) ? r.entries.map(parseEntry).filter((e): e is SavedAddress => e !== null) : [];
  const pending = Array.isArray(r.pending)
    ? r.pending
        .map((p) => {
          const c = p && typeof p === 'object' ? parseChallenge((p as PendingProof).challenge) : null;
          const label = cleanLabel(p && typeof p === 'object' ? (p as PendingProof).label : null);
          return c && label ? { challenge: c, label } : null;
        })
        .filter((p): p is PendingProof => p !== null)
    : [];
  return { entries, pending };
}

/** Books this visit could not store, by key (see alerts/known.ts). */
const unsaved = new Map<string, AddressBook>();
const snapshots = new Map<string, AddressBook>();
const listeners = new Set<() => void>();

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readBook(chainId: number, account: Hex, storage: Pick<Storage, 'getItem'> | null = safeStorage()): AddressBook {
  const held = unsaved.get(key(chainId, account));
  if (held) return held;
  if (!storage) return EMPTY;
  try {
    const raw = storage.getItem(key(chainId, account));
    return raw ? parseBook(JSON.parse(raw)) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeBook(chainId: number, account: Hex, next: AddressBook, storage: Pick<Storage, 'setItem'> | null = safeStorage()): AddressBook {
  const k = key(chainId, account);
  try {
    if (!storage) throw new Error('no storage');
    storage.setItem(k, JSON.stringify(next));
    unsaved.delete(k);
  } catch {
    unsaved.set(k, next);
  }
  snapshots.set(k, next);
  for (const l of listeners) l();
  return next;
}

/** Whether the last write reached the browser's storage (false: kept for
 *  this visit only). */
export function bookStored(chainId: number, account: Hex): boolean {
  return !unsaved.has(key(chainId, account));
}

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** Save or replace the entry for an address; any request waiting on it is done. */
export function saveEntry(chainId: number, account: Hex, entry: SavedAddress): AddressBook {
  const b = readBook(chainId, account);
  return writeBook(chainId, account, {
    entries: [...b.entries.filter((e) => !same(e.address, entry.address)), entry],
    pending: b.pending.filter((p) => !same(p.challenge.destination, entry.address)),
  });
}

/**
 * Save a wallet whose proof answered `p`, only if `p` itself is still the
 * request waiting for that address (same nonce). A request dropped, or
 * replaced by a newer one, in this tab or another, while its answer was
 * being checked no longer counts: nothing is saved and false is returned.
 */
export function provePending(chainId: number, account: Hex, p: PendingProof, entry: SavedAddress): boolean {
  const waiting = readBook(chainId, account).pending.find((x) => same(x.challenge.destination, p.challenge.destination));
  if (!waiting || waiting.challenge.nonce !== p.challenge.nonce || !same(entry.address, p.challenge.destination)) return false;
  saveEntry(chainId, account, entry);
  return true;
}

export function removeEntry(chainId: number, account: Hex, address: Hex): AddressBook {
  const b = readBook(chainId, account);
  return writeBook(chainId, account, { ...b, entries: b.entries.filter((e) => !same(e.address, address)) });
}

/** Wait on a proof request; a newer request for the same address replaces
 *  the older one, whose answer then no longer counts. */
export function addPending(chainId: number, account: Hex, p: PendingProof): AddressBook {
  const b = readBook(chainId, account);
  return writeBook(chainId, account, { ...b, pending: [...b.pending.filter((x) => !same(x.challenge.destination, p.challenge.destination)), p] });
}

export function dropPending(chainId: number, account: Hex, destination: Hex): AddressBook {
  const b = readBook(chainId, account);
  return writeBook(chainId, account, { ...b, pending: b.pending.filter((x) => !same(x.challenge.destination, destination)) });
}

export function subscribeBook(listener: () => void): () => void {
  if (listeners.size === 0) {
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
    for (const l of listeners) l();
  }
}

export function bookSnapshot(chainId: number, account: Hex): AddressBook {
  const k = key(chainId, account);
  let v = snapshots.get(k);
  if (!v) {
    v = readBook(chainId, account);
    snapshots.set(k, v);
  }
  return v;
}
