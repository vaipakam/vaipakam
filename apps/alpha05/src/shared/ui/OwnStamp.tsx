import { useCopy, type CopyKey } from '../copy/useCopy';
import type { OwnSource } from '../../chain/ownRail';
import { formatAge } from './format';
import { useNow } from './useNow';

/** The part of an own read the stamp needs (`useOwnRead`'s answer). */
export interface StampedRead {
  state: 'no-identity' | 'reading' | 'ready' | 'failed';
  readAt: number | null;
  /** Set when the latest re-read failed behind an earlier answer. */
  error: string | null;
  via: OwnSource | null;
  refreshing: boolean;
  refetch: () => void;
}

const VIA: Record<OwnSource, CopyKey> = {
  wallet: 'own.viaWallet',
  proxy: 'own.viaProxy',
  public: 'own.viaPublic',
};

/**
 * The shared sync chip for own state (RW-72, RB-REFRESH): "Syncing…" until
 * the page's own reads have answered, then how long ago the OLDEST of them
 * was read and which source answered (named per read, never assumed), marked
 * while a re-read is in flight, with one Refresh that re-reads them all. A
 * failed read is stated by its own section. An answer kept after a failed
 * re-read still counts at the age it was READ, and the chip says a re-read
 * failed, so a stale list is never reported as freshly synced.
 */
export function OwnStamp({ reads }: { reads: readonly StampedRead[] }) {
  const { text, format } = useCopy();
  const now = useNow();
  const live = reads.filter((r) => r.state !== 'no-identity');
  if (live.length === 0) return null;
  const refresh = (
    <button type="button" className="link" onClick={() => live.forEach((r) => r.refetch())}>
      {text('own.refresh')}
    </button>
  );
  const ready = live.filter((r) => r.state === 'ready' && r.readAt !== null);
  if (ready.length === 0) {
    return (
      <p className="tier-b stamp" role="status">
        {text('own.syncing')} {refresh}
      </p>
    );
  }
  const oldest = Math.min(...ready.map((r) => r.readAt!));
  const sources = [...new Set(ready.map((r) => r.via).filter((v): v is OwnSource => v !== null))];
  const via = sources.length === 1 ? text(VIA[sources[0]!]) : text('own.viaSeveral');
  return (
    <p className="tier-b stamp" role="status">
      {format('own.synced', { age: formatAge((now - oldest) / 1000), via })}
      {live.some((r) => r.refreshing) ? ` ${text('own.syncingNow')}` : ''}
      {live.some((r) => r.error !== null) ? ` ${text('own.refreshFailed')}` : ''} {refresh}
    </p>
  );
}
