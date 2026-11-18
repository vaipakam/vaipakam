/**
 * The indexer's replay state for one network (row 3.9, #3733).
 *
 * The indexer rebuilds a network's rows from the deployment block in two
 * cases: when it adopts a new deployment, and when a reorganised block
 * forces a rebuild. Until that replay reaches the chain's safe head, every
 * indexed list for the network is partial. The cursor's AGE cannot show
 * this, because a replay scans every few seconds, so an age-based reading
 * would call a half-built list fresh.
 *
 * So every chain-keyed indexer read carries an `ingest` object stating the
 * replay, and this module is the one place the app reads it:
 *  - `parseIngestReplay` takes the raw `ingest` field and returns null when
 *    it is absent or malformed (an older indexer), which means UNKNOWN.
 *  - `indexReadingOf` combines it with the cursor's age into the one
 *    verdict both the market-list note and the Support drawer render, so
 *    they cannot disagree about whether the index is current.
 *
 * Nothing here ever turns an unknown into "up to date": a replay the
 * indexer cannot state, or a block gap it cannot measure, falls back to the
 * age rule the app used before, and a replay it does state outranks any age.
 */

/** Why the indexer is replaying a network's rows. */
export type ReplayReason = 'deployment' | 'rebuild';

/** The `ingest` object, as the app reads it. */
export interface IngestReplay {
  /** True while rebuilding; null when the indexer itself cannot say. */
  replaying: boolean | null;
  /** Why, when replaying; null otherwise or when unknown. */
  reason: ReplayReason | null;
  /** Blocks between the cursor and the safe head; null when unknown. */
  lagBlocks: number | null;
  /** The gap within which the indexer counts itself caught up. */
  caughtUpWithinBlocks: number | null;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Read the `ingest` field of an indexer answer. Null = not stated. */
export function parseIngestReplay(raw: unknown): IngestReplay | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const replaying =
    r.replaying === true ? true : r.replaying === false ? false : null;
  const reason =
    r.reason === 'deployment' || r.reason === 'rebuild' ? r.reason : null;
  return {
    replaying,
    reason: replaying === true ? reason : null,
    lagBlocks: finiteOrNull(r.lagBlocks),
    caughtUpWithinBlocks: finiteOrNull(r.caughtUpWithinBlocks),
  };
}

/** Cursor idle time that counts as "stale". Base Sepolia mines every ~2s
 *  and the ingest cron ticks every few minutes, so half an hour of silence
 *  is a stall, not an idle market. Shared by every surface that judges the
 *  index, so none of them calls current what another calls stale. */
export const INDEX_STALE_AFTER_SEC = 30 * 60;

/** What a surface may say about the index for one network. */
export type IndexReading =
  /** Rebuilding: lists may be incomplete, whatever the cursor's age. */
  | { kind: 'rebuilding'; reason: ReplayReason | null; lagBlocks: number | null }
  /** Not rebuilding, but more blocks behind than the caught-up cut. */
  | { kind: 'behind-blocks'; lagBlocks: number }
  /** The cursor has not moved for a while. */
  | { kind: 'stale'; ageSec: number }
  /** The cursor is young and no gap was measured. `replayKnown` is false
   *  when the indexer did not say whether it is rebuilding, so a surface
   *  must not call the index up to date. */
  | { kind: 'current'; ageSec: number; replayKnown: boolean }
  /** No cursor and no replay stated: nothing can be said. */
  | { kind: 'unknown' };

/**
 * The one verdict. A stated replay comes first, because a rebuilding index
 * has a young cursor. Then a measured block gap beyond the caught-up cut.
 * Then the cursor's age. `updatedAt` is the cursor's last advance in unix
 * seconds, or null when the network has no cursor (a reset just cleared it).
 */
export function indexReadingOf(
  replay: IngestReplay | null,
  updatedAt: number | null,
  nowSec: number,
): IndexReading {
  if (replay?.replaying === true) {
    return { kind: 'rebuilding', reason: replay.reason, lagBlocks: replay.lagBlocks };
  }
  if (
    replay !== null &&
    replay.lagBlocks !== null &&
    replay.caughtUpWithinBlocks !== null &&
    replay.lagBlocks > replay.caughtUpWithinBlocks
  ) {
    return { kind: 'behind-blocks', lagBlocks: replay.lagBlocks };
  }
  if (updatedAt === null) return { kind: 'unknown' };
  const ageSec = Math.max(0, nowSec - updatedAt);
  return ageSec < INDEX_STALE_AFTER_SEC
    ? { kind: 'current', ageSec, replayKnown: replay?.replaying === false }
    : { kind: 'stale', ageSec };
}
