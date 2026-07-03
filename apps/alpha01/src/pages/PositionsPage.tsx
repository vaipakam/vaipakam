import { useMemo, useState } from 'react';
import {
  cancelOffer,
  formatHealthFactor,
  isHealthFactorAtRisk,
  isNftRentalLoan,
  loanRoleForWallet,
  MIN_HEALTH_FACTOR_1E18,
} from '@vaipakam/defi-client';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { HelpLink } from '../components/HelpLink';
import { OfferCard } from '../components/OfferCard';
import { PositionCard } from '../components/PositionCard';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from '../hooks/useIndexerOrigin';
import { useMyLoans } from '../hooks/useIndexedLoans';
import { useMyOffers } from '../hooks/useMyOffers';
import { useDiamondContract } from '../hooks/useDiamond';
import { useMode } from '../context/ModeContext';
import { useLoanRisks } from '../hooks/useLoanRisks';
import { useMinHealthFactor1e18 } from '../hooks/useProtocolConfig';

type RoleFilter = 'all' | 'borrower' | 'lender';
type RiskFilter = 'all' | 'at-risk';

export function PositionsPage() {
  const { mode } = useMode();
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
  const { data: minHf1e18 = MIN_HEALTH_FACTOR_1E18 } = useMinHealthFactor1e18();
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');

  const loanList = loans ?? [];
  const offerList = offers ?? [];

  const riskLoanIds = useMemo(
    () =>
      mode === 'advanced'
        ? loanList
            .filter((l) => l.status === 'active' && !isNftRentalLoan(l))
            .map((l) => l.loanId)
        : [],
    [loanList, mode],
  );

  const {
    data: riskMap,
    isLoading: risksLoading,
    isError: risksError,
  } = useLoanRisks(riskLoanIds);

  const riskFilterReady =
    riskFilter !== 'at-risk' || (!risksLoading && !risksError && riskMap != null);

  const filteredLoans = useMemo(() => {
    if (mode !== 'advanced') return loanList;
    return loanList.filter((loan) => {
      const role = loanRoleForWallet(loan, address);
      if (roleFilter === 'borrower' && role !== 'borrower' && role !== 'both') return false;
      if (roleFilter === 'lender' && role !== 'lender' && role !== 'both') return false;
      if (riskFilter === 'at-risk' && riskFilterReady) {
        if (isNftRentalLoan(loan) || loan.status !== 'active') return false;
        const hf = riskMap?.get(loan.loanId)?.healthFactor;
        if (!isHealthFactorAtRisk(hf, minHf1e18)) return false;
      }
      return true;
    });
  }, [address, loanList, minHf1e18, mode, riskFilter, riskFilterReady, riskMap, roleFilter]);

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

  const filterActive = mode === 'advanced' && (roleFilter !== 'all' || riskFilter !== 'all');
  const hasLoans = loanList.length > 0;
  const hasOffers = offerList.length > 0;
  const trulyEmpty = !loading && !indexerError && !hasLoans && !hasOffers;
  const noFilterMatches =
    !loading && !indexerError && filteredLoans.length === 0 && hasLoans && filterActive;

  const minHfLabel = formatHealthFactor(minHf1e18);

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

      {mode === 'advanced' && loanList.length > 0 ? (
        <div className="position-filters" data-testid="position-filters">
          <label>
            Role
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}>
              <option value="all">All roles</option>
              <option value="borrower">Borrower / renter</option>
              <option value="lender">Lender / owner</option>
            </select>
          </label>
          <label>
            Risk
            <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value as RiskFilter)}>
              <option value="all">All loans</option>
              <option value="at-risk">HF below {minHfLabel}</option>
            </select>
          </label>
        </div>
      ) : null}

      {loading ? <p>Loading positions…</p> : null}

      {mode === 'advanced' && riskFilter === 'at-risk' && risksLoading ? (
        <p className="form-hint" style={{ marginBottom: 12 }}>
          Loading health factors for risk filter…
        </p>
      ) : null}

      {mode === 'advanced' && riskFilter === 'at-risk' && risksError ? (
        <div className="banner banner-warn" style={{ marginBottom: 12 }}>
          Could not load health factors — risk filter is paused until RPC data is available.
        </div>
      ) : null}

      {!loading && filteredLoans.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <h2 className="section-title">Active loans</h2>
          <ErrorBoundary>
            <div className="position-list">
              {filteredLoans.map((loan) => (
                <PositionCard key={loan.loanId} loan={loan} risk={riskMap?.get(loan.loanId)} />
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
              {offerList.map((offer) => {
                const canCancel =
                  address != null &&
                  offer.creator.toLowerCase() === address.toLowerCase();
                return (
                  <OfferCard
                    key={offer.offerId}
                    offer={offer}
                    cancelling={cancellingId === offer.offerId}
                    onCancel={canCancel ? () => void handleCancelOffer(offer.offerId) : undefined}
                  />
                );
              })}
            </div>
          </ErrorBoundary>
        </section>
      ) : null}

      {trulyEmpty ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          No active loans or open offers on this chain yet.
        </p>
      ) : null}

      {noFilterMatches ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          No loans match the selected filters. Try a different role or risk setting.
        </p>
      ) : null}
    </div>
  );
}