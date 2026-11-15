import { Link } from 'react-router-dom';
import { useCopy } from '../../shared/copy/useCopy';
import { type TokenMetaMap } from '../../shared/reads/tokens';
import { offerAmount, offerLine } from '../../shared/offers/offerLine';
import type { OwnRead } from '../../shared/reads/useOwnRead';
import { formatUtc } from '../../shared/ui/format';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { ASSET_ERC20 } from '../../shared/positions/model';
import { LoansSection, PayoutsSection, ReadState, settledEmpty } from '../../shared/positions/PositionSections';
import type { OpenOffer, OpenOffers } from '../../shared/positions/reads';
import type { HomeBook } from './useHomeBook';
import { ReadyToClaim } from '../../shared/claims/ReadyToClaim';
import { useLoanClaims } from '../../shared/claims/useLoanClaims';
import { useFrozenState } from '../../shared/sanctions/FrozenNotice';

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
  // #3631: the payouts' claim read feeds the Ready to claim total, so it is
  // stamped and refreshed with the rest of Home's reads.
  const loanClaims = useLoanClaims();
  if (!chain) return null;
  return (
    <>
      <OwnStamp reads={[loans, offers, loanClaims.claims]} />
      {empty ? (
        <p className="tier-b home-empty">{format('home.empty', { chain: chain.name })}</p>
      ) : (
        <>
          <HomeReadyToClaim loanClaims={loanClaims} />
          <PayoutsSection read={payouts} />
          <LoansSection read={loans} meta={meta} unit={numeraire.data ?? text('home.exposureUnit')} />
          <OffersSection read={offers} meta={meta} />
        </>
      )}
    </>
  );
}

/** #3631: the total ready to claim across every payout, the same figure
 *  Claims leads with, read once and shared. */
function HomeReadyToClaim({ loanClaims }: { loanClaims: ReturnType<typeof useLoanClaims> }) {
  const { book, claims } = loanClaims;
  const frozen = useFrozenState(book.diamond, book.chain ? book.account : null);
  if (!book.chain) return null;
  return <ReadyToClaim claims={claims} bookFailed={book.read.state === 'failed'} frozen={frozen} account={book.account} />;
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
  const copy = useCopy();
  const { format } = copy;
  const id = o.id.toString();
  const erc20 = o.assetType === ASSET_ERC20;
  const amountOf = (v: bigint) => offerAmount(o, v, meta, format);
  const line = offerLine(o, meta, copy);
  return (
    <li className="card" data-offer-id={id}>
      <p className="row-head">{line}</p>
      {erc20 && o.amountFilled > 0n && <p className="tier-b">{format('home.offerFilled', { filled: amountOf(o.amountFilled), max: amountOf(o.amountMax) })}</p>}
      {o.expiresAt > 0n && <p className="tier-b">{format('home.offerExpires', { when: formatUtc(Number(o.expiresAt)) })}</p>}
    </li>
  );
}
