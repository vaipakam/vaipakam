// apps/keeper/src/scanCursors.ts
//
// Where a pass keeps how far its bounded reads got (Codex #2993 r1), so the
// work one run does is bounded while what the pass covers over many runs is
// not: a reward-entry scan's floor, a day's transport-epoch discovery cursor.
// Each is one row of the keeper's private open-work table under kind
// `scan_cursor`, on the active Diamond, keyed by the PASS and the pass's own
// item name together (`<pass>:<item>`). Two passes can use the same item name
// (`entry-floor`) for different things; the pass in the key keeps one pass's
// cursor from ever moving another's.
//
// A cursor is only an optimisation of where to start reading. Every decision a
// pass makes still comes from an on-chain read, so a cursor that cannot be
// read is read as none (the pass starts from the beginning and does more
// reading), and one that cannot be written is said in the log and costs the
// next run the same.

import type { PublicClient } from 'viem';
import { shortErr } from './callErrors';
import { getWorkItems, putWork } from './db';
import type { KeeperD1 } from './env';

/** Item name → its stored value, for one chain and Diamond. */
export interface ScanCursors {
  /** The stored values of `items` that exist; an unreadable store reads as none stored. */
  get(items: readonly string[]): Promise<Map<string, string>>;
  put(item: string, value: string): Promise<void>;
}

/** The stored key of a pass's cursor item. Exported for the tests. */
export const scanCursorKey = (pass: string, item: string) => `${pass}:${item}`;

export function d1ScanCursors(db: KeeperD1, chainId: number, diamond: string, pass: string): ScanCursors {
  return {
    async get(items) {
      try {
        const rows = await getWorkItems<{ value: string }>(db, chainId, diamond, 'scan_cursor', items.map((i) => scanCursorKey(pass, i)));
        return new Map(
          items.flatMap((i) => {
            const v = rows.get(scanCursorKey(pass, i));
            return typeof v?.payload?.value === 'string' ? [[i, v.payload.value] as const] : [];
          }),
        );
      } catch (err) {
        console.warn(`[keeper] ${pass} chain=${chainId}: its scan cursors could not be read, so it reads from the start (${shortErr(err)})`);
        return new Map();
      }
    },
    async put(item, value) {
      try {
        await putWork(db, chainId, diamond, 'scan_cursor', { item: scanCursorKey(pass, item), block: 0, payload: { value } });
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

/**
 * The part of the range `lo..hi` (inclusive) one run reads when it may read at
 * most `size` of it (Codex #2993 r2). All of it when it fits; otherwise `size`
 * items from `cursor`, or from `lo` when the cursor is missing or outside the
 * range. `next` is where the following run starts: just past this window, or
 * `lo` again once the window reached `hi`. So a run's reads stay bounded while
 * every item of the range is read at least once every ceil(range / size) runs:
 * a bounded read never leaves an item out for good, which a fixed window over
 * the newest items does.
 *
 * `lo` is the pass's stored floor of items finished for good (a proven-closed
 * day, a finalized era), so the range shrinks as work completes; a pass moves
 * it with {@link finalFloor}, never from a head reading alone. Null when the
 * range is empty.
 */
export function rotatingWindow(lo: number, hi: number, size: number, cursor: number | null): { from: number; to: number; next: number } | null {
  if (hi < lo || size <= 0) return null;
  if (hi - lo + 1 <= size) return { from: lo, to: hi, next: lo };
  const from = cursor !== null && cursor >= lo && cursor <= hi ? cursor : lo;
  const to = Math.min(hi, from + size - 1);
  return { from, to, next: to >= hi ? lo : to + 1 };
}

/** A stored non-negative integer cursor, or null when there is none or it is malformed. */
export function decodeIndex(raw: string | undefined): number | null {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}

/** How far a floor of finished items may move up: past every leading item of
 *  `items` (ascending, starting at the floor) that `done` holds. */
export function advanceFloor(floor: number, items: readonly number[], done: (item: number) => boolean): number {
  let f = floor;
  for (const i of items) {
    if (i !== f || !done(i)) break;
    f = i + 1;
  }
  return f;
}

/** A chain's finalized block, as the floor rule reads it. */
export interface FinalBlock {
  number: bigint;
  timestamp: bigint;
}

/** The chain's finalized block, read at most once per returned reader; null
 *  when it cannot be read (an RPC without the tag, a run past its deadline),
 *  which only holds every floor where it is until a run that can read it. */
export function finalizedBlockOnce(client: Pick<PublicClient, 'getBlock'>): () => Promise<FinalBlock | null> {
  let read: Promise<FinalBlock | null> | undefined;
  return () =>
    (read ??= Promise.resolve()
      .then(() => client.getBlock({ blockTag: 'finalized' }))
      .then((b) => (typeof b.number === 'bigint' ? { number: b.number, timestamp: b.timestamp } : null))
      .catch(() => null));
}

/**
 * How far a stored floor of finished items may move (Codex #2993 r4): past
 * the leading `items` that `doneAtHead` holds AND that `doneAtFinal` reads as
 * finished at the chain's finalized block. Nothing below a floor is read
 * again, so an item it passes must stay finished for good, and a transaction
 * seen landed at the head can still be reorged out: the item it finished
 * would then sit below the floor unfinished, and no later run would look at
 * it. Finality is where that stops being possible, so a floor moves only on
 * what finality shows. An item finished at the head and not yet at finality
 * keeps its place in the rotation and lifts the floor a run or two later; a
 * finalized read that cannot be made leaves the floor where it is.
 *
 * `doneAtFinal` is asked only about the items the head reading would pass,
 * so the extra reads are bounded by the run's own window.
 */
export async function finalFloor(
  floor: number,
  items: readonly number[],
  doneAtHead: (item: number) => boolean,
  finalized: () => Promise<FinalBlock | null>,
  doneAtFinal: (items: readonly number[], block: FinalBlock) => Promise<ReadonlySet<number>>,
): Promise<number> {
  const head = advanceFloor(floor, items, doneAtHead);
  if (head === floor) return floor;
  const block = await finalized();
  if (block === null) return floor;
  const passed: number[] = [];
  for (let i = floor; i < head; i++) passed.push(i);
  const done = await doneAtFinal(passed, block);
  return advanceFloor(floor, passed, (i) => done.has(i));
}
