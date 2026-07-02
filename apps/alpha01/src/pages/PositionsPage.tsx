import { useState } from 'react';
import { cancelOffer } from '@vaipakam/defi-client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { HelpLink } from '../components/HelpLink';
import { OfferCard } from '../components/OfferCard';
import { PositionCard } from '../components/PositionCard';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from '../hooks/useIndexerOrigin';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { useMyOffers } from '../hooks/useMyOffers';
import { useDiamondContract } from '../hooks/useDiamond';

export function PositionsPage() {
  const { address, connect } = useWallet();
  const indexerOrigin = useIndexerOrigin();
  const diamond = useDiamondContract();
  const { data: loans, isLoading: loansLoading, isError: loansError, error: loansErr } = useMyLoans();
  const {
    data: offers,
    isLoading: offersLoading,
    isError: offersError,
    error: offersErr,
    refetch: refetchOffers,
  } = useMyOffers();
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);

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
  const indexerError = loansError || offersError;
  const indexerErrorMsg =
    (loansErr instanceof Error ? loansErr.message : null) ??
    (offersErr instanceof Error ? offersErr.message : null) ??
    'Indexer request failed';
  const loanList = loans ?? [];
  const offerList = offers ?? [];
  const empty = !loading && !indexerError && loanList.length === 0 && offerList.length === 0;

  async function handleCancelOffer(offerId: number) {
    setCancellingId(offerId);
    setCancelMsg(null);
    try {
      await cancelOffer({ diamond, offerId: BigInt(offerId) });
      setCancelMsg(`Offer #${offerId} cancelled.`);
      await refetchOffers();
    } catch (e) {
      setCancelMsg(e instanceof Error ? e.message : 'Cancel failed');
    } finally {
      setCancellingId(null);
    }
  }

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

      {indexerError ? (
        <div className="banner banner-error" style={{ marginBottom: 16 }}>
          Could not load positions from the indexer: {indexerErrorMsg}
        </div>
      ) : null}

      {cancelMsg ? (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          {cancelMsg}
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
                <OfferCard
                  key={offer.offerId}
                  offer={offer}
                  cancelling={cancellingId === offer.offerId}
                  onCancel={() => void handleCancelOffer(offer.offerId)}
                />
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