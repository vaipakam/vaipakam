/**
 * Activity — the wallet's Vaipakam history (advanced navigation).
 * Rows come from the indexer; kinds are shown as readable labels with
 * loan/offer links back into the app.
 */
import { useMemo } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useModal } from 'connectkit';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useMyLoans } from '../data/hooks';
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
  const loans = useMyLoans();

  // The worker's actor column is non-exhaustive (a keeper-triggered
  // LoanDefaulted has actor null; OfferAccepted stores only the
  // acceptor), so fetch broadly and keep an event when the wallet is a
  // PARTICIPANT: recorded actor, mentioned in the event args, or the
  // event belongs to one of the wallet's own loans.
  const myLoanIds = useMemo(
    () =>
      new Set(
        (Array.isArray(loans.data) ? loans.data : []).map((l) => l.loanId),
      ),
    [loans.data],
  );

  const activity = useQuery({
    queryKey: [
      'activity',
      readChain.chainId,
      address?.toLowerCase(),
      myLoanIds.size,
    ],
    enabled: Boolean(address),
    refetchInterval: 60_000,
    queryFn: async (): Promise<{
      events: IndexedActivityEvent[];
      truncated: boolean;
    } | null> => {
      // Protocol-wide feed, so one busy day can push a wallet's events
      // past the first page — follow the cursor a few pages before
      // giving up, and stop early once we have plenty of matches.
      // Stopping with the cursor still open means the scan is
      // TRUNCATED, and the page must say so instead of rendering the
      // partial slice as the wallet's complete history.
      const me = address!.toLowerCase();
      const mine: IndexedActivityEvent[] = [];
      let before: string | undefined;
      let truncated = true;
      for (let i = 0; i < 5; i++) {
        const page = await fetchActivity(readChain.chainId, { limit: 100, before });
        if (page === null) return null; // any page failing → unavailable
        mine.push(
          ...page.events.filter((ev) => {
            if (ev.actor && ev.actor.toLowerCase() === me) return true;
            if (ev.loanId !== null && myLoanIds.has(ev.loanId)) return true;
            const argsStr =
              typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args ?? {});
            return argsStr.toLowerCase().includes(me);
          }),
        );
        if (page.nextBefore === null) {
          truncated = false;
          break;
        }
        if (mine.length >= 50) break; // plenty to show — still truncated
        before = page.nextBefore;
      }
      return { events: mine, truncated };
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
      ) : activity.data.events.length === 0 ? (
        <EmptyState
          icon={History}
          title={
            activity.data.truncated
              ? copy.activity.truncatedEmpty
              : copy.activity.empty
          }
        />
      ) : (
        <>
          {activity.data.truncated ? (
            <div className="banner banner-info" role="status" style={{ marginBottom: 12 }}>
              <span className="banner-body">{copy.activity.truncatedNote}</span>
            </div>
          ) : null}
          <div className="row-list">
            {activity.data.events.map((event) => (
              <ActivityRow key={`${event.txHash}-${event.logIndex}`} event={event} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
