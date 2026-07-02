import { ErrorBoundary } from '../components/ErrorBoundary';
import { HelpLink } from '../components/HelpLink';
import { OfferCard } from '../components/OfferCard';
import { PositionCard } from '../components/PositionCard';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from '../hooks/useIndexerOrigin';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { useMyOffers } from '../hooks/useMyOffers';

export function PositionsPage() {
  const { address, connect } = useWallet();
  const indexerOrigin = useIndexerOrigin();
  const { data: loans, isLoading: loansLoading } = useMyLoans();
  const { data: offers, isLoading: offersLoading } = useMyOffers();

  if (!address) {
    return (
      <div>
        <h1 className="page-title">My positions</h1>
        <p className="page-subtitle">Connect your wallet to see active loans and open offers.</p>
        <button type="button" className="btn btn-primary" onClick={connect}>
          Connect wallet
        </button>
      </div>
    );
  }

  const loading = loansLoading || offersLoading;
  const loanList = loans ?? [];
  const offerList = offers ?? [];
  const empty = !loading && loanList.length === 0 && offerList.length === 0;

  return (
    <div className="page-frame page-frame--wide">
      <h1 className="page-title">My positions</h1>
      <p className="page-subtitle">
        Active loans and open offers on this chain. <HelpLink anchor="positions" />
      </p>

      {!indexerOrigin ? (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          Indexer is not configured. Set <code>VITE_INDEXER_ORIGIN</code> in{' '}
          <code>.env.local</code> to load positions.
        </div>
      ) : null}

      {loading ? <p>Loading positions…</p> : null}

      {!loading && loanList.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <h2 className="section-title">Active loans</h2>
          <ErrorBoundary>
            <div className="position-list">
              {loanList.map((loan) => (
                <PositionCard key={loan.loanId} loan={loan} />
              ))}
            </div>
          </ErrorBoundary>
        </section>
      ) : null}

      {!loading && offerList.length > 0 ? (
        <section>
          <h2 className="section-title">Open offers</h2>
          <ErrorBoundary>
            <div className="position-list">
              {offerList.map((offer) => (
                <OfferCard key={offer.offerId} offer={offer} />
              ))}
            </div>
          </ErrorBoundary>
        </section>
      ) : null}

      {empty ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          No active loans or open offers on this chain yet.
        </p>
      ) : null}
    </div>
  );
}