import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatUnits } from 'viem';
import { useAccount } from 'wagmi';
import { getSupportedChain, DEFAULT_CHAIN } from '../../chain/chains';
import { useOwnStateClient } from '../../chain/ownRail';
import { useCopy, type CopyAccess, type CopyKey } from '../../shared/copy/useCopy';
import {
  deskLadder,
  marketKey,
  openAmount,
  parseMarketKey,
  readMarketBook,
  readMarkets,
  type DeskLadder,
  type DeskStep,
  type Market,
} from '../../shared/desk/markets';
import { WhyLink } from '../../shared/help/WhyLink';
import { BOOK_POLL_MS, indexReason } from '../../shared/offers/OfferBook';
import { worldKey } from '../../shared/reads/identityKey';
import { assetName, tokenAmount, useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useWorldRail } from '../../shared/reads/world/WorldRailContext';
import { formatBps } from '../../shared/ui/format';
import { useNow } from '../../shared/ui/useNow';
import { DeskActivity } from './DeskActivity';
import { DeskMatchBand } from './DeskMatchBand';
import { DeskHistory, MarketLoans } from './DeskPositions';
import { MySignedOrders } from './MySignedOrders';
import { DeskSignedBook } from './DeskSignedBook';
import { OrderTicket } from './OrderTicket';

type Hex = `0x${string}`;
type MarketTerms = Pick<Market, 'lending' | 'collateral' | 'durationDays'>;

const LEFT_OUT: readonly [keyof DeskLadder['leftOut'], CopyKey][] = [
  ['expired', 'desk.leftExpired'],
  ['moved', 'desk.leftMoved'],
  ['vehicle', 'desk.leftVehicle'],
  ['filled', 'desk.leftFilled'],
  ['notThisMarket', 'desk.leftOther'],
];

function marketName(m: MarketTerms, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  return format('desk.marketName', { lending: assetName(m.lending, meta), collateral: assetName(m.collateral, meta), days: String(m.durationDays) });
}

/**
 * The rate desk (OFF-60, OFF-61, OFF-63, OFF-73, OFF-74, OFF-75, OFF-76): the
 * network's token markets (one lending token against one collateral token
 * for one term), the chosen market's rate ladder, the match band that
 * matches an overlapping pair the protocol confirms, every maker's gasless
 * signed orders on it with where the chain stands on each, the order ticket
 * that posts or signs on it through the guided flows' own review, the
 * viewer's own signed orders on it with the on-chain cancel that stops one,
 * and below them the viewer's own offers on it, the market's recent loans
 * and the rates they were agreed at over time, all from the index (the
 * world rail, RB-RAILS), read only once a wallet is connected on a served
 * network, as the offer book is. Then the viewer's live loans in the
 * market, from its own chain read of its positions, and its desk history
 * from the index, a page at a time.
 *
 * One completeness note stands above every view: the index lags the chain,
 * and it counts gasless signed orders, which the signed orders section
 * lists apart from the ladder. The ladder states, rather than implies, what
 * it leaves out and why, that a rate's total is depth and not one take, and
 * that the middle rate is worked out here. Each offer on it opens its own
 * page, which reads it from the chain before anything is offered. A failed
 * read is a degraded-source warning, never an empty desk.
 */
