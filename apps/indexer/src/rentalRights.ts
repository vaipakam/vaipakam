/**
 * #3882 — the table of rental rights (ProjectKitDesign.md §6 and §12).
 *
 * One answer a project needs: who may use this item now, and until when.
 * The authority is the platform's own record, the owner's vault and the
 * Diamond's `VaultRentalUpdated` event, which fires on every rental step for
 * ERC-721 and ERC-1155 items alike. This module folds that event into
 * `rental_rights` (migration 0119), one row per rental keyed by its loan id,
 * so concurrent ERC-1155 rentals of one token stay apart.
 *
 * WRITE RULE. An update lands only when its (block, log index) is later than
 * the row's, so a re-scan of an overlapping range or an out-of-order batch
 * never puts an older state back. A clearing (zero user and quantity) keeps
 * the row with quantity '0'. The scan's hook and the one-time seed from
 * recorded history (`seedRentalRights`) both write through it; nothing else
 * writes the table, and it reads
 * nothing but the event, so it is replay-derived: a rebuild or a new
 * deployment clears it with the chain's other rows and the replay writes it
 * again (deploymentEpoch.ts).
 *
 * ACTIVE. A row is active while its quantity is not '0' and its expiry is
 * not before the time asked about: the vault's own comparison
 * (`expires >= block.timestamp`). An expiry fires no event, so a row stops
 * being active by time alone; `isActiveRental` is the one statement of that.
 */

import type { Env } from './env';
import type { Cost } from './subrequestBudget';

/** The decoded log fields this module reads. */
export interface RentalLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
}

/** One row as `rental_rights` stores it. */
export interface RentalRightRow {
  loanId: number;
  collection: string;
  tokenId: string;
  owner: string;
  user: string;
  expires: number;
  quantity: string;
  blockNumber: number;
  logIndex: number;
}

/** The largest expiry stored. The event's expiry is a uint64, but it passes
 *  through a JS number on its way to D1, which is exact only to 2^53 - 1
 *  (about 285 million years of seconds). A later expiry is held at that
 *  value, which every read still treats as "has not expired". */
export const MAX_STORED_EXPIRY = BigInt(Number.MAX_SAFE_INTEGER);

/** The rows the scan's `VaultRentalUpdated` events describe, in chain order. */
export function rentalRightRows(logs: readonly RentalLog[]): RentalRightRow[] {
  const out: RentalRightRow[] = [];
  for (const log of logs) {
    if (log.eventName !== 'VaultRentalUpdated') continue;
    const a = log.args;
    const expires = BigInt(a.expires as bigint);
    out.push({
      loanId: Number(a.loanId as bigint),
      collection: String(a.nftContract).toLowerCase(),
      tokenId: BigInt(a.tokenId as bigint).toString(),
      owner: String(a.lender).toLowerCase(),
      user: String(a.user).toLowerCase(),
      expires: Number(expires > MAX_STORED_EXPIRY ? MAX_STORED_EXPIRY : expires),
      quantity: BigInt(a.quantity as bigint).toString(),
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex,
    });
  }
  out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  return out;
}

/**
 * Whether a stored rental gives its user a right at `at` (unix seconds), by
 * the vault's own comparison: still the user while `expires >= at`.
 */
export function isActiveRental(row: { quantity: string; expires: number }, at: number): boolean {
  return row.quantity !== '0' && row.expires >= at;
}

/**
 * The time a rental read judges "active" at: the later of the server's clock
 * and the chain time the index holds (the latest block time it recorded at or
 * below `asOf`). A server clock running behind the chain therefore cannot
 * show a rental the chain already treats as ended. The answer can say
 * "ended" a few seconds before the chain's newest block does, which is the
 * safe side.
 */
export function rentalActiveAt(serverNow: number, chainTime: number | null): number {
  return Math.max(Math.floor(serverNow), chainTime ?? 0);
}

