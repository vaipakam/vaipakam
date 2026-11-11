import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
import { AcceptOffer } from '../../shared/accept/AcceptOffer';
import { TermsPrompt } from '../../shared/terms/TermsPrompt';
import { useTerms } from '../../shared/terms/useTerms';
import { useTermsGate } from '../../shared/terms/useTermsGate';
import { useStoredValue } from '../../shared/tx/txStore';

/** The store key a signed order's fill keeps its state under (its review,
 *  consent and transaction), so a navigation never drops one in flight. */
export const SIGNED_FILL_KEY = 'desk.signedFill';

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

/** The desk's one signed-fill slot (see `DeskSignedBook`). */
interface FillSlot {
  order: BookSignedOrder;
  /** True while the Terms prompt is accepted first (OFF-35). */
  awaitingTerms: boolean;
}

/** The market an order names, as the desk keys it. */
function orderMarketKey(o: BookSignedOrder): string {
  return marketKey({ lending: o.order.lendingAsset as Hex, collateral: o.order.collateralAsset as Hex, durationDays: Number(o.order.durationDays) });
}

/**
 * OFF-60 — every maker's signed orders on the market the desk shows, as the
 * offer book lists them, each with where the chain stands on it, what is
 * left of it to fill, and whether its maker's vault holds free what a fill
 * would draw now (slice 1). An open order someone else signed can be filled
 * whole (slice 2): the fill opens the same acceptance review as a stored
 * offer, read from the protocol's preview of the signed fill, and Terms not
 * yet accepted are accepted first (OFF-35).
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
  const terms = useTerms();
  const termsGate = useTermsGate(`${SIGNED_FILL_KEY}.terms`, chain, own);
  const termsOpen = termsGate.session !== null;
  /** The one fill slot, shared by every market (one flow key): the order
   *  under review, or waiting on a Terms acceptance first. Kept in the store
   *  with the flow and the Terms session, so a navigation drops neither. */
  const [stored, setSlot] = useStoredValue<FillSlot>(`${SIGNED_FILL_KEY}:order`);
  // An order left waiting on a Terms prompt that is no longer open holds
  // nothing: the next fill may take the slot.
  const slot = stored !== null && stored.awaitingTerms && !termsOpen ? null : stored;
  const slotMarket = slot === null ? null : orderMarketKey(slot.order);
  // A fill under review on another market is not this section's to show,
  // and the slot stays taken until it is closed there.
  const fillHere = slot !== null && !slot.awaitingTerms && slotMarket === marketKey(market) ? slot.order : null;
  const fillElsewhere = slot !== null && !slot.awaitingTerms && slotMarket !== marketKey(market) ? slotMarket : null;
  const fill = (o: BookSignedOrder) => {
    if (terms.data?.kind === 'needed') {
      setSlot({ order: o, awaitingTerms: true });
      termsGate.start(terms.data);
      return;
    }
    setSlot({ order: o, awaitingTerms: false });
  };
  const fillDisabled = terms.state !== 'ready' || termsOpen || slot !== null;
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
            <SignedRow
              key={o.orderHash}
              o={o}
              chainRead={chainRead.data ?? null}
              viewer={own.account}
              amount={amount}
              copy={copy}
              onFill={fillDisabled ? null : () => fill(o)}
            />
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="home-section" aria-labelledby="desk-signed-book-title" data-testid="desk-signed-book" data-market={key}>
      <h2 id="desk-signed-book-title">{text('signedBook.title')}</h2>
      <p className="tier-b">{text('signedBook.lead')}</p>
      {termsOpen && termsGate.session && (
        <TermsPrompt
          asker={text('signedFill.asker')}
          gate={termsGate}
          session={termsGate.session}
          chain={chain}
          own={own}
          onAccepted={() => {
            termsGate.end();
            setSlot((s) => (s === null ? null : { order: s.order, awaitingTerms: false }));
          }}
          onClose={() => {
            setSlot((s) => (s !== null && s.awaitingTerms ? null : s));
            termsGate.end();
          }}
        />
      )}
      {fillHere !== null && (
        <div data-testid="desk-signed-fill">
          <AcceptOffer
            flowKey={SIGNED_FILL_KEY}
            source={{ kind: 'signed', order: fillHere }}
            chain={chain}
            own={own}
            meta={meta}
            terms={terms.data}
            onClose={() => setSlot(null)}
          />
        </div>
      )}
      {fillElsewhere !== null && (
        <p className="tier-a" data-testid="desk-signed-fill-elsewhere">
          {text('signedFill.elsewhere')} <Link to={`/desk?market=${fillElsewhere}`}>{text('signedFill.elsewhereOpen')}</Link>
        </p>
      )}
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
  onFill,
}: {
  o: BookSignedOrder;
  chainRead: SignedBookChain | null;
  viewer: Hex;
  amount: (asset: Hex, v: bigint) => string;
  copy: CopyAccess;
  /** Opens this order's fill review; null while another review or the
   *  Terms prompt is open, or the Terms state is not read yet. */
  onFill: (() => void) | null;
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
      {/* Only an open order someone else signed is filled here: a fill takes
          the whole order, so a partly matched one cannot be, and the
          protocol refuses a fill of one's own order. */}
      {!mine && s === 'open' && (
        <p className="actions">
          <button type="button" className="btn" disabled={onFill === null} onClick={() => onFill?.()} data-testid="desk-signed-book-fill">
            {text('signedBook.fill')}
          </button>
        </p>
      )}
      {!mine && s === 'partly-filled' && <p className="tier-b">{text('signedBook.fillNotOpen')}</p>}
    </li>
  );
}
