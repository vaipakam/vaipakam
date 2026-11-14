/**
 * RW-77 — which source the Console's settings come from, and what is said
 * about them. The index's snapshot is used only while it is dated, recent,
 * not behind a governance change, and labelled; otherwise the settings are
 * read straight from the chain at one block, and the reason is stated. A
 * direct read that is older than the snapshot it replaces counts as failed,
 * because it could miss the very change that made the snapshot unusable.
 * With neither source the settings are unknown, never unset.
 *
 * "Labelled" is the completeness test: the snapshot carries the names of
 * its settings bundle. A single setting the chain did not answer when the
 * snapshot was taken is listed by name as not answered, beside the rest;
 * a direct read would ask the same getter of the same code.
 */
import type { ConfigSnapshot, SettingValues } from './snapshot';
import type { DirectRead } from './direct';

/** The longest a snapshot may have stood (seconds) and still be shown. */
export const SNAPSHOT_MAX_AGE_SEC = 86_400;

/** How far ahead of the reader's clock a recorded time may sit before the
 *  reader's clock and the recorder's are taken to disagree, so the age is
 *  unknown (seconds). */
export const CLOCK_SKEW_SEC = 300;

/** Why the snapshot was not used. */
export type SnapshotReason =
  /** The index did not answer. */
  | 'unreachable'
  /** The index holds no snapshot for this network. */
  | 'none'
  /** The index could not tie the settings' names to the code that answered. */
  | 'unlabelled'
  /** The index has scanned a governance change the snapshot predates. */
  | 'behind'
  /** The snapshot carries no time it was recorded. */
  | 'undated'
  /** The snapshot's time is ahead of this device's clock. */
  | 'future'
  /** The snapshot is older than {@link SNAPSHOT_MAX_AGE_SEC}. */
  | 'old';

export type SnapshotVerdict = { use: true } | { use: false; reason: SnapshotReason };

/** The verdict on a snapshot; `null` when the index did not answer. */
export function judgeSnapshot(snap: ConfigSnapshot | null, nowSec: number): SnapshotVerdict {
  if (snap === null) return { use: false, reason: 'unreachable' };
  if (!snap.available) return { use: false, reason: 'none' };
  if (snap.stale) return { use: false, reason: 'behind' };
  if (snap.values === null || snap.bundleUnreported !== null) return { use: false, reason: 'unlabelled' };
  if (snap.updatedAt <= 0) return { use: false, reason: 'undated' };
  if (snap.updatedAt > nowSec + CLOCK_SKEW_SEC) return { use: false, reason: 'future' };
  if (nowSec - snap.updatedAt > SNAPSHOT_MAX_AGE_SEC) return { use: false, reason: 'old' };
  return { use: true };
}

/** How old a dated answer is against this device's clock. */
export type Age = { kind: 'known'; seconds: number; old: boolean } | { kind: 'unknown' };

export function ageOf(asOf: number, nowSec: number): Age {
  if (asOf <= 0 || asOf > nowSec + CLOCK_SKEW_SEC) return { kind: 'unknown' };
  const seconds = Math.max(0, nowSec - asOf);
  return { kind: 'known', seconds, old: seconds > SNAPSHOT_MAX_AGE_SEC };
}

/** The Console's settings, settled on one source. */
export type ConsoleSettings =
  | {
      source: 'snapshot';
      values: SettingValues;
      unreported: string[];
      /** The block the snapshot describes. */
      block: number;
      /** When the index recorded it (unix seconds). */
      asOf: number;
    }
  | {
      source: 'chain';
      values: SettingValues;
      unreported: string[];
      block: number;
      /** The block's own time (unix seconds). */
      asOf: number;
      why: SnapshotReason;
      /** The index's own failure, when it did not answer. */
      indexError: Error | null;
      bundleIssue: DirectRead['bundleIssue'];
    }
  | {
      source: 'unknown';
      why: SnapshotReason;
      indexError: Error | null;
      failure: /** The direct read failed. */
        | { kind: 'read'; reason: string }
        /** The direct read answered from a block before the snapshot's. */
        | { kind: 'behind'; directBlock: number; snapshotBlock: number };
    };

/**
 * Settles the Console's settings: the snapshot when it may be shown, else a
 * direct read at one block. Never throws: every failure is a state.
 */
export async function settleSettings(opts: {
  snapshot: () => Promise<ConfigSnapshot>;
  direct: () => Promise<DirectRead>;
  nowSec: () => number;
}): Promise<ConsoleSettings> {
  let snap: ConfigSnapshot | null = null;
  let indexError: Error | null = null;
  try {
    snap = await opts.snapshot();
  } catch (e) {
    indexError = e instanceof Error ? e : new Error(String(e));
  }
  const verdict = judgeSnapshot(snap, opts.nowSec());
  if (verdict.use && snap?.available && snap.values) {
    return { source: 'snapshot', values: snap.values, unreported: snap.unreported ?? [], block: snap.sourceBlock, asOf: snap.updatedAt };
  }
  const why = verdict.use ? 'unlabelled' : verdict.reason;
  let direct: DirectRead;
  try {
    direct = await opts.direct();
  } catch (e) {
    return { source: 'unknown', why, indexError, failure: { kind: 'read', reason: (e as Error).message } };
  }
  const snapshotBlock = snap?.available ? Math.max(snap.sourceBlock, snap.staleAtBlock ?? 0) : 0;
  const directBlock = Number(direct.block);
  if (directBlock < snapshotBlock) return { source: 'unknown', why, indexError, failure: { kind: 'behind', directBlock, snapshotBlock } };
  return {
    source: 'chain',
    values: direct.values,
    unreported: direct.unreported,
    block: directBlock,
    asOf: direct.timestamp,
    why,
    indexError,
    bundleIssue: direct.bundleIssue,
  };
}
