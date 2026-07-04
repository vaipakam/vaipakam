/**
 * F-20260703-003 (#988) — an empty offer book must be distinguishable
 * from a STALE one. Market-list surfaces (Offer Book, guided matching,
 * rental browse) render this note; it appears only when the indexer's
 * ingest cursor has POSITIVELY not advanced for a while, so "no offers
 * right now" is never confidently shown from a stalled snapshot.
 * Unknown freshness (endpoint unreachable, no cursor yet) renders
 * nothing — warning on every transient blip would train users to
 * ignore it.
 */
import { useQuery } from '@tanstack/react-query';
import { copy } from '../content/copy';
import { fetchIndexerFreshness } from '../data/indexer';
import { useActiveChain } from '../chain/useActiveChain';

/** Cursor idle time that counts as "stale". Base Sepolia mines every
 *  ~2s and the ingest cron ticks every few minutes, so half an hour of
 *  silence is a stall, not an idle market. */
const STALE_AFTER_SECONDS = 30 * 60;

export function MarketFreshnessNote() {
  const { readChain } = useActiveChain();
  const freshness = useQuery({
    queryKey: ['indexerFreshness', readChain.chainId],
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: () => fetchIndexerFreshness(readChain.chainId),
  });
  if (!freshness.data) return null;
  const ageSec = Math.floor(Date.now() / 1000) - freshness.data.updatedAt;
  if (ageSec < STALE_AFTER_SECONDS) return null;
  return (
    <div className="banner banner-warn" role="status">
      <span className="banner-body">
        {copy.offers.staleList(formatAge(ageSec))}
      </span>
    </div>
  );
}

function formatAge(sec: number): string {
  if (sec < 3_600) return `${Math.max(1, Math.floor(sec / 60))} minutes`;
  const hours = Math.floor(sec / 3_600);
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}
