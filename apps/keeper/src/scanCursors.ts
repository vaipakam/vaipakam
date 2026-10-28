// apps/keeper/src/scanCursors.ts
//
// Where a pass keeps how far its bounded reads got (Codex #2993 r1), so the
// work one run does is bounded while what the pass covers over many runs is
// not: a reward-entry scan's floor, a day's transport-epoch discovery cursor.
// Each is one row of the keeper's private open-work table under kind
// `scan_cursor`, keyed by the pass's own item name, on the active Diamond.
//
// A cursor is only an optimisation of where to start reading. Every decision a
// pass makes still comes from an on-chain read, so a cursor that cannot be
// read is read as none (the pass starts from the beginning and does more
// reading), and one that cannot be written is said in the log and costs the
// next run the same.

import { shortErr } from './callErrors';
import { getWorkItems, putWork } from './db';
import type { KeeperD1 } from './env';

/** Item name → its stored value, for one chain and Diamond. */
export interface ScanCursors {
  /** The stored values of `items` that exist; an unreadable store reads as none stored. */
  get(items: readonly string[]): Promise<Map<string, string>>;
  put(item: string, value: string): Promise<void>;
}

export function d1ScanCursors(db: KeeperD1, chainId: number, diamond: string, pass: string): ScanCursors {
  return {
    async get(items) {
      try {
        const rows = await getWorkItems<{ value: string }>(db, chainId, diamond, 'scan_cursor', items);
        return new Map([...rows].flatMap(([k, v]) => (typeof v.payload?.value === 'string' ? [[k, v.payload.value] as const] : [])));
      } catch (err) {
        console.warn(`[keeper] ${pass} chain=${chainId}: its scan cursors could not be read, so it reads from the start (${shortErr(err)})`);
        return new Map();
      }
    },
    async put(item, value) {
      try {
        await putWork(db, chainId, diamond, 'scan_cursor', { item, block: 0, payload: { value } });
      } catch (err) {
        console.warn(`[keeper] ${pass} chain=${chainId}: scan cursor ${item} could not be recorded, so the next run reads it again (${shortErr(err)})`);
      }
    },
  };
}

/** An in-memory store, for tests and for a run with no private database. */
export function memoryScanCursors(): ScanCursors & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async get(items) {
      return new Map(items.flatMap((i) => (rows.has(i) ? [[i, rows.get(i)!] as const] : [])));
    },
    async put(item, value) {
      rows.set(item, value);
    },
  };
}
