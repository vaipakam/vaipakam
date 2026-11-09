/**
 * Which inbox rows a wallet has seen, per network (RB-INBOX): the id of the
 * newest row shown on the Alerts page. It is kept in this browser only (the
 * index keeps no read state), so another browser or a cleared store counts
 * every row as new again. It only moves forward: opening the page with an
 * older answer in hand never marks newer rows unseen, and a row that arrives
 * later always has a larger id. An unreadable store falls back to memory
 * for the visit.
 */
import { useSyncExternalStore } from 'react';

type Hex = `0x${string}`;

const PREFIX = 'alpha05.inboxSeen';
const memory = new Map<string, number>();
const listeners = new Set<() => void>();

export function seenKey(chainId: number, account: Hex): string {
  return `${PREFIX}.${chainId}.${account.toLowerCase()}`;
}

/** The newest row id seen; 0 when none has been. */
export function readSeen(chainId: number, account: Hex): number {
  const key = seenKey(chainId, account);
  let stored: number | null = null;
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    stored = Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    stored = null;
  }
  return Math.max(stored ?? 0, memory.get(key) ?? 0);
}

/** Records `id` as seen, if it is newer than what is recorded. */
export function markSeen(chainId: number, account: Hex, id: number): void {
  const key = seenKey(chainId, account);
  if (id <= readSeen(chainId, account)) return;
  memory.set(key, id);
  try {
    localStorage.setItem(key, String(id));
  } catch {
    /* kept in memory for this visit */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFIX)) l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

/** The newest row id seen, kept current across components and tabs. */
export function useSeen(chainId: number | null, account: Hex | null): number {
  return useSyncExternalStore(subscribe, () => (chainId === null || account === null ? 0 : readSeen(chainId, account)));
}
