/**
 * The world rail's freshness (RB-RAILS): every world figure carries the
 * block and age of the index it came from, read from the indexer's own
 * `GET /health/ingest` (per chain: the last block the scan completed
 * through and when), and the index is called stale once it has not
 * advanced for half an hour. An index is presented as current only when it
 * PROVES which protocol contract its rows came from: its adopted deployment
 * is present, is the one this build binds to, was adopted by a reset rather
 * than blindly (no prior record to compare, so the rows' origin is unknown),
 * and has no reset still pending (a mixed index). Anything short of that is
 * UNKNOWN, never current (a fresh testnet deploy the indexer has not adopted
 * yet, ACC-65; an indexer before its deployment record existed). So is a
 * scan time ahead of the indexer's own clock (a restored cursor,
 * clock skew), which the indexer reports as a negative age on purpose. A
 * re-read that failed after an earlier answer is disclosed on the stamp
 * beside the last answer, never swallowed into a healthy-looking stamp.
 */

/** The subset of the indexer's answer this app reads. */
export interface IngestHealth {
  checkedAt: number;
  chains: readonly {
    chainId: number;
    lastBlock: number | null;
    scannedAt: number | null;
    ageSeconds: number | null;
    deployment: { diamond: string; resetPending: boolean; adoptedBlind: boolean } | null;
  }[];
}

/** Half an hour without the cursor advancing is a stale-data notice. */
export const STALE_AFTER_SEC = 30 * 60;

export type Freshness =
  /** The indexer could not be read at all (not configured, unreachable). */
  | { kind: 'unavailable'; reason: string }
  /** The indexer answered but knows no cursor for this chain and build. */
  | { kind: 'unknown'; reason: string }
  | {
      kind: 'fresh' | 'stale';
      lastBlock: number;
      scannedAt: number;
      ageSeconds: number;
      /** The latest re-read failed: these figures are the last answer, aged. */
      refreshError: string | null;
    };

export interface FreshnessInputs {
  health: IngestHealth | null;
  /** The failure that produced a `null` health, when there was one. */
  error: string | null;
  chainId: number;
  /** The Diamond this build binds to on the chain. */
  diamond: string;
  /** Seconds since the health answer was received (its ages have aged). */
  elapsedSec: number;
}

/** Why the index cannot be shown as describing this build's contract, or
 *  null when its deployment record proves it does. Every unproven case is a
 *  reason, never a pass: the indexer states these flags so a reader does not
 *  have to guess (apps/indexer deploymentEpoch.ts). */
export function attributionGap(deployment: IngestHealth['chains'][number]['deployment'], diamond: string): string | null {
  if (deployment === null) return 'The index does not say which protocol contract its figures came from.';
  if (deployment.diamond.toLowerCase() !== diamond.toLowerCase()) return 'The index describes a different protocol contract than this build.';
  if (deployment.resetPending !== false) return 'The index is part-way through clearing an older contract\'s figures.';
  if (deployment.adoptedBlind !== false) return 'The index cannot yet confirm its figures all came from this build\'s protocol contract.';
  return null;
}

export function freshnessOf({ health, error, chainId, diamond, elapsedSec }: FreshnessInputs): Freshness {
  if (health === null) return { kind: 'unavailable', reason: error ?? 'The index has not been read yet.' };
  const chain = health.chains.find((c) => c.chainId === chainId);
  if (!chain) return { kind: 'unknown', reason: 'The index does not scan this chain.' };
  const unattributed = attributionGap(chain.deployment, diamond);
  if (unattributed !== null) return { kind: 'unknown', reason: unattributed };
  if (chain.lastBlock === null || chain.scannedAt === null || chain.ageSeconds === null) {
    return { kind: 'unknown', reason: 'The index has no scan position for this chain yet.' };
  }
  if (chain.ageSeconds < 0) {
    return { kind: 'unknown', reason: "The index's scan time is ahead of its own clock, so its age cannot be told." };
  }
  const ageSeconds = chain.ageSeconds + Math.max(0, elapsedSec);
  return {
    kind: ageSeconds >= STALE_AFTER_SEC ? 'stale' : 'fresh',
    lastBlock: chain.lastBlock,
    scannedAt: chain.scannedAt,
    ageSeconds,
    refreshError: error,
  };
}

/** A push-rail cursor frame newer than an ATTRIBUTED polled answer advances
 *  the stamp between polls; an older one changes nothing, and one dated ahead
 *  of the clock is not trusted to say anything about age. A failed re-read
 *  stays disclosed: a push frame proves the rail is live, not that the
 *  health route answers. */
export function withCursor(
  freshness: Freshness,
  cursor: { lastBlock: number; updatedAt: number } | null,
  nowSec: number,
): Freshness {
  if (!cursor || cursor.updatedAt > nowSec) return freshness;
  // Only an answer that already PROVED which contract the index describes
  // may be advanced: a cursor frame carries no deployment, so it can age an
  // attributed stamp forward but never stand in for the health answer. An
  // unreadable or unattributed index stays as it is, with its reason.
  if (freshness.kind !== 'fresh' && freshness.kind !== 'stale') return freshness;
  if (cursor.updatedAt <= freshness.scannedAt) return freshness;
  const ageSeconds = nowSec - cursor.updatedAt;
  return { kind: ageSeconds >= STALE_AFTER_SEC ? 'stale' : 'fresh', lastBlock: cursor.lastBlock, scannedAt: cursor.updatedAt, ageSeconds, refreshError: freshness.refreshError };
}