export function DeskPage() {
  const copy = useCopy();
  const { text, format } = copy;
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const own = useOwnStateClient();
  const served = connected && getSupportedChain(own?.chainId ?? chainId) !== null && own !== null;
  const ownChain = getSupportedChain(own?.chainId);
  const world = useWorldRail();
  const chain = getSupportedChain(world.chainId) ?? DEFAULT_CHAIN;
  const [params, setParams] = useSearchParams();
  const asked = params.get('market');
  const parsed = parseMarketKey(asked);
  const noIndex = world.indexer.origin === null;

  const markets = useQuery({
    queryKey: worldKey(world.chainId, 'deskMarkets'),
    queryFn: () => readMarkets(world.indexer, world.chainId),
    enabled: served && !noIndex,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const list = markets.data?.markets ?? [];
  // The address names the market; without one, the deepest market opens.
  const selected: MarketTerms | null = asked !== null ? parsed : (list[0] ?? null);
  const selectedKey = selected ? marketKey(selected) : null;
  const listed = selectedKey !== null ? list.find((m) => marketKey(m) === selectedKey) : undefined;

  const book = useQuery({
    queryKey: worldKey(world.chainId, 'deskLadder', selectedKey),
    queryFn: () => readMarketBook(world.indexer, world.chainId, selected!),
    enabled: served && !noIndex && selected !== null,
    refetchInterval: BOOK_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOOK_POLL_MS / 2,
    retry: 1,
  });
  const nowSec = useNow() / 1000;
  const ladder = book.data && selected ? deskLadder(book.data.rows, selected, nowSec) : null;
  const meta = useTokenMeta(list.flatMap((m) => [m.lending, m.collateral]).concat(selected ? [selected.lending, selected.collateral] : [])).data;

  const marketsFailed = noIndex || markets.status === 'error';
  const marketsReason = noIndex ? text('offerBook.noIndex') : indexReason(markets.error, text);
  const ladderFailed = noIndex || book.status === 'error';
  const ladderReason = noIndex ? text('offerBook.noIndex') : indexReason(book.error, text);
  const choose = (m: Market) => setParams({ market: marketKey(m) });
  const viewer = own?.account ?? null;

  return (
    <main className="page desk" aria-labelledby="desk-title">
      <h1 id="desk-title">{text('desk.title')}</h1>
      {!connected && <p className="tier-b">{text('desk.connectPrompt')}</p>}
      {connected && !served && <p className="tier-b">{text('desk.unsupportedChain')}</p>}
      {served && (
        <>
          <p className="tier-a" data-testid="desk-completeness">
            {text('desk.completeness')}
          </p>
          <section className="home-section" aria-labelledby="desk-markets-title" data-testid="desk-markets">
            <h2 id="desk-markets-title">{text('desk.marketsTitle')}</h2>
            <p className="tier-b">{format('desk.marketsLead', { chain: chain.name })}</p>
            {marketsFailed && (
              <p className="tier-a" data-testid="desk-markets-failed">
                {format(markets.data ? 'desk.marketsFailedCached' : 'desk.marketsFailed', { reason: marketsReason })}
              </p>
            )}
            {!marketsFailed && markets.data === undefined && <p className="tier-b">{text('desk.marketsReading')}</p>}
            {markets.data !== undefined && (
              <>
                {markets.data.truncated && <p className="tier-a">{text('desk.marketsTruncated')}</p>}
                {markets.data.unread > 0 && <p className="tier-a">{format('desk.marketsUnread', { count: String(markets.data.unread) })}</p>}
                {list.length === 0 && !marketsFailed && markets.data.unread === 0 && (
                  <p className="tier-b home-empty" data-testid="desk-markets-none">
                    {format('desk.marketsNone', { chain: chain.name })}
                  </p>
                )}
                {list.length > 0 && (
                  <ul className="rows" data-testid="desk-market-rows">
                    {list.map((m) => {
                      const key = marketKey(m);
                      const shown = key === selectedKey;
                      return (
                        <li key={key} className="card" data-testid="desk-market" data-market={key}>
                          <p className="row-head">{marketName(m, meta, format)}</p>
                          <p className="tier-b">{format('desk.marketCounts', { asks: String(m.lenderOffers), bids: String(m.borrowerOffers) })}</p>
                          <p className="tier-b">
                            {m.bestAskBps === null ? text('desk.noAsk') : format('desk.bestAsk', { rate: formatBps(m.bestAskBps) })} ·{' '}
                            {m.bestBidBps === null ? text('desk.noBid') : format('desk.bestBid', { rate: formatBps(m.bestBidBps) })}
                          </p>
                          {shown ? (
                            <p className="tier-b">{text('desk.shownLadder')}</p>
                          ) : (
                            <button type="button" className="btn" onClick={() => choose(m)} data-testid="desk-market-open">
                              {text('desk.openLadder')}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </section>

          {(selected !== null || asked !== null) && (
            <section className="home-section" aria-labelledby="desk-ladder-title" data-testid="desk-ladder" data-market={selectedKey ?? ''}>
              <h2 id="desk-ladder-title">{text('desk.ladderTitle')}</h2>
              {asked !== null && parsed === null && (
                <p className="tier-a" data-testid="desk-bad-market">
                  {text('desk.badMarket')}
                </p>
              )}
              {selected !== null && (
                <>
                  <p className="tier-b" data-testid="desk-ladder-market">
                    {format('desk.ladderMarket', { market: marketName(selected, meta, format), chain: chain.name })}
                  </p>
                  {markets.data !== undefined && listed === undefined && <p className="tier-b">{text('desk.notListed')}</p>}
                  <p className="tier-b">{text('desk.ladderLead')}</p>
                  <p className="tier-a">{text('desk.depth')}</p>
                  {ladderFailed && (
                    <p className="tier-a" data-testid="desk-ladder-failed">
                      {format(book.data ? 'desk.ladderFailedCached' : 'desk.ladderFailed', { reason: ladderReason })}
                    </p>
                  )}
                  {!ladderFailed && book.data === undefined && <p className="tier-b">{text('desk.ladderReading')}</p>}
                  {ladder !== null && book.data !== undefined && (
                    <LadderView
                      ladder={ladder}
                      market={selected}
                      listed={listed}
                      more={book.data.more}
                      unread={book.data.unread}
                      read={book.data.rows.length}
                      meta={meta}
                      viewer={viewer}
                      copy={copy}
                    />
                  )}
                </>
              )}
            </section>
          )}
          {selected !== null && ladder !== null && own !== null && ownChain !== null && own.chainId === world.chainId && (
            <DeskMatchBand key={`match-${selectedKey}`} ladder={ladder} market={selected} chain={ownChain} own={own} meta={meta} copy={copy} />
          )}
          {selected !== null && own !== null && ownChain !== null && own.chainId === world.chainId && (
            <DeskSignedBook key={`signed-book-${selectedKey}`} market={selected} chain={ownChain} own={own} meta={meta} copy={copy} />
          )}
          {selected !== null && (
            <OrderTicket
              key={`ticket-${selectedKey}`}
              market={selected}
              marketLabel={marketName(selected, meta, format)}
              own={own}
              worldChainId={world.chainId}
              copy={copy}
            />
          )}
          {selected !== null && own !== null && ownChain !== null && own.chainId === world.chainId && (
            <MySignedOrders key={`signed-${selectedKey}`} market={selected} chain={ownChain} own={own} meta={meta} copy={copy} />
          )}
          {selected !== null && (
            <DeskActivity
              key={selectedKey}
              market={selected}
              marketLabel={marketName(selected, meta, format)}
              ladder={ladder}
              viewer={viewer}
              meta={meta}
              nowSec={nowSec}
              copy={copy}
            />
          )}
          {selected !== null && <MarketLoans key={`loans-${selectedKey}`} market={selected} meta={meta} copy={copy} />}
          {viewer !== null && <DeskHistory viewer={viewer} copy={copy} />}
          <WhyLink summaryKey="desk.whySummary" detailKey="desk.why" />
        </>
      )}
    </main>
  );
}

function LadderView({
  ladder: l,
  market,
  listed,
  more,
  unread,
  read,
  meta,
  viewer,
  copy,
}: {
  ladder: DeskLadder;
  market: MarketTerms;
  listed: Market | undefined;
  more: boolean;
  unread: number;
  read: number;
  meta: TokenMetaMap | null;
  viewer: Hex | null;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const onLadder = [...l.asks, ...l.bids].reduce((n, s) => n + s.offers.length, 0);
  const counted = listed ? listed.lenderOffers + listed.borrowerOffers : null;
  const left = LEFT_OUT.filter(([k]) => l.leftOut[k] > 0).map(([k, key]) => format(key, { count: String(l.leftOut[k]) }));
  return (
    <>
      <p className="tier-b" data-testid="desk-middle" data-middle={l.middleTenthBps === null ? '' : l.middleTenthBps.toString()}>
        {l.middleTenthBps === null ? text('desk.noMiddle') : format('desk.middle', { rate: formatUnits(l.middleTenthBps, 3) })}
      </p>
      {l.crossed && (
        <p className="tier-a" data-testid="desk-crossed">
          {text('desk.crossed')}
        </p>
      )}
      {counted !== null && counted !== onLadder && (
        <p className="tier-a" data-testid="desk-counted">
          {format('desk.counted', { counted: String(counted), listed: String(onLadder) })}
        </p>
      )}
      {more && <p className="tier-a">{format('desk.more', { read: String(read) })}</p>}
      {unread > 0 && <p className="tier-a">{format('desk.ladderUnread', { count: String(unread) })}</p>}
      {left.length > 0 && (
        <p className="tier-b" data-testid="desk-left-out">
          {format('desk.leftOut', { list: left.join(', ') })}
        </p>
      )}
      <div className="ladder-sides">
        <LadderSide side="ask" steps={l.asks} market={market} meta={meta} viewer={viewer} copy={copy} />
        <LadderSide side="bid" steps={l.bids} market={market} meta={meta} viewer={viewer} copy={copy} />
      </div>
    </>
  );
}

function LadderSide({
  side,
  steps,
  market,
  meta,
  viewer,
  copy,
}: {
  side: 'ask' | 'bid';
  steps: DeskStep[];
  market: MarketTerms;
  meta: TokenMetaMap | null;
  viewer: Hex | null;
  copy: CopyAccess;
}) {
  const { text, format } = copy;
  const ask = side === 'ask';
  const id = `desk-${side}s-title`;
  const amount = (v: bigint) => tokenAmount(v, market.lending, meta, format);
  return (
    <section aria-labelledby={id} data-testid={`desk-${side}s`}>
      <h3 id={id}>{text(ask ? 'desk.asksTitle' : 'desk.bidsTitle')}</h3>
      <p className="tier-b">{text(ask ? 'desk.asksLead' : 'desk.bidsLead')}</p>
      {steps.length === 0 ? (
        <p className="tier-b">{text(ask ? 'desk.noAsks' : 'desk.noBids')}</p>
      ) : (
        <ol className="rows ladder-steps">
          {steps.map((s) => (
            <li
              key={s.rateBps.toString()}
              className="card"
              data-testid={`desk-${side}-step`}
              data-rate={s.rateBps.toString()}
              data-open={s.open.toString()}
              data-count={s.offers.length}
            >
              <p className="row-head">{format('desk.stepRate', { rate: formatBps(s.rateBps) })}</p>
              <p className="tier-b">{format('desk.stepCount', { count: String(s.offers.length) })}</p>
              <p className="tier-b">{format('desk.stepOpen', { amount: amount(s.open) })}</p>
              <ul className="ladder-offers">
                {s.offers.map((o) => {
                  const oid = o.id.toString();
                  const mine = viewer !== null && o.creator.toLowerCase() === viewer.toLowerCase();
                  return (
                    <li key={oid}>
                      <Link to={`/offers/${oid}`} data-testid={`desk-offer-${oid}`}>
                        {format('desk.stepOffer', { id: oid, amount: amount(openAmount(o)) })}
                      </Link>
                      {mine && <span className="badge">{text('desk.yours')}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
