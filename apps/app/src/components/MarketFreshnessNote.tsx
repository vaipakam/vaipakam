/**
 * F-20260703-003 (#988) — an empty offer book must be distinguishable
 * from a STALE one. Market-list surfaces (Offer Book, guided matching,
 * rental browse, activity) render this note.
 *
 * #3733 — it reads the indexer's own replay statement first. While the
 * indexer says it is rebuilding a network's records (a new deployment
 * adopted, or a reorganised block replaced), the list is partial whatever
 * the cursor's age, so the note says the figures are being rebuilt and may
 * be incomplete. After that, a measured block gap beyond the indexer's
 * caught-up cut, and then a cursor that has not moved for a while.
 *
 * The note never says "fresh": the current case renders nothing. Unknown
 * freshness (endpoint unreachable, no cursor and no replay stated) also
 * renders nothing — warning on every transient blip would train users to
 * ignore it.
 */
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { fetchIndexerStatus } from '../data/indexer';
import { indexReadingOf } from '../data/ingestReplay';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';
import { useNowSec } from '../hooks/useNowSec';

export function MarketFreshnessNote() {
  const { readChain } = useActiveChain();
  const status = useQuery({
    queryKey: ['indexerStatus', readChain.chainId],
    staleTime: 30_000,
    refetchInterval: idleAware(60_000),
    queryFn: () => fetchIndexerStatus(readChain.chainId),
  });
  // Ticks, so a book that goes stale while this page sits open crosses the
  // threshold on its own instead of waiting for an unrelated re-render.
  const nowSec = useNowSec();
  if (!status.data) return null;
  const reading = indexReadingOf(
    status.data.replay,
    status.data.freshness?.updatedAt ?? null,
    nowSec,
  );
  let body: string;
  switch (reading.kind) {
    case 'rebuilding':
      body = copy.offers.rebuildingList;
      break;
    case 'behind-blocks':
      body = copy.offers.behindList(reading.lagBlocks.toLocaleString());
      break;
    case 'stale':
      body = copy.offers.staleList(formatAge(reading.ageSec));
      break;
    default:
      return null;
  }
  return (
    <div
      className="banner banner-warn"
      role="status"
      data-testid="market-freshness-note"
      data-reading={reading.kind}
    >
      <span className="banner-body">{body}</span>
    </div>
  );
}

function formatAge(sec: number): string {
  if (sec < 3_600) return `${Math.max(1, Math.floor(sec / 60))} minutes`;
  const hours = Math.floor(sec / 3_600);
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}
