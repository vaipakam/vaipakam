import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { useCopy, type CopyKey } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { CancelOffer, useCancelOfferHeld, useCancelPins } from '../../shared/offers/CancelOffer';
import { OfferBook } from '../../shared/offers/OfferBook';
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
  'sale-consumed': 'offers.filterSaleConsumed',
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
 * Below it, the offer book (OFF-39, OFF-40, OFF-43): every open offer on
 * the network, read from the index, with or without a wallet; each row
 * opens the offer's own page, which reads it from the chain.
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
  // filter, and even once the refreshed inventory no longer lists it, so its
  // finish card stays until the reader closes it (the fresh row wins when
  // the inventory still has it).
  const cancelPins = useCancelPins();
  const pinned = new Set(cancelPins.pins.map((p) => p.id.toString()));
  const listed = new Set(data?.rows.map((r) => r.id.toString()) ?? []);
  const rows = data ? [...cancelPins.pins.filter((p) => !listed.has(p.id.toString())), ...data.rows.filter((r) => inFilter(r, filter) || pinned.has(r.id.toString()))] : [];

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
                        <OfferRow key={o.id.toString()} offer={o} viewer={own.account} meta={meta} chain={chain} own={own} pins={cancelPins} />
                      ))}
                    </ul>
                  )}
                </>
              )}
              <WhyLink summaryKey="offers.whySummary" detailKey="offers.why" />
            </section>
          )}
        </>
      )}
      {/* The book is read only once a wallet is connected on a served network
          (owner decision 2026-11-09: no offer-book read before a wallet). */}
      {served && own && <OfferBook viewer={own.account} />}
    </main>
  );
}

function OfferRow({
  offer: o,
  viewer,
  meta,
  chain,
  own,
  pins,
}: {
  offer: MyOffer;
  viewer: Hex;
  meta: TokenMetaMap | null;
  chain: SupportedChain;
  own: OwnStateClient;
  pins: ReturnType<typeof useCancelPins>;
}) {
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
        <Link to={`/offers/${id}`} data-testid={`offer-link-${id}`}>
          {t ? offerLine(t, meta, copy) : format('offers.offerNumber', { id })}
        </Link>{' '}
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
      {o.state === 'accepted' && <p className="tier-b">{text('offers.filledNote')}</p>}
      {o.state === 'sale-consumed' && <p className="tier-a">{text('offers.soldNote')}</p>}
      {o.created && !o.held && o.state === 'open' && <p className="tier-a">{text('offers.createdNotHeld')}</p>}
      {o.held && !createdHere && o.state === 'open' && <p className="tier-a">{text('offers.heldNotCreated')}</p>}
      {cancel.held ? (
        <CancelOffer
          id={o.id}
          chain={chain}
          own={own}
          onClose={() => {
            cancel.setOpen(null);
            pins.unpin(o.id);
          }}
        />
      ) : (
        action !== null && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              pins.pin(o);
              cancel.setOpen(true);
            }}
            data-testid={`offer-cancel-${id}`}
          >
            {text(action)}
          </button>
        )
      )}
    </li>
  );
}
