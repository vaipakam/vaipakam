/**
 * #3677 — one wallet's activity, answered by the server.
 *
 * `/activity` used to have no wallet filter, so a client paged the whole
 * chain's feed and kept the rows that were the wallet's: on a busy chain a
 * quiet wallet's rows are sparse among everyone else's, and the client could
 * only promise "recent activity". This module keeps the index that lets the
 * route answer for a wallet directly, from two legs:
 *
 *  - the events on any loan the wallet ever held a position in, read through
 *    `loan_participants` (#1130, append-only participation history); and
 *  - the events that name the wallet as a participant, by the ONE shared rule
 *    (`@vaipakam/lib/activityParticipants`, #2703), recorded per event in
 *    `activity_participants` at ingest and, for history ingested before the
 *    table existed, by the one-time backfill below.
 *
 * Until that backfill has read past the newest stored event, the second leg
 * is missing older rows, and the route says so (`walletComplete: false`)
 * rather than presenting the narrower list as the wallet's whole history.
 */
import { activityParticipants } from '@vaipakam/lib/activityParticipants';
import type { Env } from './env';

/** Rows the backfill reads per pass: one SELECT and one batched write. */
export const PARTICIPANT_BACKFILL_PAGE = 500;

/** The wallets one event concerns: the shared rule's participants, and the
 *  row's stored actor (the same rule files it, so this only guards a row the
 *  rule would otherwise miss). Lower-cased, de-duplicated. */
export function eventParticipants(kind: string, args: Record<string, unknown>, actor: string | null): string[] {
  const out = new Set(activityParticipants(kind, args));
  if (actor && /^0x[0-9a-fA-F]{40}$/.test(actor) && !/^0x0{40}$/.test(actor)) out.add(actor.toLowerCase());
  return [...out];
}

/** The pending lane's inline form: ' 0xabc… 0xdef… ', matched with LIKE
 *  '% 0xabc… %'. NULL when the event names nobody. */
export function inlineParticipants(wallets: readonly string[]): string | null {
  return wallets.length === 0 ? null : ` ${wallets.join(' ')} `;
}

/** The statements recording one event's participants. Idempotent, so a
 *  re-scan or the backfill meeting a row ingest already wrote changes nothing. */
export function participantStatements(
  db: D1Database,
  chainId: number,
  blockNumber: number,
  logIndex: number,
  wallets: readonly string[],
): D1PreparedStatement[] {
  return wallets.map((w) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO activity_participants (chain_id, block_number, log_index, wallet)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(chainId, blockNumber, logIndex, w),
  );
}

/** Run statements in batches D1 accepts. */
export async function runBatched(db: D1Database, statements: D1PreparedStatement[], size = 50): Promise<void> {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}

interface StoredEvent {
  block_number: number;
  log_index: number;
  kind: string;
  actor: string | null;
  args_json: string;
}

/**
 * Fill `activity_participants` from the events already stored, one bounded
 * page per call, oldest first, and record how far it got. Cheap once done
 * (one SELECT). Reads D1 only, so it runs before every return of the chain
 * pass, beside the other one-time backfills.
 */
export async function ensureActivityParticipantsBackfill(env: Env, chainId: number): Promise<void> {
  const state = await env.DB.prepare(
    `SELECT through_block, through_log, done FROM activity_participants_state WHERE chain_id = ?`,
  )
    .bind(chainId)
    .first<{ through_block: number; through_log: number; done: number }>();
  if (state?.done) return;
  const fromBlock = state?.through_block ?? -1;
  const fromLog = state?.through_log ?? -1;
  const page = await env.DB.prepare(
    `SELECT block_number, log_index, kind, actor, args_json
       FROM activity_events
      WHERE chain_id = ? AND (block_number, log_index) > (?, ?)
      ORDER BY block_number ASC, log_index ASC
      LIMIT ?`,
  )
    .bind(chainId, fromBlock, fromLog, PARTICIPANT_BACKFILL_PAGE)
    .all<StoredEvent>();
  const rows = page.results ?? [];
  const statements: D1PreparedStatement[] = [];
  for (const r of rows) {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(r.args_json);
      if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      // A malformed row still gets its actor; its args name nobody.
    }
    statements.push(...participantStatements(env.DB, chainId, r.block_number, r.log_index, eventParticipants(r.kind, args, r.actor)));
  }
  await runBatched(env.DB, statements);
  const last = rows[rows.length - 1];
  // Done once a page comes back short: every stored event has been read, and
  // every event stored from now on gets its participants at ingest.
  const done = rows.length < PARTICIPANT_BACKFILL_PAGE ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO activity_participants_state (chain_id, through_block, through_log, done)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (chain_id) DO UPDATE SET
       through_block = excluded.through_block,
       through_log   = excluded.through_log,
       done          = excluded.done`,
  )
    .bind(chainId, last?.block_number ?? fromBlock, last?.log_index ?? fromLog, done)
    .run();
}

/** Whether every stored event's participants are recorded. `false` while the
 *  backfill is still reading; `null` when it could not be read (a database
 *  that predates migration 0095, or a failed read). */
export async function walletActivityComplete(db: D1Database, chainId: number): Promise<boolean | null> {
  try {
    const row = await db
      .prepare(`SELECT done FROM activity_participants_state WHERE chain_id = ?`)
      .bind(chainId)
      .first<{ done: number }>();
    return row?.done === 1;
  } catch {
    return null;
  }
}

/** The wallet's loans, as a SQL condition on a table carrying `loan_id`. */
export const WALLET_LOAN_CONDITION = `loan_id IN (SELECT lp.loan_id FROM loan_participants lp WHERE lp.chain_id = ? AND lp.wallet = ?)`;

/**
 * One page of the wallet's final events, newest first: the union of the two
 * legs, each read to the page's limit on its own index, then joined back to
 * the event rows. Each leg returns at most `limit` keys below the cursor, so
 * the union's top `limit` is exact.
 */
export function walletEventsPage(
  db: D1Database,
  chainId: number,
  wallet: string,
  before: { block: number; logIndex: number } | undefined,
  limit: number,
): D1PreparedStatement {
  const b = before ?? null;
  return db
    .prepare(
      `WITH keys AS (
         SELECT block_number, log_index FROM (
           SELECT block_number, log_index FROM activity_participants
            WHERE chain_id = ?1 AND wallet = ?2
              AND (?3 IS NULL OR (block_number, log_index) < (?3, ?4))
            ORDER BY block_number DESC, log_index DESC
            LIMIT ?5)
         UNION
         SELECT block_number, log_index FROM (
           SELECT block_number, log_index FROM activity_events
            WHERE chain_id = ?1
              AND loan_id IN (SELECT lp.loan_id FROM loan_participants lp WHERE lp.chain_id = ?1 AND lp.wallet = ?2)
              AND (?3 IS NULL OR (block_number, log_index) < (?3, ?4))
            ORDER BY block_number DESC, log_index DESC
            LIMIT ?5)
       )
       SELECT e.* FROM activity_events e
         JOIN keys k ON k.block_number = e.block_number AND k.log_index = e.log_index
        WHERE e.chain_id = ?1
        ORDER BY e.block_number DESC, e.log_index DESC
        LIMIT ?5`,
    )
    .bind(chainId, wallet, b?.block ?? null, b?.logIndex ?? null, limit);
}
