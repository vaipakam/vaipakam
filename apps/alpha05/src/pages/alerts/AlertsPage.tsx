import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useCopy, type CopyAccess, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { inboxTarget, type InboxRow } from '../../shared/inbox/inbox';
import { markSeen, readSeen } from '../../shared/inbox/seen';
import { inboxReason, useInbox, useInboxNewer } from '../../shared/inbox/useInbox';
import { formatUtc } from '../../shared/ui/format';
import { AlertChannels } from './AlertChannels';

/**
 * Alerts (#3180, ACC-54; RB-INBOX): the free inbox the protocol's index keeps
 * for the connected wallet on its network, newest first, each row a short
 * outcome with its time and a link to the loan (read from the chain there)
 * or to Claims for a reward entry. Rows newer than the last ones this page
 * showed in this browser are marked New, and opening the page records them
 * as seen. A failed read says so and is never shown as an empty inbox; rows
 * that could not be read are counted. Below the inbox, Telegram, push, health
 * warnings and payment reminders are set up (`AlertChannels`, ACC-50/52).
 */
export function AlertsPage() {
  const copy = useCopy();
  const { text, format } = copy;
  const { status } = useAccount();
  const { chain, account, indexed, query } = useInbox();
  const pages = query.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const unreadable = pages.reduce((n, p) => n + p.unreadable, 0);
  const identity = chain && account ? `${chain.chainId}:${account.toLowerCase()}` : null;

  // The rows newer than what was seen when this page opened stay marked New
  // for the visit; what the page has shown is recorded as seen.
  // The baseline is taken once per wallet and network, during render and
  // before the effect below records anything, so it is what was seen before.
  const [baseline, setBaseline] = useState<{ identity: string; seen: number } | null>(null);
  if (identity !== null && chain !== null && account !== null && query.data !== undefined && baseline?.identity !== identity) {
    setBaseline({ identity, seen: readSeen(chain.chainId, account) });
  }
  const ready = baseline?.identity === identity;
  const seenAtOpen = ready ? baseline!.seen : null;
  // How many arrived since then is the index's count over every row (a new
  // row stamped with an older block can sort below the rows on screen); what
  // is recorded as seen is everything written so far, as a notification
  // centre clears its count when opened. Without the count, only the rows
  // shown are recorded.
  const newer = useInboxNewer(seenAtOpen);
  const newestId = Math.max(
    rows.reduce((m, r) => Math.max(m, r.id), 0),
    newer.data && !newer.isRefetchError ? newer.data.newestId : 0,
  );
  useEffect(() => {
    if (!ready || chain === null || account === null || newestId === 0 || newer.isPending) return;
    markSeen(chain.chainId, account, newestId);
  }, [ready, chain, account, newestId, newer.isPending]);
  const fresh = newer.data ? `${newer.data.count}${newer.data.capped ? '+' : ''}` : null;
  // New rows still below the loaded pages are claimed only when the loaded
  // pages cannot account for the count: every new row shown, every new row
  // counted as unreadable, and every unreadable row whose id is unknown (it
  // may be one of the new ones) is set against it first.
  const loadedNew =
    seenAtOpen === null
      ? 0
      : rows.filter((r) => r.id > seenAtOpen).length +
        pages.reduce((n, p) => n + p.unreadableIds.filter((id) => id > seenAtOpen).length + (p.unreadable - p.unreadableIds.length), 0);
  const freshBelow = seenAtOpen !== null && newer.data !== undefined && query.hasNextPage && newer.data.count > loadedNew;

  const failed = !indexed || query.status === 'error';
  const reason = inboxReason(query.error, indexed, text);

  return (
    <main className="page alerts" aria-labelledby="alerts-title">
      <h1 id="alerts-title">{text('inbox.title')}</h1>
      {status !== 'connected' && <p className="tier-b">{text('inbox.connectPrompt')}</p>}
      {status === 'connected' && chain === null && <p className="tier-b">{text('inbox.unsupportedChain')}</p>}
      {chain && account && (
        <section className="home-section" aria-labelledby="alerts-inbox" data-testid="alerts-inbox">
          <h2 id="alerts-inbox" className="sr-only">
            {text('inbox.title')}
          </h2>
          <p className="tier-b">{format('inbox.lead', { chain: chain.name })}</p>
          <p className="tier-b">{text('inbox.history')}</p>
          {failed && (
            <p className="tier-a" data-testid="alerts-failed">
              {format(query.data ? 'inbox.failedCached' : 'inbox.failed', { reason })}
            </p>
          )}
          {!failed && query.data === undefined && <p className="tier-b">{text('inbox.reading')}</p>}
          {unreadable > 0 && (
            <p className="tier-a" data-testid="alerts-unreadable">
              {format('inbox.unreadable', { count: String(unreadable) })}
            </p>
          )}
          {fresh !== null && fresh !== '0' && (
            <p className="tier-b" data-testid="alerts-fresh">
              {format('inbox.newCount', { count: fresh })}
              {freshBelow && ` ${text('inbox.newBelow')}`}
            </p>
          )}
          {newer.status === 'error' && query.data !== undefined && (
            <p className="tier-b" data-testid="alerts-fresh-failed">
              {format('inbox.newFailed', { reason: inboxReason(newer.error, indexed, text) })}
            </p>
          )}
          {query.data !== undefined && rows.length === 0 && !query.hasNextPage && unreadable === 0 && (
            <p className="tier-b home-empty" data-testid="alerts-empty">
              {format('inbox.empty', { chain: chain.name })}
            </p>
          )}
          {rows.length > 0 && (
            <ul className="rows alerts-list" data-testid="alerts-rows">
              {rows.map((r) => (
                <AlertRow key={r.id} row={r} fresh={seenAtOpen !== null && r.id > seenAtOpen} copy={copy} />
              ))}
            </ul>
          )}
          {query.hasNextPage && (
            <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid="alerts-more">
              {text(query.isFetchingNextPage ? 'inbox.readingMore' : 'inbox.more')}
            </button>
          )}
          {query.data !== undefined && rows.length > 0 && !query.hasNextPage && <p className="tier-b">{format('inbox.end', { chain: chain.name })}</p>}
          <WhyLink summaryKey="inbox.whySummary" detailKey="inbox.why" />
        </section>
      )}
      {chain && account && <AlertChannels key={identity ?? ''} chain={chain} account={account} />}
    </main>
  );
}

function AlertRow({ row: r, fresh, copy }: { row: InboxRow; fresh: boolean; copy: CopyAccess }) {
  const { text, format } = copy;
  const id = r.loanId?.toString() ?? '';
  const line = r.kind === null ? format('inbox.unknownKind', { kind: r.rawKind }) : format(`inbox.${r.kind}` as CopyKey, { id, entry: r.entryId ?? '' });
  const to = inboxTarget(r);
  return (
    <li className="card alert-row" data-alert={r.rawKind} data-fresh={fresh} data-testid={`alert-${r.id}`}>
      <p>
        {fresh && <span className="alert-new">{text('inbox.newBadge')}</span>} {line}
      </p>
      <p className="tier-b">
        {r.reconciled ? (
          <span data-testid={`alert-${r.id}-found`}>{format('inbox.found', { time: formatUtc(r.createdAt) })}</span>
        ) : (
          <time dateTime={new Date(r.createdAt * 1000).toISOString()}>{formatUtc(r.createdAt)}</time>
        )}
        {to && (
          <>
            {' · '}
            <Link to={to}>{r.loanId !== null && to.startsWith('/positions/') ? format('inbox.openLoan', { id }) : text('inbox.openClaims')}</Link>
          </>
        )}
      </p>
    </li>
  );
}
