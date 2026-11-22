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

/** The one write: insert, or replace a row only with a later update. */
const UPSERT = `INSERT INTO rental_rights
    (chain_id, loan_id, collection, token_id, owner, user, expires, quantity,
     block_number, log_index, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (chain_id, loan_id) DO UPDATE SET
    collection = excluded.collection, token_id = excluded.token_id,
    owner = excluded.owner, user = excluded.user, expires = excluded.expires,
    quantity = excluded.quantity, block_number = excluded.block_number,
    log_index = excluded.log_index, updated_at = excluded.updated_at
  WHERE excluded.block_number > rental_rights.block_number
     OR (excluded.block_number = rental_rights.block_number
         AND excluded.log_index > rental_rights.log_index)`;

/**
 * Fold one scan's rental events into `rental_rights`, all in ONE batch so a
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
  await db.batch(
    rows.map((r) =>
      db
        .prepare(UPSERT)
        .bind(
          chainId,
          r.loanId,
          r.collection,
          r.tokenId,
          r.owner,
          r.user,
          r.expires,
          r.quantity,
          r.blockNumber,
          r.logIndex,
          now,
        ),
    ),
  );
  return rows.length;
}

/** The cursor kind that marks a chain's rental table as seeded from history. */
export const RENTAL_SEED_CURSOR_KIND = 'rental_rights_seed';
/** Rows read per page while seeding. */
const SEED_PAGE = 500;


/**
 * Seed `rental_rights` once per chain from the rental events the indexer
 * already recorded (`activity_events`), up to the scan cursor `through`.
 *
 * WHY. The table arrives on chains the indexer has already scanned, and the
 * scan resumes past the blocks that carried the existing rentals, so its hook
 * alone would leave every earlier rental out until that rental's next update.
 * The seed replays those events through the same mapping and the same
 * later-update-wins write as the hook, so the order of the two never matters.
 * Blocks above `through` are the scan's: this pass and later ones feed them
 * to the hook.
 *
 * Until the mark is written the rental reads answer 503 rather than an
 * apparently complete list (`rentalRoutes.ts`). A failure part-way leaves no
 * mark, and the next pass seeds again; the write rule makes that harmless. A
 * new deployment epoch clears the mark with the chain's other rows, and the
 * seed then runs over the cleared history.
 *
 * Returns the number of events replayed, or null when the chain was already
 * seeded.
 */
export async function seedRentalRights(
  db: Env['DB'],
  chainId: number,
  through: number,
  now: number,
): Promise<number | null> {
  const done = await db
    .prepare('SELECT 1 AS seeded FROM indexer_cursor WHERE chain_id = ? AND kind = ?')
    .bind(chainId, RENTAL_SEED_CURSOR_KIND)
    .first<{ seeded: number }>();
  if (done) return null;
  let replayed = 0;
  let afterBlock = -1;
  let afterLog = -1;
  for (;;) {
    const page = await db
      .prepare(
        `SELECT block_number, log_index, args_json FROM activity_events
          WHERE chain_id = ? AND kind = 'VaultRentalUpdated' AND block_number <= ?
            AND (block_number > ? OR (block_number = ? AND log_index > ?))
          ORDER BY block_number, log_index
          LIMIT ?`,
      )
      .bind(chainId, through, afterBlock, afterBlock, afterLog, SEED_PAGE)
      .all<{ block_number: number; log_index: number; args_json: string }>();
    const rows = page.results ?? [];
    const logs: RentalLog[] = rows.map((r) => ({
      eventName: 'VaultRentalUpdated',
      args: JSON.parse(r.args_json) as Record<string, unknown>,
      blockNumber: BigInt(r.block_number),
      logIndex: r.log_index,
    }));
    await recordRentalRights(db as unknown as RentalDb, chainId, logs, now);
    replayed += rows.length;
    if (rows.length < SEED_PAGE) break;
    afterBlock = rows[rows.length - 1].block_number;
    afterLog = rows[rows.length - 1].log_index;
  }
  await db
    .prepare(
      `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (chain_id, kind) DO NOTHING`,
    )
    .bind(chainId, RENTAL_SEED_CURSOR_KIND, through, now)
    .run();
  return replayed;
}
