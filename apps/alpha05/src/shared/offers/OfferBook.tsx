import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getSupportedChain, DEFAULT_CHAIN } from '../../chain/chains';
import { useCopy, type CopyAccess, type CopyKey } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { ASSET_ERC20, OFFER_TYPE_LENDER } from '../positions/model';
import { assetName, tokenAmount, useTokenMeta, type TokenMetaMap } from '../reads/tokens';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { formatUtc, shortAddress } from '../ui/format';
import { useNow } from '../ui/useNow';
import { BOOK_SIDES, BOOK_TABS, inBook, lapsed, readBookPage, type BookKind, type BookRow, type BookSide, type BookTab } from './book';
import { offerLine } from './offerLine';

type Hex = `0x${string}`;

const TAB_KEY: Record<BookTab, CopyKey> = { loans: 'offerBook.tabLoans', rentals: 'offerBook.tabRentals' };
const SIDE_KEY: Record<BookSide, CopyKey> = { all: 'offerBook.sideAll', lender: 'offerBook.sideLender', borrower: 'offerBook.sideBorrower' };
const KIND_KEY: Partial<Record<BookKind, CopyKey>> = {
  refinance: 'offerBook.tagRefinance',
  'refinance-unknown': 'offerBook.tagRefinanceUnknown',
  'loan-sale': 'offerBook.tagLoanSale',
  offset: 'offerBook.tagOffset',
};

/** How often the book re-reads while visible; the push rail invalidates it
 *  sooner whenever the index changes. */
export const BOOK_POLL_MS = 60_000;

function indexReason(e: unknown, text: CopyAccess['text']): string {
  if (e instanceof IndexerUnavailable) {
    return text(
      e.why === 'not-configured' ? 'offerBook.noIndex' : e.why === 'network' ? 'offerBook.indexNetwork' : e.why === 'status' ? 'offerBook.indexStatus' : 'offerBook.indexShape',
    );
  }
  return (e as Error | null)?.message ?? '';
}

/** The collateral an offer asks for or pledges, in words. */
function collateralText(r: BookRow, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  return r.collateralAssetType === ASSET_ERC20
    ? tokenAmount(r.collateralAmount, r.collateralAsset, meta, format)
    : format('asset.nft', { id: r.collateralTokenId.toString(), asset: assetName(r.collateralAsset, meta) });
}

/**
 * The offer book (OFF-39, OFF-40, OFF-43): every open offer on the screen's
 * network, newest first, from the index (the world rail), in two tabs
 * (loans of a token, NFT rentals), with a side filter and, when a wallet is
 * connected, a switch that hides its own offers. Each row opens the offer's
 * detail page, which reads it from the chain before anything is offered.
 * Older offers are read a page at a time with "Show more"; a filter applies
 * to what has been read so far, and the page says how many that is. A
 * failed read is a degraded-source warning, never an empty book.
 */
