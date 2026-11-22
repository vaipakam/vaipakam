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
 * the row with quantity '0'. Nothing else writes the table, and it reads
 * nothing but the event, so it is replay-derived: a rebuild or a new
 * deployment clears it with the chain's other rows and the replay writes it
 * again (deploymentEpoch.ts).
 *
 * ACTIVE. A row is active while its quantity is not '0' and its expiry is
 * after the time asked about. An expiry fires no event, so a row stops being
 * active by time alone; `isActiveRental` is the one statement of that.
 */

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

/** Whether a stored rental gives its user a right at `at` (unix seconds). */
export function isActiveRental(row: { quantity: string; expires: number }, at: number): boolean {
  return row.quantity !== '0' && row.expires > at;
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
