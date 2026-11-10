import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { CopyAccess, CopyKey } from '../../shared/copy/useCopy';
import { readHistoryPage, type HistoryRow, type HistoryStatus } from '../../shared/desk/history';
import { loansInMarket, type Market } from '../../shared/desk/markets';
import { BOOK_POLL_MS, indexReason } from '../../shared/offers/OfferBook';
import { ReadState } from '../../shared/positions/PositionSections';
import { usePositionBook } from '../../shared/positions/usePositionBook';
import { worldKey } from '../../shared/reads/identityKey';
import { assetName, tokenAmount, useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { formatBps, formatScaled, formatUtc } from '../../shared/ui/format';

type Hex = `0x${string}`;
type MarketTerms = Pick<Market, 'lending' | 'collateral' | 'durationDays'>;

const STATUS: Readonly<Record<HistoryStatus, CopyKey>> = {
  active: 'desk.statusActive',
  repaid: 'desk.statusRepaid',
  defaulted: 'desk.statusDefaulted',
  liquidated: 'desk.statusLiquidated',
  settled: 'desk.statusSettled',
  internal_matched: 'desk.statusMatched',
  fallback_pending: 'desk.statusFallback',
  unknown: 'desk.statusUnknown',
};

/**
 * OFF-76 — the viewer's own loans in the selected market, from its own
 * chain read of its positions (the one inventory Positions reads), each
 * with its health reading and a way into the loan, where the protocol's
 * verdict decides what can be done (RB-ELIG). The desk signs nothing here.
 */
export function MarketLoans({ market, meta, copy }: { market: MarketTerms; meta: TokenMetaMap | null; copy: CopyAccess }) {
  const { text, format } = copy;
  const book = usePositionBook();
  return (
    <section className="home-section" aria-labelledby="desk-loans-title" data-testid="desk-loans">
      <h2 id="desk-loans-title">{text('desk.loansTitle')}</h2>
      <ReadState read={book.loans}>
        {(data) => {
          const rows = loansInMarket(data.rows, market);
          return (
            <>
              {!data.complete && <p className="tier-a">{text('desk.loansIncomplete')}</p>}
              {rows.length === 0 ? (
                data.complete &&
                book.loans.error === null && (
                  <p className="tier-b home-empty" data-testid="desk-loans-none">
                    {text('desk.loansNone')}
                  </p>
                )
              ) : (
                <ul className="tape-rows">
                  {rows.map((r) => {
                    const id = r.loan.id.toString();
                    const terms = {
                      id,
                      amount: tokenAmount(r.loan.principal, r.loan.principalAsset, meta, format),
                      rate: formatBps(r.loan.interestRateBps),
                    };
                    return (
                      <li
                        key={`${id}-${r.borrowerSide ? 'b' : 'l'}`}
                        data-testid="desk-loan"
                        data-loan-id={id}
                        data-side={r.borrowerSide ? 'borrower' : 'lender'}
                      >
                        <p>{format(r.borrowerSide ? 'desk.loanBorrowed' : 'desk.loanLent', terms)}</p>
                        <p className="tier-b" data-testid="desk-loan-health">
                          {r.healthFactor > 0n ? format('positions.loanHealth', { hf: formatScaled(r.healthFactor) }) : text('positions.loanHealthNone')}
                        </p>
                        <Link to={`/positions/${id}`}>{format('desk.loanManage', { id })}</Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          );
        }}
      </ReadState>
    </section>
  );
}

/**
 * OFF-76 — the viewer's desk history from the index: every token loan
 * against token collateral it has held a side of, any status, newest
 * participation first, a page at a time. The status is the index's record;
 * each row opens the loan, whose page reads the chain.
 */
export function DeskHistory({ viewer, copy }: { viewer: Hex; copy: CopyAccess }) {
  const { text, format } = copy;
  const world = useWorldRail();
  const noIndex = world.indexer.origin === null;
  const history = useInfiniteQuery({
    queryKey: worldKey(world.chainId, 'deskHistory', viewer.toLowerCase()),
    queryFn: ({ pageParam }) => readHistoryPage(world.indexer, world.chainId, viewer, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !noIndex,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const pages = history.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const unread = pages.reduce((n, p) => n + p.unread, 0);
  const meta = useTokenMeta(rows.flatMap((r) => [r.lending, r.collateral])).data;
  const failed = noIndex || history.status === 'error';
  const reason = noIndex ? text('offerBook.noIndex') : indexReason(history.error, text);
  const olderFailed = history.isFetchNextPageError;
  const loaded = history.data !== undefined;
  return (
    <section className="home-section" aria-labelledby="desk-history-title" data-testid="desk-history">
      <h2 id="desk-history-title">{text('desk.historyTitle')}</h2>
      <p className="tier-b">{text('desk.historyLead')}</p>
      {failed && !olderFailed && (
        <p className="tier-a" data-testid="desk-history-failed">
          {format(loaded ? 'desk.historyFailedCached' : 'desk.historyFailed', { reason })}
        </p>
      )}
      {!failed && !loaded && <p className="tier-b">{text('desk.historyReading')}</p>}
      {loaded && (
        <>
          {unread > 0 && <p className="tier-a">{format('desk.historyUnread', { count: String(unread) })}</p>}
          {rows.length === 0 && unread === 0 && !history.hasNextPage && (
            <p className="tier-b home-empty" data-testid="desk-history-none">
              {text('desk.historyNone')}
            </p>
          )}
          {rows.length > 0 && (
            <ol className="tape-rows">
              {rows.map((r) => (
                <HistoryLine key={r.loanId.toString()} row={r} meta={meta} copy={copy} />
              ))}
            </ol>
          )}
          {olderFailed && (
            <p className="tier-a" data-testid="desk-history-older-failed">
              {format('desk.historyOlderFailed', { reason: indexReason(history.error, text) })}
            </p>
          )}
          {history.hasNextPage ? (
            <button
              type="button"
              className="btn"
              onClick={() => void history.fetchNextPage()}
              disabled={history.isFetchingNextPage}
              data-testid="desk-history-older"
            >
              {text(history.isFetchingNextPage ? 'desk.historyOlderReading' : 'desk.historyOlder')}
            </button>
          ) : (
            rows.length > 0 && (
              <p className="tier-b" data-testid="desk-history-end">
                {text('desk.historyEnd')}
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}

function HistoryLine({ row: r, meta, copy }: { row: HistoryRow; meta: TokenMetaMap | null; copy: CopyAccess }) {
  const { text, format } = copy;
  const id = r.loanId.toString();
  const market = format('desk.marketName', { lending: assetName(r.lending, meta), collateral: assetName(r.collateral, meta), days: String(r.durationDays) });
  const side = r.lent && r.borrowed ? 'desk.historyBoth' : r.lent ? 'desk.historyLent' : 'desk.historyBorrowed';
  return (
    <li data-testid="desk-history-row" data-loan-id={id} data-status={r.status} data-lent={String(r.lent)} data-borrowed={String(r.borrowed)}>
      <Link to={`/positions/${id}`}>{format('desk.historyRow', { id, market })}</Link>
      <p className="tier-b">
        {text(side)} {format('desk.historyStatus', { status: text(STATUS[r.status]) })}
      </p>
      <p className="tier-b">{format('desk.historyWhen', { when: formatUtc(r.participatedAt) })}</p>
    </li>
  );
}
