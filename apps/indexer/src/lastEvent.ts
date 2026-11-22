/**
 * #3921 part B2 — every row the indexer derives names the event that last
 * changed it (TroubleshootingPictureDesign §4.6, "A row back to its events").
 *
 * An event-derived table carries three columns:
 *
 *   last_event_block      the block of the event
 *   last_event_tx_index   the transaction's position in that block
 *   last_event_log_index  the log's position in that block
 *
 * so a wrong figure is followed back to the transaction that produced it,
 * and the transaction explainer shows what that transaction did. The three
 * say what they know and what they do not:
 *
 *   block, tx, log      the event at that position
 *   block, NULL, log    the event at that log position; its transaction's
 *                       position was not in hand (a log without it)
 *   block, NULL, NULL   not an event: the row was set from a read of the
 *                       chain's state AT that block, which reflects every
 *                       event up to the end of it
 *   NULL, NULL, NULL    unknown: the row was last written before these
 *                       columns existed (migration 0127), or by a write that
 *                       could not name a block
 *
 * ONE RULE for every write, the {@link LAST_EVENT_SET} assignment: the
 * columns only ever move FORWARD. The handlers apply some events grouped by
 * kind within a block (an offer's acceptances before its cancellations, for
 * example), so the handler that writes a row last is not always the event
 * that came last on chain. Taking the later of the stored position and the
 * new one makes the columns name the latest event that wrote the row, in
 * chain order, whatever order the handlers ran in, and a re-scan of an
 * older block cannot move them back. One exception, so the row never names a
 * source that did not produce its figures: a write whose figures came from a
 * source it cannot name (an unpinned read; {@link UNKNOWN_POSITION}) makes
 * the row unknown, whatever it named before. A STORED unknown, by contrast,
 * gives way to any known position. The log index is unique within a block, so
 * block and log index order the events; the transaction index rides along.
 *
 * Which tables carry the columns, and why the others do not, is
 * `test/lastEventGuard.test.ts`. That test also refuses any write to such a
 * table that neither sets the columns nor carries the marker
 * `last-event: unchanged — <reason>` as a SQL comment, for a write that
 * changes no figure an event produced (a bookkeeping flag, a notification
 * stamp, a value copied from the opening event's own record).
 */

/** Where a row's last change came from: an event's position, or a read. */
export interface RowPosition {
  block: number | null;
  txIndex: number | null;
  logIndex: number | null;
}

/** A log as the handlers see it. The transaction index is optional because
 *  test fixtures and older callers may not carry it; an RPC log always does. */
export interface PositionedLog {
  blockNumber: bigint | number;
  transactionIndex?: number | bigint | null;
  logIndex: number | bigint | null;
}

const toNumberOrNull = (v: number | bigint | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** The position of the event a handler is applying. */
export function eventPosition(log: PositionedLog): RowPosition {
  return {
    block: Number(log.blockNumber),
    txIndex: toNumberOrNull(log.transactionIndex),
    logIndex: toNumberOrNull(log.logIndex),
  };
}

/** A row set from a read of the chain's state pinned at `block`. A handler
 *  that reads the post-image at its own event's block records this, not the
 *  event: the read returns the END of the block, which may already include a
 *  later transaction in it (a match followed by a repayment), so naming the
 *  handler's event would attribute that later outcome to it. */
export function readPosition(block: bigint | number): RowPosition {
  return { block: Number(block), txIndex: null, logIndex: null };
}

/** A write whose figures came from a read whose block cannot be named (an
 *  unpinned read at the chain's head). Its provenance is unknown, so the row
 *  says so rather than naming an event that did not produce the figures. */
export const UNKNOWN_POSITION: RowPosition = Object.freeze({ block: null, txIndex: null, logIndex: null });

/** The three binds {@link LAST_EVENT_SET} and an INSERT's three columns
 *  take, in column order. */
export function lastEventBinds(p: RowPosition): [number | null, number | null, number | null] {
  return [p.block, p.txIndex, p.logIndex];
}

/**
 * The one assignment every UPDATE of an event-derived row ends its SET list
 * with (interpolated as `${LAST_EVENT_SET}`; the SQL guard substitutes it
 * before preparing, so the statement is still checked against the schema).
 * It takes three binds, {@link lastEventBinds}, and keeps whichever of the
 * stored position and the new one is later: an incoming unknown first (see
 * the exception above), then by block (a stored unknown is never later),
 * then by log index, where a read (no log index) counts as
 * after every log of its block. SET expressions read the row as it was, so
 * the stored position is the one before this write.
 */
export const LAST_EVENT_SET = laterOf('?, ?, ?');

/**
 * The same assignment for an upsert's `ON CONFLICT ... DO UPDATE SET`, whose
 * new position is the one the INSERT carried (`excluded.*`) rather than three
 * binds: a statement that inserts many rows at once (one bound JSON array)
 * has no per-row bind to give. Same rule, same ordering, one definition.
 */
export const LAST_EVENT_UPSERT_SET = laterOf(
  'excluded.last_event_block, excluded.last_event_tx_index, excluded.last_event_log_index',
);

/** The one ordering both forms share: an incoming unknown, else the later of
 *  `incoming` and the stored position, by block (a stored unknown never
 *  later), then log index, a read (no log index) counting as after every log
 *  of its block. */
function laterOf(incoming: string): string {
  const [b, t, l] = incoming.split(',').map((x) => x.trim());
  // A compound SELECT, not a VALUES list: SQLite refuses a VALUES row that
  // reads `excluded.*` inside an upsert ("no such column: column1"), and the
  // two forms must stay one rule.
  // `n` marks the incoming row: an incoming unknown sorts first, a stored
  // unknown last.
  return (
    `(last_event_block, last_event_tx_index, last_event_log_index) = (` +
    `SELECT b, t, l FROM (SELECT ${b} AS b, ${t} AS t, ${l} AS l, 1 AS n ` +
    `UNION ALL SELECT last_event_block, last_event_tx_index, last_event_log_index, 0) ` +
    `ORDER BY (b IS NULL AND n = 1) DESC, b IS NULL, b DESC, ifnull(l, 2147483647) DESC LIMIT 1)`
  );
}
