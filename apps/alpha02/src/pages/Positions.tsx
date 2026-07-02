/**
 * My positions — the manage entry point. Answers "what do I have and
 * what needs my attention" with one row per loan; each row leads to
 * the detail page that carries the primary action.
 */
import { ListChecks, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useModal } from 'connectkit';
import { copy } from '../content/copy';
import { useMyLoans, useMyOffers } from '../data/hooks';
import { useActiveChain } from '../chain/useActiveChain';
import { EmptyState, UnavailableState } from '../components/EmptyState';
import { LoanRow } from '../components/LoanRow';
import { useTokenMeta } from '../contracts/erc20';
import { formatTokenAmount } from '../lib/format';
import type { IndexedOffer } from '../data/indexer';

function OfferRow({ offer }: { offer: IndexedOffer }) {
  const meta = useTokenMeta(offer.lendingAsset);
  const amount = meta.data
    ? formatTokenAmount(offer.amountMax, meta.data.decimals)
    : '…';
  const isLending = offer.offerType === 0;
  return (
    <div className="item-row">
      <span className="row-main">
        <span className="row-title">
          {isLending ? 'Your lending offer' : 'Your borrow request'} · {amount}{' '}
          {meta.data?.symbol ?? ''}
        </span>
        <br />
        <span className="row-sub">
          Offer #{offer.offerId} · waiting for the other side to accept
        </span>
      </span>
      <span className="badge badge-info">Open</span>
    </div>
  );
}

export function Positions() {
  const { isConnected } = useActiveChain();
  const { setOpen } = useModal();
  const loans = useMyLoans();
  const offers = useMyOffers();

  return (
    <div>
      <h1 className="page-title">{copy.positions.title}</h1>
      <p className="page-lede">{copy.positions.lede}</p>

      {!isConnected ? (
        <EmptyState
          icon={ListChecks}
          title={copy.wallet.connectFirst}
          action={
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              {copy.wallet.connect}
            </button>
          }
        />
      ) : loans.isLoading ? (
        <EmptyState icon={LoaderCircle} title="Loading your positions…" />
      ) : loans.data === null ? (
        <UnavailableState body={copy.positions.unavailable} />
      ) : (
        <>
          {Array.isArray(offers.data) && offers.data.length > 0 ? (
            <section style={{ marginBottom: 24 }}>
              <h2>Open offers</h2>
              <div className="row-list">
                {offers.data.map((o) => (
                  <OfferRow key={o.offerId} offer={o} />
                ))}
              </div>
            </section>
          ) : null}

          {loans.data && loans.data.length > 0 ? (
            <section>
              <h2>Loans</h2>
              <div className="row-list">
                {loans.data.map((loan) => (
                  <LoanRow key={`${loan.loanId}-${loan.role}`} loan={loan} />
                ))}
              </div>
            </section>
          ) : (Array.isArray(offers.data) ? offers.data.length === 0 : true) ? (
            <EmptyState
              icon={ListChecks}
              title={copy.positions.emptyTitle}
              body={copy.positions.emptyBody}
              action={
                <Link to="/" className="btn btn-primary">
                  Get started
                </Link>
              }
            />
          ) : null}
        </>
      )}
    </div>
  );
}
