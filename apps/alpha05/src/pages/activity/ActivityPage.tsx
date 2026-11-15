import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import type { SupportedChain } from '../../chain/chains';
import { activityLines, type ActivityEvent, type ActivityLine, type RepairEntry } from '../../shared/activity/activity';
import { amountLine } from '../../shared/activity/amountLine';
import { activityReason, kindKey, useWalletActivity } from '../../shared/activity/useWalletActivity';
import { useCopy, type CopyAccess, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { ASSET_ERC20 } from '../../shared/positions/model';
import { useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { formatUtc, shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;

/**
 * Activity (#3180 ACC activity feed, #3677; RB-FUNDS): everything the
 * protocol's index holds for the connected wallet on its network, newest
 * first, from the index's own wallet filter. One line per transaction, led by
 * the event that says what happened and listing the rest under it; each line
 * names its loan or offer, what it moved when the index recorded that, who
 * it is recorded for (the event's filed wallet, not necessarily its
 * sender), when, and the transaction itself. Events in the newest blocks come
 * first, marked not final. A loan whose ending a check found, rather than an
 * event, says what was and was not seen. The page says when the index is
 * still reading older history, so the list is never presented as complete
 * when it may not be; a failed read is never shown as an empty history. It
 * signs nothing.
 */
export function ActivityPage() {
  const copy = useCopy();
  const { text, format } = copy;
  const { status } = useAccount();
  const { chain, account, indexed, query } = useWalletActivity();
  const pages = query.data?.pages ?? [];
  const events = pages.flatMap((p) => p.events);
  const repairs = pages.flatMap((p) => p.repairs);
  const unreadable = pages.reduce((n, p) => n + p.unreadable, 0);
  // Endings a check found could not be read for some page: the list may be
  // missing a loan's ending, so it claims neither emptiness nor an end.
  const repairsUnknown = pages.some((p) => !p.repairsKnown);
  const pending = pages[0]?.pending;
  const walletComplete = pages[0]?.walletComplete;
  const lines = activityLines(events, repairs);
  const pendingLines = pending ? activityLines(pending.events) : [];
  const assets = [...events, ...(pending?.events ?? [])].flatMap((e) => (e.asset !== null && e.assetType === ASSET_ERC20 ? [e.asset] : []));
  const meta = useTokenMeta(assets).data ?? null;

  const failed = !indexed || query.status === 'error';
  const reason = activityReason(query.error, indexed, text);

  return (
    <main className="page activity" aria-labelledby="activity-title">
      <h1 id="activity-title">{text('activity.title')}</h1>
      {status !== 'connected' && <p className="tier-b">{text('activity.connectPrompt')}</p>}
      {status === 'connected' && chain === null && <p className="tier-b">{text('activity.unsupportedChain')}</p>}
      {chain && account && (
        <section className="home-section" aria-labelledby="activity-list" data-testid="activity">
          <h2 id="activity-list" className="sr-only">
            {text('activity.title')}
          </h2>
          <p className="tier-b">{format('activity.lead', { chain: chain.name })}</p>
          {failed && (
            <p className="tier-a" data-testid="activity-failed">
              {format(query.data ? 'activity.failedCached' : 'activity.failed', { reason })}
            </p>
          )}
          {!failed && query.data === undefined && <p className="tier-b">{text('activity.reading')}</p>}
          {walletComplete === false && (
            <p className="tier-a" data-testid="activity-incomplete">
              {text('activity.incomplete')}
            </p>
          )}
          {query.data !== undefined && walletComplete === null && (
            <p className="tier-a" data-testid="activity-complete-unknown">
              {text('activity.completeUnknown')}
            </p>
          )}
          {repairsUnknown && (
            <p className="tier-a" data-testid="activity-repairs-unknown">
              {text('activity.repairsUnknown')}
            </p>
          )}
          {unreadable > 0 && (
            <p className="tier-a" data-testid="activity-unreadable">
              {format('activity.unreadable', { count: String(unreadable) })}
            </p>
          )}

          {query.data !== undefined && pending === null && (
            <p className="tier-b" data-testid="activity-pending-unknown">
              {text('activity.pendingUnknown')}
            </p>
          )}
          {pendingLines.length > 0 && (
            <div className="activity-pending" data-testid="activity-pending">
              <h3>{text('activity.pendingTitle')}</h3>
              <p className="tier-b">{text('activity.pendingLead')}</p>
              {pending?.complete === false && <p className="tier-b">{text('activity.pendingPartial')}</p>}
              <ul className="rows activity-list">
                {pendingLines.map((l) => (
                  <Line key={l.key} line={l} chain={chain} account={account} meta={meta} copy={copy} />
                ))}
              </ul>
            </div>
          )}
          {pendingLines.length === 0 && pending?.complete === false && <p className="tier-b">{text('activity.pendingPartial')}</p>}

          {query.data !== undefined && lines.length === 0 && !query.hasNextPage && unreadable === 0 && !repairsUnknown && (
            <p className="tier-b home-empty" data-testid="activity-empty">
              {format('activity.empty', { chain: chain.name })}
            </p>
          )}
          {lines.length > 0 && (
            <ul className="rows activity-list" data-testid="activity-rows">
              {lines.map((l) => (
                <Line key={l.key} line={l} chain={chain} account={account} meta={meta} copy={copy} />
              ))}
            </ul>
          )}
          {query.hasNextPage && (
            <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid="activity-more">
              {text(query.isFetchingNextPage ? 'activity.readingMore' : 'activity.more')}
            </button>
          )}
          {query.data !== undefined && lines.length > 0 && !query.hasNextPage && walletComplete === true && !repairsUnknown && (
            <p className="tier-b" data-testid="activity-end">
              {format('activity.end', { chain: chain.name })}
            </p>
          )}
          <WhyLink summaryKey="activity.whySummary" detailKey="activity.why" />
        </section>
      )}
    </main>
  );
}

function Line({ line, chain, account, meta, copy }: { line: ActivityLine; chain: SupportedChain; account: Hex; meta: TokenMetaMap | null; copy: CopyAccess }) {
  if (line.kind === 'repair') return <RepairLine repair={line.repair} copy={copy} />;
  const { text, format } = copy;
  const e = line.lead;
  const time = e.blockAt !== null ? formatUtc(e.blockAt) : null;
  const by =
    e.actor === null ? text('activity.byNobody') : e.actor === account.toLowerCase() ? text('activity.byYou') : format('activity.byOther', { address: shortAddress(e.actor) });
  return (
    <li className="card activity-row" data-kind={e.kind} data-final={line.final} data-testid={`activity-${line.key}`}>
      <p>
        {!line.final && <span className="alert-new">{text('activity.pendingBadge')}</span>} {eventLine(e, copy)}
        <Refs event={e} copy={copy} />
      </p>
      <p className="tier-b" data-testid={`activity-${line.key}-amount`}>
        {amountLine(e, meta, copy)}
      </p>
      <p className="tier-b">
        {by}
        {' · '}
        {time !== null ? <time dateTime={new Date(e.blockAt! * 1000).toISOString()}>{time}</time> : text('activity.noTime')}
        {e.txHash !== null && (
          <>
            {' · '}
            <a href={`${chain.blockExplorer}/tx/${e.txHash}`} target="_blank" rel="noreferrer">
              {text('activity.viewTx')}
            </a>
          </>
        )}
      </p>
      {line.rest.length > 0 && (
        <details className="activity-rest" data-testid={`activity-${line.key}-rest`}>
          <summary>{line.rest.length === 1 ? text('activity.oneMoreInTx') : format('activity.moreInTx', { count: String(line.rest.length) })}</summary>
          <ul>
            {line.rest.map((r) => (
              <li key={`${r.blockNumber}:${r.logIndex}`} data-kind={r.kind}>
                {eventLine(r, copy)}
                <Refs event={r} copy={copy} />
                {r.amount !== null || r.tokenId !== null ? ` · ${amountLine(r, meta, copy)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function eventLine(e: ActivityEvent, { text, format }: CopyAccess): string {
  const key = kindKey(e.kind);
  return key === null ? format('activity.unknownKind', { kind: e.kind }) : text(key);
}

/** The loan and the offer an event names, as links to their pages. */
function Refs({ event: e, copy: { format } }: { event: ActivityEvent; copy: CopyAccess }) {
  return (
    <>
      {e.loanId !== null && (
        <>
          {' '}
          <Link to={`/positions/${e.loanId.toString()}`}>{format('activity.openLoan', { id: e.loanId.toString() })}</Link>
        </>
      )}
      {e.offerId !== null && (
        <>
          {' '}
          <Link to={`/offers/${e.offerId.toString()}`}>{format('activity.openOffer', { id: e.offerId.toString() })}</Link>
        </>
      )}
    </>
  );
}

function RepairLine({ repair: r, copy: { text, format } }: { repair: RepairEntry; copy: CopyAccess }) {
  const known = ['repaid', 'defaulted', 'settled', 'internal_matched'];
  const status = known.includes(r.observedStatus) ? text(`activity.status.${r.observedStatus}` as CopyKey) : format('activity.status.other', { status: r.observedStatus });
  return (
    <li className="card activity-row" data-kind="repair" data-testid={`activity-repair-${r.loanId.toString()}`}>
      <p>
        <Link to={`/positions/${r.loanId.toString()}`}>{format('activity.repaired', { id: r.loanId.toString(), status, block: String(r.observedBlock) })}</Link>
      </p>
      <p className="tier-b">{r.observedAt !== null ? format('activity.repairedWhen', { time: formatUtc(r.observedAt) }) : text('activity.repairedNoTime')}</p>
    </li>
  );
}
