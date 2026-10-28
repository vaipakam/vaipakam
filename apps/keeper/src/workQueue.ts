/**
 * The keeper's OPEN-WORK queue (#2497 r8): one rule for every pass that finds
 * its work in the shared event ledger (the late remit-ack).
 *
 * Two independent motions, so neither can hold the other back:
 *
 *   1. DISCOVERY moves a cursor forward through the ledger a page at a time,
 *      queuing what it finds. It never waits on an item. It never passes the
 *      block the indexer has COMPLETELY recorded, read BEFORE the page — a
 *      block still being ingested may gain rows after the read, so the cursor
 *      stops short of it and reads it again next tick.
 *   2. WORK reads a bounded slice of what is still open, least recently
 *      checked first, and retires an item only when the chain shows it
 *      finished.
 *
 * This replaced a done set plus a "done frontier" that could advance only past
 * finished items: one item that never finished pinned the ledger read at its
 * block forever, and every later finished item was reread and kept. Each fix
 * to that model (a watermark cap, pruning, read ordering) opened the next
 * edge; separating discovery from completion removes the class.
 */
import type { Env } from './env';
import { enqueueWork, getWorkCursor, indexedThrough, putWorkCursor, type WorkItem, type WorkKind } from './db';

/** Ledger rows one discovery page reads (a block is never split). */
export const DISCOVER_PAGE = 500;
/** Pages one tick may discover, so a backlog (a fresh queue over a long
 *  ledger) catches up in a few ticks without one tick reading it all. */
export const DISCOVER_PAGES_PER_TICK = 4;

/** Discover new work into the queue a page at a time, moving the cursor past
 *  each page. Queue first, cursor second: a failure between them re-reads the
 *  page next tick, and re-queuing is a no-op. Returns how many items it found. */
export async function discoverWork<T>(
  env: Env,
  chainId: number,
  diamond: string,
  kind: WorkKind,
  floor: number,
  readPage: (from: number, through: number, limit: number) => Promise<{ items: WorkItem<T>[]; next: number }>,
): Promise<{ found: number; caughtUp: boolean }> {
  let from = Math.max(floor, await getWorkCursor(env.KEEPER_DB, chainId, diamond, kind));
  // Read ONCE, before any page: everything at or below it is already written.
  const through = await indexedThrough(env.DB, chainId);
  if (through === null) return { found: 0, caughtUp: false };
  let found = 0;
  for (let i = 0; i < DISCOVER_PAGES_PER_TICK && from <= through; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await readPage(from, through, DISCOVER_PAGE);
    // eslint-disable-next-line no-await-in-loop
    await enqueueWork(env.KEEPER_DB, chainId, diamond, kind, page.items);
    // eslint-disable-next-line no-await-in-loop
    await putWorkCursor(env.KEEPER_DB, chainId, diamond, kind, page.next);
    found += page.items.length;
    from = page.next;
  }
  // Caught up: every event the indexer had recorded when this run started is
  // now in the queue (or was not work). A pass that alerts on "every open
  // item" reads this before it treats the queue as the whole set.
  return { found, caughtUp: from > through };
}
