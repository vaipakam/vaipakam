/**
 * T-041 — small inline status badge surfacing how stale the worker
 * cache is, with a Rescan button that re-pulls everything.
 *
 * Modeled on Etherscan's "Last block: 3s ago" — gives the user
 * visibility into when the cache was last updated so they can decide
 * whether to click Rescan. The decision NOT to auto-poll on the
 * client (the worker scans every 5 min on cron, the browser does
 * event-driven incremental rescans via watchContractEvent + manual
 * rescan via this button) is deliberate. This badge is the user-
 * visible part of that contract — without it, the staleness window
 * is invisible and users can't tell whether they're looking at
 * fresh state or a 5-minute-old snapshot.
 *
 * Source-aware: when `useIndexedActiveOffers().source === 'fallback'`
 * (worker unreachable) the badge collapses to a plain "Live chain
 * scan" pill with no timestamp — the per-browser scan IS the data
 * source in fallback, so there's no cache age to report.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useOfferStats } from '../../hooks/useOfferStats';
import './IndexerStatusBadge.css';

interface Props {
  /** Optional: show alongside a custom rescan callback. Defaults to a
   *  page reload, which forces every hook to re-pull state. */
  onRescan?: () => void;
  /** Compact: hide the "ago" suffix on narrow viewports. */
  compact?: boolean;
}

export function IndexerStatusBadge({ onRescan, compact }: Props) {
  const { t } = useTranslation();
  const { stats } = useOfferStats();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Tick once per minute so the "X min ago" label refreshes without
  // re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  const handleRescan = () => {
    if (onRescan) onRescan();
    else window.location.reload();
  };

  // Worker unreachable / no cache yet — degrade to a "Live" pill.
  if (!stats || !stats.indexer) {
    return (
      <span
        className="indexer-badge indexer-badge--live"
        title={t('indexerBadge.liveTooltip', {
          defaultValue:
            'Cache unreachable; reading directly from the chain via your browser. Pages may load slower but all data is live.',
        })}
      >
        <WifiOff size={12} />
        {!compact && <span>{t('indexerBadge.live', { defaultValue: 'Live chain scan' })}</span>}
      </span>
    );
  }

  const ageSec = Math.max(0, now - stats.indexer.updatedAt);
  const label =
    ageSec < 60
      ? t('indexerBadge.justNow', { defaultValue: 'just now' })
      : ageSec < 3600
      ? t('indexerBadge.minutes', {
          defaultValue: '{{min}} min ago',
          min: Math.floor(ageSec / 60),
        })
      : t('indexerBadge.hours', {
          defaultValue: '{{h}}h ago',
          h: Math.floor(ageSec / 3600),
        });

  return (
    <span className="indexer-badge indexer-badge--cached">
      <Wifi size={12} />
      {!compact && (
        <span>
          {t('indexerBadge.indexed', { defaultValue: 'Indexed' })} {label}
        </span>
      )}
      <button
        type="button"
        className="indexer-badge-rescan"
        onClick={handleRescan}
        title={t('indexerBadge.rescanTooltip', {
          defaultValue: 'Force a fresh on-chain scan from your browser. Bypasses the cache.',
        })}
      >
        <RefreshCw size={12} />
        {!compact && <span>{t('indexerBadge.rescan', { defaultValue: 'Rescan' })}</span>}
      </button>
    </span>
  );
}
