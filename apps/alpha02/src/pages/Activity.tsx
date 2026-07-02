/**
 * Activity — the wallet's Vaipakam history (advanced navigation).
 * Rows come from the indexer; kinds are shown as readable labels with
 * loan/offer links back into the app.
 */
import { History, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useModal } from 'connectkit';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { fetchActivity, type IndexedActivityEvent } from '../data/indexer';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { formatDate } from '../lib/format';

/** camelCase / PascalCase event kind → spaced words
 *  ("LoanRepaid" → "Loan repaid"). */
function kindLabel(kind: string): string {
  const spaced = kind.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function ActivityRow({ event }: { event: IndexedActivityEvent }) {
  const context = [
    event.loanId !== null ? `Loan #${event.loanId}` : null,
    event.offerId !== null ? `Offer #${event.offerId}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const body = (
    <span className="row-main">
      <span className="row-title">{kindLabel(event.kind)}</span>
      <br />
      <span className="row-sub">
        {context || 'Protocol event'} · {formatDate(event.blockAt)}
      </span>
    </span>
  );

  return event.loanId !== null ? (
    <Link to={`/positions/${event.loanId}`} className="item-row">
      {body}
    </Link>
  ) : (
    <div className="item-row">{body}</div>
  );
}

export function Activity() {
  const { isConnected, readChain, address } = useActiveChain();
  const { setOpen } = useModal();

  const activity = useQuery({
    queryKey: ['activity', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address),
    refetchInterval: 60_000,
    queryFn: async () => {
      const page = await fetchActivity(readChain.chainId, address!, { limit: 50 });
      return page === null ? null : page.events;
    },
  });

  return (
    <div>
      <h1 className="page-title">{copy.activity.title}</h1>
      <p className="page-lede">{copy.activity.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={History}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : activity.isLoading ? (
        <EmptyState icon={LoaderCircle} title="Loading your activity…" />
      ) : activity.data === null || activity.data === undefined ? (
        <UnavailableState body={copy.activity.unavailable} />
      ) : activity.data.length === 0 ? (
        <EmptyState icon={History} title={copy.activity.empty} />
      ) : (
        <div className="row-list">
          {activity.data.map((event) => (
            <ActivityRow key={`${event.txHash}-${event.logIndex}`} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
