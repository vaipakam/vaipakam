/**
 * The loan-clock inputs the indexer snapshots in the shared D1 (#2808): the
 * grace schedule (`protocol_config.grace_buckets_json`) and the pause-interval
 * log (`protocol_config.pause_intervals_json`, migration 0072), read at the
 * same block by the indexer's config refresh. ONE reader for every Worker that
 * computes a loan deadline from D1 (the indexer's loan routes, the agent's
 * periodic-interest reminders), so none of them parses the row its own way.
 *
 * Every state that is not a well-formed pair is UNKNOWN, and is reported as
 * such rather than defaulted: no row, a column never populated, a column the
 * refresh cleared after a pause or grace event it could not re-read, a value
 * that does not parse, or a database whose schema predates the column (HTTP
 * handlers run ahead of the schema gate). An empty grace array and an empty
 * pause log are not unknown: they are the chain's definitive "no buckets" and
 * "never paused" (or a Diamond without the loan clock).
 */
import { pauseLogFromJson, type GraceBucket, type PauseLog } from './loanClock';

/** The narrow D1 surface the reader needs. */
export interface D1FirstLike {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
  };
}

export interface LoanClockSnapshot {
  graceBuckets: readonly GraceBucket[];
  pauseLog: PauseLog;
  /** The block both were read at. */
  sourceBlock: number;
}

export type LoanClockSnapshotRead =
  | { known: true; snapshot: LoanClockSnapshot }
  | {
      known: false;
      /** Why, for a log line or a served reason: `no-row` (the chain has no
       *  snapshot yet), `grace-unread` / `pause-log-unread` (that column is
       *  NULL), `damaged` (a column does not parse), `pre-migration` (this
       *  database has no pause-log column yet). */
      reason: 'no-row' | 'grace-unread' | 'pause-log-unread' | 'damaged' | 'pre-migration';
    };

/** Parse the stored grace schedule — decimal strings, as the snapshot writes
 *  them. Null when it is not an array of two non-negative integers each. */
export function graceBucketsFromJson(json: unknown): GraceBucket[] | null {
  if (!Array.isArray(json)) return null;
  const out: GraceBucket[] = [];
  for (const e of json) {
    if (typeof e !== 'object' || e === null) return null;
    const { maxDurationDays, graceSeconds } = e as Record<string, unknown>;
    if (![maxDurationDays, graceSeconds].every((v) => typeof v === 'string' && /^\d+$/.test(v))) {
      return null;
    }
    out.push({
      maxDurationDays: BigInt(maxDurationDays as string),
      graceSeconds: BigInt(graceSeconds as string),
    });
  }
  return out;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function readLoanClockSnapshot(
  db: D1FirstLike,
  chainId: number,
): Promise<LoanClockSnapshotRead> {
  let row: {
    grace_buckets_json: string | null;
    pause_intervals_json: string | null;
    source_block: number;
  } | null;
  try {
    row = await db
      .prepare(
        `SELECT grace_buckets_json, pause_intervals_json, source_block
         FROM protocol_config WHERE chain_id = ?`,
      )
      .bind(chainId)
      .first();
  } catch (err) {
    if (/no such column/i.test(String(err))) return { known: false, reason: 'pre-migration' };
    throw err;
  }
  if (!row) return { known: false, reason: 'no-row' };
  if (row.grace_buckets_json === null) return { known: false, reason: 'grace-unread' };
  if (row.pause_intervals_json === null) return { known: false, reason: 'pause-log-unread' };
  const graceBuckets = graceBucketsFromJson(parse(row.grace_buckets_json));
  const pauseLog = pauseLogFromJson(parse(row.pause_intervals_json));
  if (graceBuckets === null || pauseLog === null) return { known: false, reason: 'damaged' };
  return { known: true, snapshot: { graceBuckets, pauseLog, sourceBlock: row.source_block } };
}
