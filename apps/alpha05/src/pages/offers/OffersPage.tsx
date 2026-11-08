import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { PAGES, currentAppHref } from '../../routes/pageMap';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { CancelOffer, useCancelHeldIds, useCancelOfferHeld } from '../../shared/offers/CancelOffer';
import { filterCounts, inFilter, OFFER_FILTERS, readMyOffers, type MyOffer, type OfferFilter } from '../../shared/offers/myOffers';
import { offerAmount, offerLine } from '../../shared/offers/offerLine';
import { ASSET_ERC20 } from '../../shared/positions/model';
import { useTokenMeta, type TokenMetaMap } from '../../shared/reads/tokens';
import { useOwnRead } from '../../shared/reads/useOwnRead';
import { FrozenNotice, useFrozenState } from '../../shared/sanctions/FrozenNotice';
import { formatUtc } from '../../shared/ui/format';
import { OwnStamp } from '../../shared/ui/OwnStamp';

type Hex = `0x${string}`;

const FILTER_KEY: Record<OfferFilter, CopyKey> = {
  open: 'offers.filterOpen',
  accepted: 'offers.filterAccepted',
  expired: 'offers.filterExpired',
  cancelled: 'offers.filterCancelled',
  all: 'offers.filterAll',
};

const STATE_KEY: Record<MyOffer['state'], CopyKey> = {
  open: 'offers.stateOpen',
  accepted: 'offers.stateAccepted',
  'sale-consumed': 'offers.stateSaleConsumed',
  expired: 'offers.stateExpired',
  cancelled: 'offers.stateCancelled',
  unknown: 'offers.stateUnknown',
};

/**
 * Offers (OFF-46, OFF-48, OFF-49): every offer the connected wallet created
 * or holds the position token of on its chain, in every state the protocol
 * reports, filtered by state with each filter's count. An open offer the
 * wallet created can be cancelled, and an expired one cleaned up by anyone;
 * each opens its own review under the row. An offer whose terms the
 * protocol cleared at its cancel says so instead of showing invented terms,
 * and an offer held by one wallet but created by another says who may
 * cancel it and where its return goes.
 *
 * The offer book (OFF-39, OFF-40, OFF-43) comes in the next slice; until
 * then the page links to the current app for it.
 */
export function OffersPage() {
  const { text, format } = useCopy();
  const { status, chainId } = useAccount();
  const connected = status === 'connected';
  const own = useOwnStateClient();
  const chain = getSupportedChain(own?.chainId ?? chainId);
  const served = connected && chain !== null;
  const diamond = (chain?.diamondAddress ?? '0x') as Hex;
  const account = (own?.account ?? '0x') as Hex;
  const mine = useOwnRead(['offers', 'mine', diamond], (c) => readMyOffers(c, diamond, account), { enabled: served && own !== null });
  const data = mine.data;
  const terms = data?.rows.flatMap((r) => (r.terms ? [r.terms.lendingAsset, r.terms.prepayAsset] : [])) ?? [];
  const meta = useTokenMeta(terms).data;
  const frozen = useFrozenState(diamond, served && own ? own.account : null);
  const [filter, setFilter] = useState<OfferFilter>('open');
  const counts = data ? filterCounts(data.rows) : null;
  // A row whose cancel is open or in flight stays on screen whatever the
  // filter, so a cancel that moves it out of "Open" keeps its finish card.
  const held = useCancelHeldIds(data?.rows.map((r) => r.id) ?? []);
  const rows = data ? data.rows.filter((r) => inFilter(r, filter) || held.has(r.id.toString())) : [];
  const offersPage = PAGES.find((p) => p.path === '/offers');
  const currentOffers = offersPage ? currentAppHref(offersPage, {}) : null;

  return (
    <main className="page offers" aria-labelledby="offers-title">
      <h1 id="offers-title">{text('offers.title')}</h1>
      {!connected && <p className="tier-b">{text('offers.connectPrompt')}</p>}
      {connected && !served && <p className="tier-b">{text('offers.unsupportedChain')}</p>}
      {served && chain && own && (
        <>
          <FrozenNotice state={frozen} />
          <OwnStamp reads={[mine]} />
          <p className="tier-b">{text('offers.lead')}</p>
          <div className="form-actions">
            <Link className="btn" to="/lend">
              {text('offers.postLend')}
            </Link>
            <Link className="btn" to="/borrow">
              {text('offers.postBorrow')}
            </Link>
          </div>
          {data === null && mine.state !== 'failed' && <p className="tier-b">{text('offers.reading')}</p>}
          {mine.state === 'failed' && data === null && (
            <p className="tier-a" data-testid="offers-failed">
              {format('offers.failed', { reason: mine.error ?? '' })}
            </p>
          )}
          {data !== null && counts !== null && (
            <section className="home-section" aria-labelledby="offers-mine" data-testid="offers-mine">
              <h2 id="offers-mine" className="sr-only">
                {text('offers.title')}
              </h2>
              {!data.complete && <p className="tier-a">{text('offers.incomplete')}</p>}
              {data.rows.length === 0 && data.complete ? (
                <p className="tier-b home-empty">{format('offers.none', { chain: chain.name })}</p>
              ) : (
                <>
                  <div className="offers-filters" role="group" aria-label={text('offers.filterLabel')} data-testid="offers-filters">
                    {OFFER_FILTERS.map((f) => (
                      <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`offers-filter-${f}`}>
                        {format(FILTER_KEY[f], { count: String(counts[f]) })}
                      </button>
                    ))}
                  </div>
                  {rows.length === 0 ? (
                    <p className="tier-b">{format('offers.noneFiltered', { chain: chain.name })}</p>
                  ) : (
                    <ul className="rows offers-list">
                      {rows.map((o) => (
                        <OfferRow key={o.id.toString()} offer={o} viewer={own.account} meta={meta} chain={chain} own={own} />
                      ))}
                    </ul>
                  )}
                </>
              )}
              <WhyLink summaryKey="offers.whySummary" detailKey="offers.why" />
            </section>
          )}
          {currentOffers !== null && (
            <p className="tier-b" data-testid="offers-next">
              {text('offers.bookNext')}{' '}
              <a href={currentOffers} target="_blank" rel="noreferrer">
                {text('vault.openCurrent')}
              </a>
            </p>
          )}
        </>
      )}
    </main>
  );
}

