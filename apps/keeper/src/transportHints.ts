// apps/keeper/src/transportHints.ts
//
// #2489 (Codex r2) — the VERIFIED insertion hints a transport-epoch index call
// needs once a day's list is too crowded for the contract's bounded walk.
//
// Each day keeps its epochs in an ordered list by (arrival, batch id), and a
// link that lands anywhere but the list's tail also joins the day's LATE chain,
// kept in the same order. Without a hint the contract finds the place by
// walking back from the newest node, at most `TRANSPORT_INDEX_WALK_CAP` (128)
// steps, and refuses past that (`TransportIndexWalkExceeded`). So an older
// delivery indexed after more than 128 newer epochs on one of its days could
// never be indexed unhinted, and the keeper skipped it on every tick: its batch
// never became whole, and the days it funds stayed gated.
//
// The hint is the predecessor the contract would have found, and the contract
// VERIFIES it in constant work (a wrong one is refused, never mis-orders), so
// the keeper derives it from the chain's own views and the chain checks it:
//   - in the LIST: the day's cursor node (the last exhausted epoch; nothing is
//     placed before it), then every node after it whose key sorts before this
//     batch — the last such node is the predecessor, or zero (the head) when
//     the day has no cursor and every node sorts after it;
//   - in the LATE chain, only when the link will not land at the list's tail:
//     the last late node whose key sorts before this batch, or zero (the
//     chain's head).
// This mirrors `LibRewardCustody._linkIntoDay` / `_linkLate` exactly; the
// tests pin the walk against hand-built day lists.

import type { Hex } from 'viem';

export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;

/** One page of a day's list or late chain, as the epoch views return it. */
export interface OrderPage {
  page: readonly Hex[];
  arrivedAt: readonly bigint[];
  /** The node the next page starts at; zero when there is none. */
  next: Hex;
}

/** The chain reads the walk needs — `getTransportDayIndex`,
 *  `getTransportDayBatchesFrom` and `getTransportDayLateFrom`. */
export interface DayOrderReader {
  cursor(day: bigint): Promise<Hex>;
  listFrom(day: bigint, from: Hex, limit: number): Promise<OrderPage>;
  lateFrom(day: bigint, from: Hex, limit: number): Promise<OrderPage>;
}

/** Nodes per page read. */
const PAGE = 100;

/** The contract's order key: arrival, then batch id on a tie. */
export function keyBefore(aAt: bigint, a: Hex, bAt: bigint, b: Hex): boolean {
  return aAt < bAt || (aAt === bAt && BigInt(a) < BigInt(b));
}

/** The verified predecessors for linking batch `id` (arrived `arrived`) into
 *  `day`: in the list, and in the late chain (zero when the link lands at the
 *  list's tail, where the contract ignores it). */
export async function hintsForDay(
  reader: DayOrderReader,
  day: bigint,
  id: Hex,
  arrived: bigint,
): Promise<{ prev: Hex; latePrev: Hex }> {
  const cursor = await reader.cursor(day);
  let prev = cursor; // nothing is placed before the cursor
  let from = cursor;
  let skipFirst = cursor !== ZERO32; // a page from the cursor starts AT it
  let hasSuccessor = false;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const p = await reader.listFrom(day, from, PAGE);
    let stop = false;
    for (let k = 0; k < p.page.length; k++) {
      if (skipFirst) {
        skipFirst = false;
        continue;
      }
      const node = p.page[k];
      if (node.toLowerCase() === id.toLowerCase()) return { prev, latePrev: ZERO32 }; // already listed: no-op link
      if (keyBefore(p.arrivedAt[k], node, arrived, id)) {
        prev = node;
      } else {
        hasSuccessor = true;
        stop = true;
        break;
      }
    }
    if (stop || p.next === ZERO32) break;
    from = p.next;
  }
  if (!hasSuccessor) return { prev, latePrev: ZERO32 }; // lands at the tail: no late link
  let latePrev = ZERO32;
  from = ZERO32;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const p = await reader.lateFrom(day, from, PAGE);
    let stop = false;
    for (let k = 0; k < p.page.length; k++) {
      if (keyBefore(p.arrivedAt[k], p.page[k], arrived, id)) latePrev = p.page[k];
      else {
        stop = true;
        break;
      }
    }
    if (stop || p.next === ZERO32) break;
    from = p.next;
  }
  return { prev, latePrev };
}

/** Hints aligned with `dayIds` for the days a call will link (`[from, to)`),
 *  zero elsewhere — the contract reads only the entries it links. */
export async function hintsForDays(
  reader: DayOrderReader,
  dayIds: readonly bigint[],
  from: number,
  to: number,
  id: Hex,
  arrived: bigint,
): Promise<{ hints: Hex[]; lateHints: Hex[] }> {
  const hints: Hex[] = dayIds.map(() => ZERO32);
  const lateHints: Hex[] = dayIds.map(() => ZERO32);
  for (let i = from; i < Math.min(to, dayIds.length); i++) {
    // eslint-disable-next-line no-await-in-loop
    const h = await hintsForDay(reader, dayIds[i], id, arrived);
    hints[i] = h.prev;
    lateHints[i] = h.latePrev;
  }
  return { hints, lateHints };
}
