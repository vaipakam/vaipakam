import { useQuery } from '@tanstack/react-query';
import type { SupportedChain } from '../../chain/chains';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../../shared/copy/useCopy';
import { lapseText, orderSentence } from '../../shared/desk/cancelSigned';
import { marketKey } from '../../shared/desk/markets';
import type { SignedMarket, SignedStanding } from '../../shared/desk/mySignedOrders';
import { freeKey, makerCover, readMarketSignedBook, readSignedBookChain, type BookSignedOrder, type SignedBookChain } from '../../shared/desk/signedBook';
import { signedCeiling, signedStakeLeft } from '../../shared/desk/signedOrder';
import { WhyLink } from '../../shared/help/WhyLink';
import { BOOK_POLL_MS, indexReason } from '../../shared/offers/OfferBook';
import { worldKey } from '../../shared/reads/identityKey';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;

const STANDING_KEY: Readonly<
  Record<Exclude<SignedStanding, 'partly-filled'>, 'signedBook.open' | 'signedBook.used' | 'signedBook.nonceDone' | 'signedBook.lapsed' | 'signedBook.unread'>
> = {
  open: 'signedBook.open',
  used: 'signedBook.used',
  'nonce-cancelled': 'signedBook.nonceDone',
  lapsed: 'signedBook.lapsed',
  unread: 'signedBook.unread',
};

/**
 * OFF-60 (slice 1) — every maker's signed orders on the market the desk
 * shows, as the offer book lists them, each with where the chain stands on
 * it, what is left of it to fill, and whether its maker's vault holds free
 * what a fill would draw now. Filling one is not offered yet, and the
 * section says why rather than offering a button: the protocol has no
 * preview of a signed fill, so the taker could not see the fill's figures
 * before paying (#3552).
 */
export function DeskSignedBook({
  market,
  chain,
  own,
  meta,
  copy,
}: {
  market: SignedMarket;
  chain: SupportedChain;
  own: OwnStateClient;
  meta: TokenMetaMap | null;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const world = useWorldRail();
  const noIndex = world.indexer.origin === null;
  const key = marketKey(market);
  const book = useQuery({
    queryKey: worldKey(world.chainId, 'signedBook', key),
    queryFn: () => readMarketSignedBook(world.indexer, world.chainId, market),
    enabled: !noIndex,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const orders = book.data ? [...book.data.asks, ...book.data.bids] : [];
  const chainRead = useOwnRead(
    ['signedBook', chain.diamondAddress, ...orders.map((o) => o.orderHash)],
    (c) => readSignedBookChain(c, chain.diamondAddress, orders),
    {
      enabled: orders.length > 0,
      perBlock: true,
    },
  );
  const failed = noIndex || book.status === 'error';
  const stale = chainRead.state === 'ready' && chainRead.error !== null;
  const amount = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);

  const side = (titleKey: 'signedBook.asksTitle' | 'signedBook.bidsTitle', list: readonly BookSignedOrder[], testId: string) => (
    <div data-testid={testId}>
      <h3>{text(titleKey)}</h3>
      {list.length === 0 ? (
        <p className="tier-b">{text('signedBook.sideNone')}</p>
      ) : (
        <ul className="offer-rows">
          {list.map((o) => (
            <SignedRow key={o.orderHash} o={o} chainRead={chainRead.data ?? null} viewer={own.account} amount={amount} copy={copy} />
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="home-section" aria-labelledby="desk-signed-book-title" data-testid="desk-signed-book" data-market={key}>
      <h2 id="desk-signed-book-title">{text('signedBook.title')}</h2>
      <p className="tier-b">{text('signedBook.lead')}</p>
      <p className="tier-a" data-testid="desk-signed-book-not-yet">
        {text('signedBook.notYet')}
      </p>
      {failed && (
        <p className="tier-a" data-testid="desk-signed-book-failed">
          {format(book.data ? 'signedBook.failedCached' : 'signedBook.failed', { reason: noIndex ? text('offerBook.noIndex') : indexReason(book.error, text) })}
        </p>
      )}
      {!failed && book.data === undefined && <p className="tier-b">{text('signedBook.reading')}</p>}
      {book.data !== undefined && (
        <>
          {orders.length === 0 && book.data.unread === 0 && (
            <p className="tier-b home-empty" data-testid="desk-signed-book-none">
              {text('signedBook.none')}
            </p>
          )}
          {book.data.unread > 0 && <p className="tier-a">{format('signedBook.unreadRows', { count: String(book.data.unread) })}</p>}
          {book.data.truncated && <p className="tier-a">{text('signedBook.truncated')}</p>}
          {chainRead.state === 'failed' && <p className="tier-a">{format('signedBook.standingFailed', { reason: chainRead.error ?? '' })}</p>}
          {stale && (
            <p className="tier-a" data-testid="desk-signed-book-stale">
              {format('signedBook.standingStale', { reason: chainRead.error ?? '' })}
            </p>
          )}
          {orders.length > 0 && (
            <>
              <p className="tier-b">{text('signedBook.shared')}</p>
              {side('signedBook.asksTitle', book.data.asks, 'desk-signed-book-asks')}
              {side('signedBook.bidsTitle', book.data.bids, 'desk-signed-book-bids')}
            </>
          )}
        </>
      )}
      <WhyLink summaryKey="signedBook.whySummary" detailKey="signedBook.why" />
    </section>
  );
}

/** One order: its terms, its maker, its lapse and standing on the chain,
 *  and its maker's vault against what a fill of the rest would draw. */
function SignedRow({
  o,
  chainRead,
  viewer,
  amount,
  copy,
}: {
  o: BookSignedOrder;
  chainRead: SignedBookChain | null;
  viewer: Hex;
  amount: (asset: Hex, v: bigint) => string;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const s: SignedStanding = chainRead?.standings.get(o.orderHash) ?? 'unread';
  const filled = chainRead?.filled.get(o.orderHash);
  const stake = signedStakeLeft(o.order, 0n).asset;
  const cover = makerCover(o.order, s, filled, chainRead?.free.get(freeKey(o.order.signer, stake)));
  const lending = o.order.lendingAsset as Hex;
  const ceiling = signedCeiling(o.order);
  const mine = o.order.signer === viewer.toLowerCase();
  return (
    <li data-testid="desk-signed-book-order" data-order-hash={o.orderHash} data-standing={s} data-cover={cover.kind} data-maker={o.order.signer}>
      <p>{orderSentence(o.order, amount, copy)}</p>
      <p className="tier-b">{mine ? text('signedBook.yours') : format('signedBook.maker', { maker: shortAddress(o.order.signer) })}</p>
      <p className="tier-b">
        {lapseText(o.order, copy)}{' '}
        {s === 'partly-filled'
          ? format('signedBook.partlyFilled', {
              filled: amount(lending, filled ?? 0n),
              ceiling: amount(lending, ceiling),
              left: amount(lending, ceiling - (filled ?? 0n)),
            })
          : text(STANDING_KEY[s])}
      </p>
      {cover.kind === 'covers' && <p className="tier-b">{format('signedBook.covers', { free: amount(stake, cover.free), need: amount(stake, cover.need) })}</p>}
      {cover.kind === 'short' && (
        <p className="tier-a" data-testid="desk-signed-book-short">
          {format('signedBook.short', { free: amount(stake, cover.free), need: amount(stake, cover.need) })}
        </p>
      )}
      {cover.kind === 'unread' && <p className="tier-a">{text('signedBook.coverUnread')}</p>}
    </li>
  );
}