function OfferRow({ offer: o, viewer, meta, chain, own }: { offer: MyOffer; viewer: Hex; meta: TokenMetaMap | null; chain: SupportedChain; own: OwnStateClient }) {
  const copy = useCopy();
  const { text, format } = copy;
  const id = o.id.toString();
  const cancel = useCancelOfferHeld(o.id);
  const t = o.terms;
  const createdHere = t !== null ? t.creator.toLowerCase() === viewer.toLowerCase() : o.created;
  // Open: the creator may cancel. Expired: anyone may clean it up.
  const action: CopyKey | null = o.state === 'open' && createdHere ? 'offers.cancel' : o.state === 'expired' ? 'offers.cleanUp' : null;
  return (
    <li className="card" data-offer-id={id} data-testid={`offer-row-${id}`}>
      <p className="row-head">
        {t ? offerLine(t, meta, copy) : format('offers.offerNumber', { id })}{' '}
        <span className="badge" data-testid={`offer-state-${id}`}>
          {text(STATE_KEY[o.state])}
        </span>
      </p>
      {t === null && o.state === 'cancelled' && <p className="tier-a">{text('offers.termsCleared')}</p>}
      {t !== null && t.assetType === ASSET_ERC20 && t.amountFilled > 0n && (
        <p className="tier-b">
          {format('home.offerFilled', { filled: offerAmount(t, t.amountFilled, meta, format), max: offerAmount(t, t.amountMax > 0n ? t.amountMax : t.amount, meta, format) })}
        </p>
      )}
      {t !== null && t.expiresAt > 0n && o.state === 'open' && <p className="tier-b">{format('home.offerExpires', { when: formatUtc(Number(t.expiresAt)) })}</p>}
      {o.state === 'expired' && <p className="tier-a">{text('offers.expiredHolds')}</p>}
      {(o.state === 'accepted' || o.state === 'sale-consumed') && <p className="tier-b">{text('offers.filledNote')}</p>}
      {o.created && !o.held && o.state === 'open' && <p className="tier-a">{text('offers.createdNotHeld')}</p>}
      {o.held && !createdHere && o.state === 'open' && <p className="tier-a">{text('offers.heldNotCreated')}</p>}
      {cancel.held ? (
        <CancelOffer id={o.id} chain={chain} own={own} onClose={() => cancel.setOpen(null)} />
      ) : (
        action !== null && (
          <button type="button" className="btn" onClick={() => cancel.setOpen(true)} data-testid={`offer-cancel-${id}`}>
            {text(action)}
          </button>
        )
      )}
    </li>
  );
}
