/**
 * Activity — the wallet's Vaipakam history (advanced navigation).
 * Rows come from the indexer; kinds are shown as readable labels with
 * loan/offer links back into the app.
 */
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, History, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useModal } from 'connectkit';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { useMyLoansFull } from '../data/hooks';
import {
  fetchActivity,
  fetchParticipantLoanIds,
  type IndexedActivityEvent,
} from '../data/indexer';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { MarketFreshnessNote } from '../components/MarketFreshnessNote';
import { formatTimeAgo, shortAddress } from '../lib/format';
import { coalesceByTx, type ActivityRowView } from '../lib/activityView';
import { signalAware } from '../chain/railHealth';

/** UX-008 — one coalesced transaction as a readable row: plain-language
 *  action, a single substance sub-line (loan/offer id · who acted · when
 *  · how many sub-events it stood in for), and an explorer link. */
function ActivityRow({ row, explorer }: { row: ActivityRowView; explorer: string }) {
  const { event, label, hiddenCount } = row;
  // Prefer the translated catalog label for a known event kind; fall
  // back to the pure module's humanized label for a kind the app
  // doesn't map yet (English — unavoidable for an unknown event).
  const displayLabel = copy.activity.labels[event.kind] ?? label;
  const context = [
    event.loanId !== null ? copy.activity.loanRef(event.loanId) : null,
    event.offerId !== null ? copy.activity.offerRef(event.offerId) : null,
  ].filter(Boolean);

  const sub = (
    <span className="row-sub">
      {context.length ? `${context.join(' · ')} · ` : ''}
      {formatTimeAgo(event.blockAt)}
      {hiddenCount > 0 ? copy.activity.plusMore(hiddenCount) : ''}
    </span>
  );

  const inner = (
    <span className="row-main">
      <span className="row-title">{displayLabel}</span>
      <br />
      {sub}
    </span>
  );

  return (
    <div className="item-row activity-row">
      {event.loanId !== null ? (
        <Link to={`/positions/${event.loanId}`} className="activity-row-link">
          {inner}
        </Link>
      ) : (
        inner
      )}
      {event.txHash ? (
        <a
          className="activity-tx"
          href={`${explorer}/tx/${event.txHash}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`${copy.activity.viewTx} ${shortAddress(event.txHash)}`}
          title={copy.activity.viewTx}
        >
          <ExternalLink size={14} aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

/** Client-side reveal page size — caps the initial DOM (the old feed
 *  rendered ~5,500px unpaginated). */
const PAGE = 25;

/** The non-empty feed: coalesce the raw events per transaction, then
 *  reveal them in pages. Kept separate so the hooks (useMemo) don't sit
 *  behind the page's conditional branches. */
function ActivityFeed({
  events,
  truncated,
  explorer,
  visible,
  onLoadMore,
}: {
  events: IndexedActivityEvent[];
  truncated: boolean;
  explorer: string;
  visible: number;
  onLoadMore: () => void;
}) {
  const rows = useMemo(() => coalesceByTx(events), [events]);
  const shown = rows.slice(0, visible);
  const hasMore = rows.length > visible;

  return (
    <>
      {/* Activity stays INDEXER-fed (events have no chain view), so a
          stalled ingest cursor means recent actions may be missing —
          the self-gating freshness note says so. */}
      <MarketFreshnessNote />
      {truncated ? (
        <div className="banner banner-info" role="status" style={{ marginBottom: 12 }}>
          <span className="banner-body">{copy.activity.truncatedNote}</span>
        </div>
      ) : null}
      <div className="row-list">
        {shown.map((row) => (
          <ActivityRow key={row.key} row={row} explorer={explorer} />
        ))}
      </div>
      {hasMore ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: 12 }}
          onClick={onLoadMore}
        >
          {copy.activity.loadMore}
        </button>
      ) : null}
    </>
  );
}

export function Activity() {
  const { isConnected, readChain, address } = useActiveChain();
  const { setOpen } = useModal();
  const loans = useMyLoansFull();
  // Client-side reveal count (UX-008 pagination).
  const [visible, setVisible] = useState(PAGE);
  // Reset the reveal depth when the feed IDENTITY changes (Codex #1171
  // r2): otherwise a wallet/chain switch keeps a previously-expanded
  // count and the new account skips its intended 25-row first page.
  useEffect(() => {
    setVisible(PAGE);
  }, [address, readChain.chainId]);

  // The worker's actor column is non-exhaustive (a keeper-triggered
  // LoanDefaulted has actor null; OfferAccepted stores only the
  // acceptor), so fetch broadly and keep an event when the wallet is a
  // PARTICIPANT: recorded actor, mentioned in the event args, or the
  // event belongs to one of the wallet's own loans.
  // The filter needs the wallet's loan-id set INCLUDING the indexer
  // leg: the live chain enumeration only sees currently-held position
  // NFTs, so a chain-only fallback would silently drop actor-null
  // events for closed/transferred loans. `loansUsable` is therefore
  // "both loan sources answered", not merely "some rows exist".
  // The set is the UNION of rendered rows (chain-sole-source when the
  // chain answers — freshest, includes a just-initiated loan the
  // indexer hasn't ingested), the indexed leg's own ids (which keep a
  // just-burned/transferred loan through the ingest-lag window), and
  // the PERMANENT historical-participant ids below (#1023) — every
  // loan the wallet ever touched, so actor-null events for
  // long-closed/transferred positions stop being silently dropped.
  //
  // #1023 — the wallet's permanent loan-participation ids via
  // /loans/by-participant?scope=all&fields=ids: ONE bounded response
  // (server cap 5,000 ids + `truncated`), no cursor walk, and the
  // ids-shape response doubles as the deploy-skew guard (a pre-#1023
  // worker answers the loans shape → fail closed to unavailable, per
  // Codex #1287 r1 — never a silently desk-scoped filter). `null` =
  // unavailable — the feed must NOT run without this leg, or the
  // exact gap this closes would silently reopen.
  const participantLeg = useQuery({
    queryKey: [
      'activityParticipantIds',
      readChain.chainId,
      address?.toLowerCase(),
    ],
    enabled: Boolean(address),
    // Participation grows on loan.created / ownership.changed pushes
    // (KEY_MAP maps both onto this root) and own receipts (the
    // receipt floor carries it); the interval is the poll fallback
    // (RPC read-diet PR A posture).
    refetchInterval: signalAware(60_000),
    queryFn: () => fetchParticipantLoanIds(readChain.chainId, address!),
  });
  const loansUsable =
    loans.data != null && loans.data.indexerOk && participantLeg.data != null;
  const myLoanIds = useMemo(() => {
    if (!loansUsable) return new Set<number>();
    const ids = new Set(loans.data!.rows.map((l) => l.loanId));
    for (const id of loans.data!.indexedLoanIds) ids.add(id);
    for (const id of participantLeg.data!.ids) ids.add(id);
    return ids;
  }, [loansUsable, loans.data, participantLeg.data]);
  // A >5,000-participation wallet's oldest loan ids are missing from
  // the filter — even a RECENT actor-null event on one of those old
  // loans can be dropped, so the disclosure below states "may be
  // missing some events", not merely "older history not shown"
  // (Codex #1287 r1).
  const participantTruncated = participantLeg.data?.truncated === true;

  const activity = useQuery({
    queryKey: [
      'activity',
      readChain.chainId,
      address?.toLowerCase(),
      myLoanIds.size,
    ],
    // The participant filter NEEDS the wallet's loan-id set: with the
    // loan sources unavailable (or the indexer leg missing — see
    // loansUsable), actor-null events tied to the wallet only by
    // loanId would be silently dropped and the feed would render
    // confidently incomplete. Wait for a usable loan list.
    enabled: Boolean(address) && loansUsable,
    // RPC read-diet PR A — activity.appended push covers the feed.
    refetchInterval: signalAware(60_000),
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
        // Stop on DISTINCT-TRANSACTION count, not raw events (Codex
        // #1171 r1): loan actions emit LoanInitiated/*Details/Transfer
        // companions, so 50 raw events can collapse to far fewer than
        // one reveal page — stopping on raw count would show the
        // truncated banner yet offer no "load older" path. 50 distinct
        // txs ⇒ ~50 coalesced rows ⇒ a real second reveal page.
        const distinctTx = new Set(mine.map((e) => e.txHash || `${e.blockNumber}:${e.logIndex}`));
        if (distinctTx.size >= 50) break; // plenty of rows — still truncated
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
      ) : loans.isLoading ||
        loans.data === undefined ||
        participantLeg.data === undefined ? (
        <EmptyState icon={LoaderCircle} title={copy.activity.loading} />
      ) : loans.data === null ||
        !loans.data.indexerOk ||
        participantLeg.data === null ? (
        // Loan sources unavailable (indexer leg missing, or the #1023
        // participant-history leg failed) → the participation filter
        // can't run; an activity feed built without it would be
        // silently partial.
        <>
          <UnavailableState body={copy.activity.unavailable} />
          <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
            {copy.activity.unavailableFallback}{' '}
            <Link to="/positions">{copy.activity.positionsLink}</Link>.
          </p>
        </>
      ) : activity.isLoading || activity.data === undefined ? (
        <EmptyState icon={LoaderCircle} title={copy.activity.loading} />
      ) : activity.data === null ? (
        <>
          <UnavailableState body={copy.activity.unavailable} />
          <p className="muted" style={{ textAlign: 'center', marginTop: 12 }}>
            {copy.activity.unavailableFallback}{' '}
            <Link to="/positions">{copy.activity.positionsLink}</Link>.
          </p>
        </>
      ) : activity.data.events.length === 0 ? (
        <>
          {/* A STALLED indexer returning zero rows is exactly the
              misleading empty feed — the self-gating note must cover
              this branch too, not only the non-empty one. */}
          <MarketFreshnessNote />
          {participantTruncated ? (
            <p className="muted" role="status">
              {copy.activity.participantTruncatedNote}
            </p>
          ) : null}
          <EmptyState
            icon={History}
            title={
              /* UX2-007 tail — the recent-only hedge stays for every
                 truncated case (its wording states the page's scope
                 without implying hidden history exists — Codex #1200).
                 #1023 shipped the participant-history leg, which now
                 catches a returning wallet's LOAN events beyond the
                 scan window — but OFFER-only history (a posted-and-
                 cancelled offer older than the scan) is still outside
                 any loan-id set, so a truncated-with-nothing feed
                 still can't claim "no activity ever" definitively. */
              activity.data.truncated || participantTruncated
                ? copy.activity.truncatedEmpty
                : copy.activity.empty
            }
            action={
              /* UX2-007 — a brand-new wallet's empty feed pointed
                 nowhere; hand over the first move instead (the UX-023
                 forward-CTA pattern). The degraded (truncated) state
                 keeps its hedged title but gets the same forward path
                 — either way, the answer to "no activity" is to do
                 something. */
              <div className="cluster" style={{ justifyContent: 'center' }}>
                <Link to="/borrow" className="btn btn-secondary">
                  {copy.activity.emptyCtaBorrow}
                </Link>
                <Link to="/lend" className="btn btn-secondary">
                  {copy.activity.emptyCtaLend}
                </Link>
              </div>
            }
          />
        </>
      ) : (
        <>
          {participantTruncated ? (
            <p className="muted" role="status">
              {copy.activity.participantTruncatedNote}
            </p>
          ) : null}
          <ActivityFeed
            events={activity.data.events}
            truncated={activity.data.truncated}
            explorer={readChain.blockExplorer}
            visible={visible}
            onLoadMore={() => setVisible((v) => v + PAGE)}
          />
        </>
      )}
    </div>
  );
}
