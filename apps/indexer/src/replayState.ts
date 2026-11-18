/**
 * Whether a chain's index is REPLAYING, and how far it is behind the chain's
 * safe head (#3411 follow-up, row 3.9).
 *
 * WHY. Two events clear a chain's rows and replay them from the deploy
 * block: adopting a deployment (`deploymentEpoch.ts`, the first adoption
 * included) and the reorg guard's rebuild (`reorgGuard.ts`). Until the replay
 * reaches the safe head, every list and position status the indexer serves for
 * that chain is partial. A loan can be missing, an offer can show as open when
 * it was filled long ago, and a repaid loan can still show as active. The
 * cursor's AGE does not reveal this: a replay scans every few seconds, so its
 * age stays small, and a reader that judged freshness by age called a
 * half-built index fresh.
 *
 * WHERE IT IS SAID. `/health/ingest` states it per chain (`replay`), and every
 * chain-keyed read states it for its chain (`ingest`, replayEnvelope.ts). So the index says it is replaying, says why, and
 * states the gap in blocks.
 *
 * THE LATCH. `indexer_deployment.replay_reason` is set by the write that
 * starts the replay (the adoption, the Diamond-change claim, the rebuild
 * request), in the same statement, and is cleared only by
 * {@link chainHeadStatement}, which every settled pass runs: in its cursor
 * write's batch when it scanned, on its own when it was already caught up.
 * It clears once a settled pass finds the cursor
 * within {@link REPLAY_CAUGHT_UP_BLOCKS} of the safe head, and never while
 * a reset is still pending. After that, ordinary lag (a slow provider, a
 * held tick) is reported as lag. It is not called a replay, because the rows
 * were complete up to the cursor all along.
 *
 * WHAT IS UNKNOWN IS SAID TO BE UNKNOWN.
 *  - No settled head read: the pass records the head as NULL, and the lag
 *    is null (unknown), never 0.
 *  - No cursor yet (a reset just cleared it): the lag is null.
 *  - No deployment record, or a database without migration 0097: `replaying`
 *    is null (unknown), not false.
 *
 * The safe head lives on the deployment record, not in a chain-scoped table,
 * so it costs the pass one statement and survives the resets it is read
 * against.
 *
 * Read paths run on every request and must tolerate the previous schema
 * (CLAUDE.md, D1 schema discipline). So the read treats a missing 0097
 * column as "unknown", never as an error and never as "not
 * replaying".
 */
import { REPLAY_DEPLOYMENT, REPLAY_REBUILD, RESET_REBUILD, type ReplayReason } from './deploymentEpoch';
import { redactedError } from '@vaipakam/lib/errorDescription';

/**
 * How close to the safe head the cursor must come for a replay to count as
 * caught up: one scan pass's window, so the NEXT pass reaches the head. It is
 * the same cut the ingest alarm uses to call a pass a backlog pass
 * (`chainIngestDO.shouldRearmForBacklog`). It is pinned equal to
 * `SCAN_PASS_MAX_BLOCKS` by test. It is not imported from there, because
 * `chainIndexer.ts` imports this module.
 */
export const REPLAY_CAUGHT_UP_BLOCKS = 2000;

/** The cursor kind of the diamond scan (`chainIndexer.CURSOR_KIND`, pinned by test). */
const SCAN_CURSOR_KIND = 'diamond';

/** The write side: one statement. */
export interface ReplayWriteDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
    };
  };
}

/** The read side alone: `/health/ingest` reads with a narrower handle. */
export interface ReplayReadDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

/** One chain's replay state, as `/health/ingest` and the read envelopes state it. */
export interface ReplayState {
  /** True while the chain's rows are being replayed; null when the indexer cannot say. */
  replaying: boolean | null;
  /** Why it is replaying: a deployment was adopted, or a reorganised block forced a rebuild. Null when not replaying or unknown. */
  reason: ReplayReason | null;
  /** The last block the scan completed through; null when there is no cursor. */
  cursorBlock: number | null;
  /** The chain's safe head as the last pass read it; null when that pass could not read one, or none has been recorded. */
  safeHead: number | null;
  /** When that head was read (unix seconds); null when none is recorded. */
  safeHeadObservedAt: number | null;
  /**
   * `safeHead - cursorBlock`, or null (unknown) when either is unknown.
   * Negative when the latest head read sits below the cursor (a lagging
   * provider). Kept as it is, not clamped to 0.
   */
  lagBlocks: number | null;
  /** The replay counts as caught up once `lagBlocks` is at most this. */
  caughtUpWithinBlocks: number;
}

/** The state when nothing is known. */
export function unknownReplayState(): ReplayState {
  return {
    replaying: null,
    reason: null,
    cursorBlock: null,
    safeHead: null,
    safeHeadObservedAt: null,
    lagBlocks: null,
    caughtUpWithinBlocks: REPLAY_CAUGHT_UP_BLOCKS,
  };
}

interface Row {
  chain_id: number;
  reset_pending: number | null;
  replay_reason: string | null;
  last_block: number | null;
  safe_head: number | null;
  safe_head_at: number | null;
}

