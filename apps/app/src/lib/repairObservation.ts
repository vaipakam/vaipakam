/**
 * #2643 — a repaired loan's ending, as the Activity page shows it.
 *
 * The indexer closes a loan whose ending event it missed for good by reading
 * the loan's status from the chain (#2101). No log announced that ending, so
 * the feed cannot show it as an event. The indexer serves what it OBSERVED
 * instead, beside the events and in the same page order (`GET /activity?
 * repairObservations=1`, #2195): the status the chain showed and the block
 * the read was pinned to.
 *
 * What an entry says, and what it does not:
 *  - the chain showed the loan in `observedStatus` BY `observedBlock`;
 *  - NOT when the loan ended, nor which transaction ended it, nor who acted.
 *    None of those was seen, so the row carries no transaction link and no
 *    actor, and its time is the time of the check, not of the ending.
 *
 * `null` from the reader means NOT KNOWN, never "none": the indexer could not
 * read the record, answered in a shape this app does not recognise, or (an
 * older indexer) did not answer the field at all. The page then says its
 * history may be missing a loan's ending instead of presenting itself as
 * complete. One malformed entry makes the whole field unknown: keeping the
 * well-formed rest would present a partial record as the whole one.
 *
 * Pure, so the shape rules and the feed order are unit-tested
 * (`repairObservation.test.ts`).
 */
import type { ActivityRowView } from './activityView';

export interface RepairObservation {
  chainId: number;
  loanId: number;
  /** The indexer's terminal status name, e.g. `repaid`. */
  observedStatus: string;
  /** The loan had ended BY this block. Not the block it ended in. */
  observedBlock: number;
  /** `observedBlock`'s chain time in seconds; null when not read. */
  observedAt: number | null;
  /** Position within `observedBlock` on the feed's scale. */
  feedLogIndex: number;
}

const isUint = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Read the `repairObservations` field of one Activity page.
 *
 * Returns the entries, or `null` when they are not known (see the header).
 * An entry for another chain is malformed for this page, not skipped.
 */
export function readRepairObservations(raw: unknown, chainId: number): RepairObservation[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RepairObservation[] = [];
  for (const e of raw as unknown[]) {
    if (e === null || typeof e !== 'object') return null;
    const o = e as Record<string, unknown>;
    if (o.provenance !== 'reconciliation') return null;
    if (o.chainId !== chainId) return null;
    if (!isUint(o.loanId) || !isUint(o.observedBlock) || !isUint(o.feedLogIndex)) return null;
    if (typeof o.observedStatus !== 'string' || o.observedStatus === '') return null;
    if (o.observedAt !== null && !isUint(o.observedAt)) return null;
    out.push({
      chainId,
      loanId: o.loanId,
      observedStatus: o.observedStatus,
      observedBlock: o.observedBlock,
      observedAt: o.observedAt,
      feedLogIndex: o.feedLogIndex,
    });
  }
  return out;
}

/** One line of the Activity page: a transaction's events, or an observation. */
export type FeedItem =
  | { type: 'tx'; key: string; row: ActivityRowView }
  | { type: 'observation'; key: string; observation: RepairObservation };

/**
 * Merge transaction rows and observations newest first, by the same
 * `(block, log index)` order the indexer pages by. A row sits at its
 * representative event's position; every event of one transaction shares a
 * block, and an observation's index is above every real log index, so at a
 * shared block the observation comes first, as it does in the indexer's page.
 */
export function mergeFeed(rows: ActivityRowView[], observations: RepairObservation[]): FeedItem[] {
  const items: { block: number; index: number; item: FeedItem }[] = [
    ...rows.map((row) => ({
      block: row.event.blockNumber,
      index: row.event.logIndex,
      item: { type: 'tx' as const, key: row.key, row },
    })),
    ...observations.map((o) => ({
      block: o.observedBlock,
      index: o.feedLogIndex,
      item: {
        type: 'observation' as const,
        key: `repair-${o.chainId}-${o.loanId}`,
        observation: o,
      },
    })),
  ];
  // A stable sort keeps the rows' own order where positions tie.
  items.sort((a, b) => b.block - a.block || b.index - a.index);
  return items.map((i) => i.item);
}
