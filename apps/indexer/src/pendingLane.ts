/**
 * #3411 part 2 — the PENDING lane: events above the chain's "safe" block,
 * shown at once and marked as not final yet.
 *
 * The scan records an event in `activity_events` only once the chain reports
 * its block as safe (`settledHead.ts`), and the reorg guard (`reorgGuard.ts`)
 * rebuilds the chain's rows if even that is later replaced. That is the right
 * rule for anything the platform acts on, and it makes a fresh action wait
 * several minutes before the feed shows it. The owner's decision on #3411 was
 * to keep the rule AND show the action at once, as pending, so this lane sits
 * beside the final feed rather than loosening it.
 *
 * HOW A PENDING EVENT BECOMES FINAL, AND HOW ONE DISAPPEARS. Nothing promotes
 * a row by hand. Each pass that has caught up to the safe block reads the
 * blocks above it, up to the chain's latest block, and REPLACES this chain's
 * pending rows with what it found:
 *
 *   - once the safe block passes an event, the scan writes it to
 *     `activity_events`, and the next replacement starts above it, so the
 *     event moves from this lane to the final feed;
 *   - an event a reorganisation removed is not in the next read, so it is not
 *     in the next replacement either. Nothing is left behind to roll back.
 *
 * Between those two steps a row can sit in both places for a moment (the scan
 * wrote it, the lane has not been replaced yet). The read below therefore
 * serves only pending rows ABOVE the scan cursor, so no event is ever listed
 * twice.
 *
 * WHAT A READER IS TOLD. `pending_activity_window` records what the last read
 * covered. The API serves the lane only while that read is recent
 * (`PENDING_STALE_SEC`), and says whether it reached the chain's latest block
 * and kept every event it found. A stale, missing or unreadable lane is served
 * as `null` — NOT KNOWN — never as an empty list, which would claim there is
 * nothing pending.
 *
 * Pending rows carry no block time: the lane does not read block headers (it
 * would cost a request per block), and the time of a block that may still be
 * replaced is not worth stating. They carry the block hash instead.
 */

/** The most blocks above the safe block one pass reads. Every chain this
 *  platform scans keeps its safe block within a few hundred blocks of the
 *  latest in normal operation; a wider gap is read up to this bound and the
 *  lane says it is incomplete. One `eth_getLogs` call (the scan's own chunk
 *  is 5,000 blocks, which every provider in use accepts). */
export const PENDING_MAX_BLOCKS = 2_000n;

/** The most events one pass keeps. The rows are written in ONE statement
 *  (a JSON array through `json_each`), so this bounds that statement's size,
 *  not the number of D1 queries. The earliest events are kept, so the lane is
 *  a complete prefix of the pending range and says it is truncated. */
export const PENDING_MAX_ROWS = 100;

/** How long after its read the lane is still served. A pass refreshes it about
 *  once a minute per chain; a lane older than this means passes have stopped
 *  refreshing it (held, failing, or behind), and its rows may describe blocks
 *  that have since changed. */
export const PENDING_STALE_SEC = 300;

/** One pending event, as written. Field names match `activity_events`. */
export interface PendingEventRow {
  blockNumber: number;
  logIndex: number;
  blockHash: string;
  txHash: string;
  kind: string;
  loanId: number | null;
  offerId: number | null;
  actor: string | null;
  argsJson: string;
  asset: string | null;
  assetType: number | null;
  amount: string | null;
  amountMax: string | null;
  tokenId: string | null;
  quantity: string | null;
}

/** What one read covered. */
export interface PendingWindow {
  /** The scan cursor: events at or below it are final. */
  finalThrough: number;
  /** The last block read. */
  throughBlock: number;
  /** The chain's latest block when the read was made. */
  latestBlock: number;
  /** True when the read stopped below `latestBlock` or kept only the first
   *  `PENDING_MAX_ROWS` events. */
  truncated: boolean;
}

/** Which events a set of rows is: position and block hash, in order. Two reads
 *  that found the same events in the same blocks have the same fingerprint. */
export function pendingFingerprint(rows: readonly PendingEventRow[]): string {
  return rows.map((r) => `${r.blockNumber}:${r.logIndex}:${r.blockHash.toLowerCase()}`).join(',');
}

/**
 * Replace a chain's pending rows and record the window, in ONE `batch()` (one
 * round trip, four statements, applied as one transaction). The first
 * statement reads the previous fingerprint before anything changes, so the
 * caller learns whether the lane changed — and can announce it — without a
 * separate read.
 */
