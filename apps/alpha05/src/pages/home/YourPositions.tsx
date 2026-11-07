import { Link } from 'react-router-dom';
import { useCopy } from '../../shared/copy/useCopy';
import { assetName, tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import type { OwnRead } from '../../shared/reads/useOwnRead';
import { formatBps, formatUtc } from '../../shared/ui/format';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { ASSET_ERC20, OFFER_TYPE_LENDER } from '../../shared/positions/model';
import { LoansSection, PayoutsSection, ReadState, settledEmpty } from '../../shared/positions/PositionSections';
import type { OpenOffer, OpenOffers } from '../../shared/positions/reads';
import type { HomeBook } from './useHomeBook';

/** How many open offers Home lists before pointing at Offers. */
const OFFERS_SHOWN = 3;

/**
 * RW-70: the connected wallet's book on this chain, in the order a reader
 * needs it: payouts confirmed ready to collect first, then live loans (the
 * most urgent deadline first, the children of one offer grouped), then the
 * wallet's open offers. Each section states its own reading, failure or
 * incompleteness; "nothing yet" is said only when all three were read in
 * full and are empty. Each position's button OPENS it: whether an action is
 * open is decided on the position's page by the shared verdict (RB-ELIG),
 * never here.
 */
export function YourPositions({ book }: { book: HomeBook }) {
  const { text, format } = useCopy();
  const { chain, loans, payouts, offers, numeraire, meta, empty } = book;
  if (!chain) return null;
  return (
    <>
      <OwnStamp reads={[loans, offers]} />
      {empty ? (
        <p className="tier-b home-empty">{format('home.empty', { chain: chain.name })}</p>
      ) : (
        <>
          <PayoutsSection read={payouts} />
          <LoansSection read={loans} meta={meta} unit={numeraire.data ?? text('home.exposureUnit')} />
          <OffersSection read={offers} meta={meta} />
        </>
      )}
    </>
  );
}

function OffersSection({ read, meta }: { read: OwnRead<OpenOffers>; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="home-offers">
      <h2 id="home-offers">{text('home.offersTitle')}</h2>
      <ReadState read={read}>
        {(data) => (
          <>
            {!data.complete && <p className="tier-a">{text('positions.incomplete')}</p>}
            <ul className="rows">
              {data.rows.slice(0, OFFERS_SHOWN).map((o) => (
                <OfferCard key={o.id.toString()} offer={o} meta={meta} />
              ))}
            </ul>
            {data.rows.length > OFFERS_SHOWN && <p className="tier-b">{format('home.offersMore', { count: String(data.rows.length - OFFERS_SHOWN) })}</p>}
            <Link className="btn" to="/offers">
              {text('home.offersAction')}
            </Link>
          </>
        )}
      </ReadState>
    </section>
  );
}

function OfferCard({ offer: o, meta }: { offer: OpenOffer; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const id = o.id.toString();
  const lend = o.offerType === OFFER_TYPE_LENDER;
  const erc20 = o.assetType === ASSET_ERC20;
  const amountOf = (v: bigint) =>
    erc20 ? tokenAmount(v, o.lendingAsset, meta, format) : format('asset.nft', { id: o.tokenId.toString(), asset: assetName(o.lendingAsset, meta) });
  const rate =
    o.interestRateBpsMax > o.interestRateBps ? format('home.rateRange', { min: formatBps(o.interestRateBps), max: formatBps(o.interestRateBpsMax) }) : formatBps(o.interestRateBps);
  const common = { id, rate, days: o.durationDays.toString() };
  // A rental carries no APR: `amount` is its daily fee, in the prepay asset.
  const line = !erc20
    ? format(lend ? 'home.offerRentOut' : 'home.offerRent', {
        id,
        asset: amountOf(o.amount),
        fee: tokenAmount(o.amount, o.prepayAsset, meta, format),
        days: o.durationDays.toString(),
      })
    : erc20 && o.amountMax > o.amount
      ? format('home.offerRange', { ...common, side: text(lend ? 'home.offerSideLend' : 'home.offerSideBorrow'), min: amountOf(o.amount), max: amountOf(o.amountMax) })
      : format(lend ? 'home.offerLend' : 'home.offerBorrow', { ...common, amount: amountOf(o.amountMax > 0n ? o.amountMax : o.amount) });
  return (
    <li className="card" data-offer-id={id}>
      <p className="row-head">{line}</p>
      {erc20 && o.amountFilled > 0n && <p className="tier-b">{format('home.offerFilled', { filled: amountOf(o.amountFilled), max: amountOf(o.amountMax) })}</p>}
      {o.expiresAt > 0n && <p className="tier-b">{format('home.offerExpires', { when: formatUtc(Number(o.expiresAt)) })}</p>}
    </li>
  );
}