interface Statement {
  bind(...values: unknown[]): Statement;
}
export interface RentalDb {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

/**
 * The one write: every row of a list in ONE statement (the rows travel as one
 * bound JSON array, read back through `json_each`), each inserted, or
 * replacing a stored row only when it is a later update. One statement per
 * list, whatever its length, so a busy scan or a seed page costs one D1 query
 * rather than one per event. `json_each` hands the rows over in array order,
 * and the later-update rule makes that order irrelevant anyway.
 */
const UPSERT_ROWS = `INSERT INTO rental_rights
    (chain_id, loan_id, collection, token_id, owner, user, expires, quantity,
     block_number, log_index, updated_at)
  SELECT ?,
         json_extract(value, '$.loanId'), json_extract(value, '$.collection'),
         json_extract(value, '$.tokenId'), json_extract(value, '$.owner'),
         json_extract(value, '$.user'), json_extract(value, '$.expires'),
         json_extract(value, '$.quantity'), json_extract(value, '$.blockNumber'),
         json_extract(value, '$.logIndex'), ?
    FROM json_each(?) WHERE true
  ON CONFLICT (chain_id, loan_id) DO UPDATE SET
    collection = excluded.collection, token_id = excluded.token_id,
    owner = excluded.owner, user = excluded.user, expires = excluded.expires,
    quantity = excluded.quantity, block_number = excluded.block_number,
    log_index = excluded.log_index, updated_at = excluded.updated_at
  WHERE excluded.block_number > rental_rights.block_number
     OR (excluded.block_number = rental_rights.block_number
         AND excluded.log_index > rental_rights.log_index)`;

function upsertRows(db: RentalDb, chainId: number, rows: readonly RentalRightRow[], now: number): Statement {
  return db.prepare(UPSERT_ROWS).bind(chainId, now, JSON.stringify(rows));
}

/**
 * Fold one scan's rental events into `rental_rights` in one statement, so a
 * failure leaves either every update or none. Returns the rows written.
 */
export async function recordRentalRights(
  db: RentalDb,
  chainId: number,
  logs: readonly RentalLog[],
  now: number,
): Promise<number> {
  const rows = rentalRightRows(logs);
  if (rows.length === 0) return 0;
  await db.batch([upsertRows(db, chainId, rows, now)]);
  return rows.length;
}

/** The cursor kind that marks a chain's rental table as seeded from history. */
export const RENTAL_SEED_CURSOR_KIND = 'rental_rights_seed';
/** The cursor kind that holds a seed's progress between passes: the last
 *  block whose rental events have all been replayed. Removed when the seed
 *  completes, in the same batch as the mark. */
export const RENTAL_SEED_PROGRESS_KIND = 'rental_rights_seed_progress';
/** Rental events replayed in one pass at most. */
export const RENTAL_SEED_PAGE = 500;
/**
 * What one seed pass costs the invocation, at most: the state read, the page
 * read, and then either one more read (when a whole page falls in one block)
 * and a write batch of the rows and the progress, or, on the last step, a
 * batch of the rows, the mark and the removal of the progress. The caller
 * starts a pass only when this, and what the rest of its pass needs, is
 * affordable.
 */
export const RENTAL_SEED_PASS_COST: Cost = { external: 0, d1Queries: 5 };

/** What one call did: nothing (already seeded), one bounded step, or the
 *  final step that wrote the mark. */
export type RentalSeedStep =
  | { state: 'seeded' }
  | { state: 'progress'; replayed: number; through: number }
  | { state: 'done'; replayed: number };

interface SeedEventRow {
  block_number: number;
  log_index: number;
  args_json: string;
}

/**
 * Seed `rental_rights` from the rental events the indexer already recorded
 * (`activity_events`), up to the scan cursor `through`, one bounded step per
 * call.
 *
 * WHY. The table arrives on chains the indexer has already scanned, and the
 * scan resumes past the blocks that carried the existing rentals, so its hook
 * alone would leave every earlier rental out until that rental's next update.
 * The seed replays those events through the same mapping and the same
 * later-update-wins write as the hook, so the order of the two never matters.
 * Blocks above `through` are the scan's: this pass and later ones feed them
 * to the hook.
 *
 * BOUNDED AND RESUMABLE (Codex #3908 r2). One call replays at most one page
 * of events (`RENTAL_SEED_PAGE`) in at most `RENTAL_SEED_PASS_COST` D1
 * queries, and writes the rows together with its progress: the last block
 * whose events are all replayed. A page that ends inside a block gives that
 * block back to the next call, so progress is always a whole block; a page
 * that lies entirely inside one block reads that block whole. The next call
 * resumes after the progress, a failed call resumes where the last good one
 * stopped, and replaying a block twice is harmless under the write rule. The
 * mark is written only by the call that reaches `through`, in the same batch
 * as its rows, and the progress row goes with it.
 *
 * Until the mark is written the rental reads answer 503 rather than an
 * apparently complete list (`rentalRoutes.ts`). A new deployment epoch clears
 * the mark and the progress with the chain's other rows, and the seed then
 * runs over the cleared history.
 */
export async function seedRentalRights(
  db: Env['DB'],
  chainId: number,
  through: number,
  now: number,
): Promise<RentalSeedStep> {
  const state = await db
    .prepare('SELECT kind, last_block FROM indexer_cursor WHERE chain_id = ? AND kind IN (?, ?)')
    .bind(chainId, RENTAL_SEED_CURSOR_KIND, RENTAL_SEED_PROGRESS_KIND)
    .all<{ kind: string; last_block: number }>();
  const marks = state.results ?? [];
  if (marks.some((m) => m.kind === RENTAL_SEED_CURSOR_KIND)) return { state: 'seeded' };
  const progressRow = marks.find((m) => m.kind === RENTAL_SEED_PROGRESS_KIND);
  const after = progressRow?.last_block ?? -1;

  const page =
    (
      await db
        .prepare(
          `SELECT block_number, log_index, args_json FROM activity_events
            WHERE chain_id = ? AND kind = 'VaultRentalUpdated' AND block_number > ? AND block_number <= ?
            ORDER BY block_number, log_index
            LIMIT ?`,
        )
        .bind(chainId, after, through, RENTAL_SEED_PAGE)
        .all<SeedEventRow>()
    ).results ?? [];
  const done = page.length < RENTAL_SEED_PAGE;
  let rows = page;
  let reached = through;
  if (!done) {
    const last = page[page.length - 1].block_number;
    rows = page.filter((r) => r.block_number < last);
    if (rows.length === 0) {
      rows =
        (
          await db
            .prepare(
              `SELECT block_number, log_index, args_json FROM activity_events
                WHERE chain_id = ? AND kind = 'VaultRentalUpdated' AND block_number = ?
                ORDER BY log_index`,
            )
            .bind(chainId, last)
            .all<SeedEventRow>()
        ).results ?? [];
    }
    reached = rows[rows.length - 1].block_number;
  }

  const mapped = rentalRightRows(
    rows.map((r) => ({
      eventName: 'VaultRentalUpdated',
      args: JSON.parse(r.args_json) as Record<string, unknown>,
      blockNumber: BigInt(r.block_number),
      logIndex: r.log_index,
    })),
  );
  const writes: D1PreparedStatement[] =
    mapped.length > 0 ? [upsertRows(db as unknown as RentalDb, chainId, mapped, now) as unknown as D1PreparedStatement] : [];
  if (done) {
    writes.push(
      db
        .prepare(
          `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (chain_id, kind) DO NOTHING`,
        )
        .bind(chainId, RENTAL_SEED_CURSOR_KIND, through, now),
    );
    if (progressRow) {
      writes.push(
        db.prepare('DELETE FROM indexer_cursor WHERE chain_id = ? AND kind = ?').bind(chainId, RENTAL_SEED_PROGRESS_KIND),
      );
    }
  } else {
    writes.push(
      db
        .prepare(
          `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (chain_id, kind) DO UPDATE SET
             last_block = excluded.last_block, updated_at = excluded.updated_at
           WHERE excluded.last_block > indexer_cursor.last_block`,
        )
        .bind(chainId, RENTAL_SEED_PROGRESS_KIND, reached, now),
    );
  }
  await db.batch(writes);
  return done ? { state: 'done', replayed: rows.length } : { state: 'progress', replayed: rows.length, through: reached };
}