export async function writePendingLane(
  db: D1Database,
  chainId: number,
  rows: readonly PendingEventRow[],
  window: PendingWindow,
  nowSec: number,
): Promise<{ changed: boolean }> {
  const fingerprint = pendingFingerprint(rows);
  const results = await db.batch([
    db.prepare(`SELECT fingerprint FROM pending_activity_window WHERE chain_id = ?`).bind(chainId),
    db.prepare(`DELETE FROM pending_activity_events WHERE chain_id = ?`).bind(chainId),
    db
      .prepare(
        `INSERT INTO pending_activity_events
           (chain_id, block_number, log_index, block_hash, tx_hash, kind,
            loan_id, offer_id, actor, args_json,
            asset, asset_type, amount, amount_max, token_id, quantity)
         SELECT ?,
                json_extract(value, '$.blockNumber'), json_extract(value, '$.logIndex'),
                json_extract(value, '$.blockHash'), json_extract(value, '$.txHash'),
                json_extract(value, '$.kind'),
                json_extract(value, '$.loanId'), json_extract(value, '$.offerId'),
                json_extract(value, '$.actor'), json_extract(value, '$.argsJson'),
                json_extract(value, '$.asset'), json_extract(value, '$.assetType'),
                json_extract(value, '$.amount'), json_extract(value, '$.amountMax'),
                json_extract(value, '$.tokenId'), json_extract(value, '$.quantity')
           FROM json_each(?)`,
      )
      .bind(chainId, JSON.stringify(rows)),
    db
      .prepare(
        `INSERT INTO pending_activity_window
           (chain_id, final_through, through_block, latest_block, truncated, fingerprint, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET
           final_through = excluded.final_through,
           through_block = excluded.through_block,
           latest_block  = excluded.latest_block,
           truncated     = excluded.truncated,
           fingerprint   = excluded.fingerprint,
           read_at       = excluded.read_at`,
      )
      .bind(
        chainId,
        window.finalThrough,
        window.throughBlock,
        window.latestBlock,
        window.truncated ? 1 : 0,
        fingerprint,
        nowSec,
      ),
  ]);
  const previous = (results[0]?.results?.[0] as { fingerprint?: string } | undefined)?.fingerprint;
  // No previous window (the first read) counts as a change only if there is
  // something to show; an empty first read announces nothing.
  return { changed: previous === undefined ? rows.length > 0 : previous !== fingerprint };
}

/** A pending row as read back. */
interface PendingRowDb {
  chain_id: number;
  block_number: number;
  log_index: number;
  block_hash: string;
  tx_hash: string;
  kind: string;
  loan_id: number | null;
  offer_id: number | null;
  actor: string | null;
  args_json: string;
  asset: string | null;
  asset_type: number | null;
  amount: string | null;
  amount_max: string | null;
  token_id: string | null;
  quantity: string | null;
}

interface PendingWindowDb {
  final_through: number;
  through_block: number;
  latest_block: number;
  truncated: number;
  read_at: number;
}

/** The filters `/activity` applies, as SQL over the columns both tables share. */
export interface PendingFilter {
  where: string[];
  binds: (string | number)[];
}

/** The lane as served: the events, newest first, and what the read covered. */
export interface PendingLaneJson {
  events: Record<string, unknown>[];
  finalThrough: number;
  throughBlock: number;
  latestBlock: number;
  readAt: number;
  /** False when the read did not reach the chain's latest block, kept only
   *  the first events it found, or the request's limit cut matching events. */
  complete: boolean;
}

/**
 * Read the lane for `/activity`. `null` = NOT KNOWN: no read yet, a read older
 * than `PENDING_STALE_SEC`, or a database that predates migration 0090. Never
 * an empty list in those cases — an empty list states that nothing is pending.
 *
 * Only rows above the scan cursor are served (see the module note): a row the
 * scan has already written is in the final feed, and listing it here as well
 * would show one event twice.
 */
export async function readPendingLane(
  db: D1Database,
  chainId: number,
  cursorKind: string,
  filter: PendingFilter,
  limit: number,
  nowSec: number,
): Promise<PendingLaneJson | null> {
  const [windowRes, rowsRes] = await db.batch([
    db
      .prepare(
        `SELECT final_through, through_block, latest_block, truncated, read_at
           FROM pending_activity_window WHERE chain_id = ?`,
      )
      .bind(chainId),
    db
      .prepare(
        `SELECT * FROM pending_activity_events
          WHERE chain_id = ?
            AND block_number > COALESCE(
                  (SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?), -1)
            ${filter.where.map((w) => `AND ${w}`).join(' ')}
          ORDER BY block_number DESC, log_index DESC
          LIMIT ?`,
      )
      // One row past the limit, so a cut the limit makes is known and stated.
      .bind(chainId, chainId, cursorKind, ...filter.binds, limit + 1),
  ]);
  const window = windowRes?.results?.[0] as PendingWindowDb | undefined;
  if (!window) return null;
  if (nowSec - window.read_at > PENDING_STALE_SEC) return null;
  const matched = (rowsRes?.results ?? []) as PendingRowDb[];
  // The lane is served on the first page only, so rows the limit cuts can be
  // reached no other way: the answer must say it is incomplete (Codex #3557 r1).
  const cutByLimit = matched.length > limit;
  const rows = cutByLimit ? matched.slice(0, limit) : matched;
  return {
    events: rows.map(pendingToJson),
    finalThrough: window.final_through,
    throughBlock: window.through_block,
    latestBlock: window.latest_block,
    readAt: window.read_at,
    complete: !cutByLimit && window.truncated === 0 && window.through_block >= window.latest_block,
  };
}

function pendingToJson(row: PendingRowDb): Record<string, unknown> {
  let args: unknown = null;
  try {
    args = JSON.parse(row.args_json);
  } catch {
    args = row.args_json;
  }
  return {
    chainId: row.chain_id,
    blockNumber: row.block_number,
    logIndex: row.log_index,
    blockHash: row.block_hash,
    txHash: row.tx_hash,
    kind: row.kind,
    loanId: row.loan_id,
    offerId: row.offer_id,
    actor: row.actor,
    args,
    // Not read for a block that may still be replaced (see the module note).
    blockAt: null,
    final: false,
    asset: row.asset ?? null,
    assetType: row.asset_type ?? null,
    amount: row.amount ?? null,
    amountMax: row.amount_max ?? null,
    tokenId: row.token_id ?? null,
    quantity: row.quantity ?? null,
  };
}
