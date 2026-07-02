import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { HelpLink } from '../components/HelpLink';
import {
  activityEventRefs,
  activityKindLabel,
  filterVisibleActivity,
  groupActivityByTx,
} from '../lib/activityLabels';
import { txExplorerUrl } from '../lib/explorer';
import { useWallet } from '../context/WalletContext';
import { useIndexedActivity } from '../hooks/useIndexedActivity';
import { useReadChain } from '../hooks/useDiamond';
import '../components/ActivityFeed.css';

function formatWhen(unixSec: number): string {
  if (!unixSec) return '—';
  const date = new Date(unixSec * 1000);
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604_800) return `${Math.floor(diffSec / 86_400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ActivityPage() {
  const { address, connect } = useWallet();
  const chain = useReadChain();
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, refetch, isRefetching } =
    useIndexedActivity();

  const groups = useMemo(() => {
    const events = data?.pages.flatMap((p) => p?.events ?? []) ?? [];
    return groupActivityByTx(filterVisibleActivity(events));
  }, [data]);

  if (!address) {
    return (
      <div>
        <h1 className="page-title">Activity</h1>
        <p className="page-subtitle">Connect your wallet to see your on-chain loan and offer history.</p>
        <button type="button" className="btn btn-primary" onClick={connect}>
          Connect wallet
        </button>
      </div>
    );
  }

  return (
    <div>
      <Link to="/more" style={{ fontSize: '0.9rem' }}>
        ← Back to More
      </Link>
      <h1 className="page-title" style={{ marginTop: 12 }}>
        Activity
      </h1>
      <p className="page-subtitle">
        Recent actions on {chain.name}. <HelpLink anchor="getting-started" label="What shows up here?" />
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={isRefetching}
          onClick={() => void refetch()}
        >
          {isRefetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {isLoading ? <p>Loading activity…</p> : null}

      <div className="activity-feed">
        {groups.map((group) => {
          const txHref = txExplorerUrl(chain.blockExplorer, group.txHash);
          const refs =
            group.loanId != null || group.offerId != null
              ? [
                  group.loanId != null ? `Loan #${group.loanId}` : null,
                  group.offerId != null ? `Offer #${group.offerId}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : null;

          return (
            <article key={group.txHash} className="activity-card">
              <div className="activity-card-title">{activityKindLabel(group.primaryKind)}</div>
              <div className="activity-card-meta">{formatWhen(group.blockAt)}</div>
              {refs ? <div className="activity-card-meta">{refs}</div> : null}
              <div className="activity-card-links">
                {group.loanId != null ? (
                  <Link to={`/positions/${group.loanId}`}>View loan</Link>
                ) : null}
                {txHref ? (
                  <a href={txHref} target="_blank" rel="noopener noreferrer">
                    View transaction <ExternalLink size={12} style={{ verticalAlign: 'middle' }} />
                  </a>
                ) : null}
              </div>
              {group.events.length > 1 ? (
                <div className="activity-card-detail">
                  {group.events.map((ev) => (
                    <div key={`${ev.txHash}:${ev.logIndex}`}>
                      {activityKindLabel(ev.kind)}
                      {activityEventRefs(ev) ? ` · ${activityEventRefs(ev)}` : ''}
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {!isLoading && groups.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          No activity yet. Borrow, lend, or post an offer to get started.
        </p>
      ) : null}

      {hasNextPage ? (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}