function toReason(raw: string | null): ReplayReason | null {
  return raw === REPLAY_DEPLOYMENT || raw === REPLAY_REBUILD ? raw : null;
}

function fromRow(r: Row): ReplayState {
  const cursorBlock = r.last_block;
  const safeHead = r.safe_head;
  const lagBlocks = cursorBlock === null || safeHead === null ? null : safeHead - cursorBlock;
  let replaying: boolean;
  let reason: ReplayReason | null;
  if ((r.reset_pending ?? 0) !== 0) {
    // A reset claimed and not yet landed: the rows are about to be cleared.
    replaying = true;
    reason = r.reset_pending === RESET_REBUILD ? REPLAY_REBUILD : REPLAY_DEPLOYMENT;
  } else {
    reason = toReason(r.replay_reason);
    replaying = reason !== null;
  }
  return {
    replaying,
    reason,
    cursorBlock,
    safeHead,
    safeHeadObservedAt: r.safe_head_at,
    lagBlocks,
    caughtUpWithinBlocks: REPLAY_CAUGHT_UP_BLOCKS,
  };
}

/** True for the errors a database without migration 0097 (or 0063) raises. */
function isPreMigration(err: unknown): boolean {
  return /no such (table|column)/i.test((err as Error)?.message ?? '');
}

/**
 * Read the replay state of every chain with a deployment record, or of one
 * chain. A chain without a record is absent from the map. Callers state it
 * as {@link unknownReplayState}. On a database that predates migration 0097
 * the map is empty. Any other failure propagates, so a broken read is never
 * reported as "not replaying".
 */
export async function readReplayStates(db: ReplayReadDb, chainId?: number): Promise<Map<number, ReplayState>> {
  // One fixed statement for both uses: a null chain id reads every chain.
  const sql = `SELECT d.chain_id, d.reset_pending, d.replay_reason, c.last_block, d.safe_head, d.safe_head_at
                 FROM indexer_deployment d
                 LEFT JOIN indexer_cursor c ON c.chain_id = d.chain_id AND c.kind = ?
                WHERE ? IS NULL OR d.chain_id = ?`;
  const one = chainId ?? null;
  const args: unknown[] = [SCAN_CURSOR_KIND, one, one];
  let rows: Row[];
  try {
    rows =
      (
        await db
          .prepare(sql)
          .bind(...args)
          .all<Row>()
      ).results ?? [];
  } catch (err) {
    if (isPreMigration(err)) return new Map();
    throw err;
  }
  return new Map(rows.map((r) => [r.chain_id, fromRow(r)]));
}

/** One chain's replay state, or {@link unknownReplayState} when it has no record. */
export async function readReplayState(db: ReplayReadDb, chainId: number): Promise<ReplayState> {
  return (await readReplayStates(db, chainId)).get(chainId) ?? unknownReplayState();
}

/**
 * The statement that records the safe head a pass learned and ends a replay
 * the cursor has caught up with. `safeHead` is null when the pass could not
 * read a settled head (the hold of #2201): the head is then recorded as
 * unknown, and no replay ends on a guess.
 *
 * It reads the scan cursor itself, so a replay ends only against the cursor
 * actually stored. The scanned path puts it in the same batch as its cursor
 * write (one transaction), where it sees the cursor that write just stored. It
 * never ends a replay while a reset is pending, so a claimed reset is never
 * announced as finished.
 */
export function chainHeadStatement<S>(
  db: { prepare(sql: string): { bind(...args: unknown[]): S } },
  args: { chainId: number; safeHead: bigint | null; nowSec?: number },
): S {
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const head = args.safeHead === null ? null : Number(args.safeHead);
  return db
    .prepare(
      `UPDATE indexer_deployment
          SET safe_head = ?1, safe_head_at = ?2,
              replay_reason = CASE
                WHEN ?1 IS NOT NULL AND reset_pending = 0
                 AND ?1 - (SELECT c.last_block FROM indexer_cursor c
                            WHERE c.chain_id = indexer_deployment.chain_id AND c.kind = ?3) <= ?4
                THEN NULL ELSE replay_reason END
        WHERE chain_id = ?5`,
    )
    .bind(head, nowSec, SCAN_CURSOR_KIND, REPLAY_CAUGHT_UP_BLOCKS, args.chainId);
}

/**
 * {@link chainHeadStatement}, run on its own: the paths that write no cursor
 * (a caught-up pass, a pass held on an unsettled head).
 *
 * Fail-open, logged: a failed write leaves the previous record. That record
 * can only overstate a replay (the latch stays set), never end one early, so
 * a write error must not fail the pass.
 */
export async function recordChainHead(
  db: ReplayWriteDb,
  args: { chainId: number; safeHead: bigint | null; nowSec?: number },
): Promise<void> {
  try {
    await chainHeadStatement(db, args).run();
  } catch (err) {
    console.error(`[replayState] chain ${args.chainId}: recording the safe head failed`, redactedError(err));
  }
}
