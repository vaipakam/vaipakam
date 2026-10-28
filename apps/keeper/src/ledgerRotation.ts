// apps/keeper/src/ledgerRotation.ts
//
// One rule for every pass the indexer's event ledger nominates work for
// (#2984): the buyback expiry and the prepay-sale offers of `protocolUpkeep`,
// the removed-destination releases of the close-out, the stranded returns of
// the return transport, and the tier-push retry. Each used to carry its own
// copy of the rule below, and each copy was corrected for the same two
// Codex findings separately (#2993 r4, #3002, #3010).
//
// A page a run is read from where the last run stopped, wrapping round, above
// a stored floor every row before which is finished (the Codex #2993 r2 rule:
// a read of the oldest rows only would never reach a later one). The floor
// moves only on a page read from the floor itself, and only past the leading
// rows that are finished at the head AND at the chain's finalized block
// (r4): nothing below the floor is read again, so a row it passes must stay
// finished for good, and only finality guarantees that. At the finalized
// block a row counts only when the row's own event is finalized too (#3002):
// below the event the chain shows the state before it, which can read as
// "nothing to do". A row that nominates nothing is finished at once.

import type { EventLedger, LedgerRow } from './eventLedger';
import { decodePos, encodePos, posAfter, rowFinalized } from './eventLedger';
import { finalFloor, type FinalBlock, type ScanCursors } from './scanCursors';

/** What a pass reads its rotation with. */
export interface RotationSpec<K> {
  ledger: EventLedger;
  cursors: ScanCursors;
  chainId: number;
  kinds: readonly string[];
  /** Cursor items: the floor, and where the next page starts. */
  floorItem: string;
  nextItem: string;
  /** Rows a run. */
  limit: number;
  /** What a row nominates, or null when it names nothing usable. */
  nominee: (row: LedgerRow) => K | null;
  /** A nominee's identity, so several rows naming it are read once. */
  id: (k: K) => string;
}

/** One run's page of a rotation. */
export interface LedgerRotation<K> {
  rows: readonly LedgerRow[];
  /** What each row nominates, by position (null: nothing). */
  named: readonly (K | null)[];
  /** The distinct nominees of the page, in order of first appearance. */
  nominees: K[];
  /**
   * Move the floor past the leading finished rows, when this page was read
   * from the floor. `doneAtHead` says whether a nominee is finished on the
   * reads this run made; `doneAtFinal` reads the nominees of the rows the
   * head would pass whose events are finalized, at `block`, and says which
   * are finished there. Neither is asked about a row that nominates nothing.
   */
  liftFloor(
    finalized: () => Promise<FinalBlock | null>,
    doneAtHead: (k: K) => boolean,
    doneAtFinal: (ks: readonly K[], block: FinalBlock) => Promise<(k: K) => boolean>,
  ): Promise<void>;
}

/** This run's page, with the next-page cursor already stored; null when the
 *  ledger cannot be read (the caller says so in its own words). */
export async function readLedgerRotation<K>(spec: RotationSpec<K>): Promise<LedgerRotation<K> | null> {
  const { cursors } = spec;
  const stored = await cursors.get([spec.floorItem, spec.nextItem]);
  const floor = decodePos(stored.get(spec.floorItem));
  const next = decodePos(stored.get(spec.nextItem));
  const start = next !== null && (floor === null || posAfter(next, floor)) ? next : floor;
  const page = await spec.ledger.page(spec.chainId, spec.kinds, start, spec.limit);
  if (page === null) return null;
  const last = page.rows[page.rows.length - 1];
  // Past the last page the next run starts at the floor again.
  const nextPos = page.more && last !== undefined ? encodePos(last) : '';
  if (nextPos !== (stored.get(spec.nextItem) ?? '')) await cursors.put(spec.nextItem, nextPos);

  const rows = page.rows;
  const named = rows.map((row) => spec.nominee(row));
  const byId = new Map<string, K>();
  for (const k of named) if (k !== null && !byId.has(spec.id(k))) byId.set(spec.id(k), k);
  const distinct = (ks: readonly K[]) => {
    const m = new Map<string, K>();
    for (const k of ks) if (!m.has(spec.id(k))) m.set(spec.id(k), k);
    return [...m.values()];
  };

  return {
    rows,
    named,
    nominees: [...byId.values()],
    async liftFloor(finalized, doneAtHead, doneAtFinal) {
      if (start !== floor) return;
      const positions = rows.map((_, i) => i);
      const n = await finalFloor(0, positions, (i) => named[i] === null || doneAtHead(named[i]!), finalized, async (passed, block) => {
        const live = passed.filter((i) => named[i] !== null && rowFinalized(rows[i], block));
        const isDone = live.length === 0 ? () => false : await doneAtFinal(distinct(live.map((i) => named[i]!)), block);
        return new Set(passed.filter((i) => named[i] === null || (rowFinalized(rows[i], block) && isDone(named[i]!))));
      });
      if (n > 0) await cursors.put(spec.floorItem, encodePos(rows[n - 1]));
    },
  };
}