export function OfferBook({ viewer }: { viewer: Hex | null }) {
  const copy = useCopy();
  const { text, format } = copy;
  const world = useWorldRail();
  const chain = getSupportedChain(world.chainId) ?? DEFAULT_CHAIN;
  const [tab, setTab] = useState<BookTab>('loans');
  const [side, setSide] = useState<BookSide>('all');
  const [hideMine, setHideMine] = useState(false);
  const book = useInfiniteQuery({
    queryKey: worldKey(world.chainId, 'offerBook'),
    queryFn: ({ pageParam }) => readBookPage(world.indexer, world.chainId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: world.indexer.origin !== null,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const pages = book.data?.pages ?? [];
  const all = pages.flatMap((p) => p.rows);
  const unread = pages.reduce((n, p) => n + p.unread, 0);
  const rows = all.filter((r) => inBook(r, { tab, side, hide: hideMine ? viewer : null }));
  const meta = useTokenMeta(all.flatMap((r) => [r.lendingAsset, r.collateralAsset, r.prepayAsset])).data;
  const failed = world.indexer.origin === null || book.status === 'error';
  const reason = world.indexer.origin === null ? text('offerBook.noIndex') : indexReason(book.error, text);
  const nowSec = useNow() / 1000;

  return (
    <section className="home-section offer-book" aria-labelledby="offer-book-title" data-testid="offer-book">
      <h2 id="offer-book-title">{text('offerBook.title')}</h2>
      <p className="tier-b">{format('offerBook.lead', { chain: chain.name })}</p>
      <div className="offers-filters" role="group" aria-label={text('offerBook.tabLabel')} data-testid="offer-book-tabs">
        {BOOK_TABS.map((t) => (
          <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} data-testid={`offer-book-tab-${t}`}>
            {text(TAB_KEY[t])}
          </button>
        ))}
      </div>
      <div className="offers-filters" role="group" aria-label={text('offerBook.sideLabel')} data-testid="offer-book-sides">
        {BOOK_SIDES.map((s) => (
          <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} data-testid={`offer-book-side-${s}`}>
            {text(SIDE_KEY[s])}
          </button>
        ))}
      </div>
      {viewer !== null && (
        <label className="choice">
          <input type="checkbox" checked={hideMine} onChange={(e) => setHideMine(e.target.checked)} data-testid="offer-book-hide-mine" />
          <span>{text('offerBook.hideMine')}</span>
        </label>
      )}
      {failed && (
        <p className="tier-a" data-testid="offer-book-failed">
          {format(book.data ? 'offerBook.failedCached' : 'offerBook.failed', { reason })}
        </p>
      )}
      {!failed && book.data === undefined && <p className="tier-b">{text('offerBook.reading')}</p>}
      {unread > 0 && <p className="tier-a">{format('offerBook.unread', { count: String(unread) })}</p>}
      {book.data !== undefined && (
        <>
          <p className="tier-b" data-testid="offer-book-count">
            {format(book.hasNextPage ? 'offerBook.countMore' : 'offerBook.countAll', { shown: String(rows.length), read: String(all.length) })}
          </p>
          {rows.length > 0 && (
            <ul className="rows offers-list" data-testid="offer-book-rows">
              {rows.map((r) => (
                <BookRowItem key={r.id.toString()} row={r} viewer={viewer} meta={meta} copy={copy} expired={lapsed(r, nowSec)} />
              ))}
            </ul>
          )}
          {book.hasNextPage && (
            <button type="button" className="btn" disabled={book.isFetchingNextPage} onClick={() => void book.fetchNextPage()} data-testid="offer-book-more">
              {text(book.isFetchingNextPage ? 'offerBook.reading' : 'offerBook.more')}
            </button>
          )}
        </>
      )}
      <WhyLink summaryKey="offerBook.whySummary" detailKey="offerBook.why" />
    </section>
  );
}

function BookRowItem({ row: r, viewer, meta, copy, expired }: { row: BookRow; viewer: Hex | null; meta: TokenMetaMap | null; copy: CopyAccess; expired: boolean }) {
  const { text, format } = copy;
  const id = r.id.toString();
  const mine = viewer !== null && r.creator.toLowerCase() === viewer.toLowerCase();
  const lend = r.offerType === OFFER_TYPE_LENDER;
  const kind = KIND_KEY[r.kind];
  return (
    <li className="card" data-offer-id={id} data-testid={`book-row-${id}`}>
      <p className="row-head">
        <Link to={`/offers/${id}`} data-testid={`book-link-${id}`}>
          {offerLine(r, meta, copy)}
        </Link>
      </p>
      <p className="tier-b">{format(lend ? 'offerBook.collateralAsked' : 'offerBook.collateralPledged', { collateral: collateralText(r, meta, format) })}</p>
      <p className="tier-b">
        {mine ? text('offerBook.byYou') : format('offerBook.byCreator', { address: shortAddress(r.creator) })}
        {r.expiresAt > 0n && !expired && <> · {format('home.offerExpires', { when: formatUtc(Number(r.expiresAt)) })}</>}
      </p>
      <p className="row-badges">
        {expired && (
          <span className="badge" data-testid={`book-expired-${id}`}>
            {text('offerBook.tagExpired')}
          </span>
        )}
        {kind !== undefined && <span className="badge">{text(kind)}</span>}
        {r.moved === true && <span className="badge">{text('offerBook.tagMoved')}</span>}
      </p>
    </li>
  );
}
