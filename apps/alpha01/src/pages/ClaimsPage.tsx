import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  claimAsBorrower,
  claimAsLender,
  formatBpsAsPercent,
  type IndexedLoan,
} from '@vaipakam/defi-client';
import { AssetSymbolLink } from '../components/AssetSymbolLink';
import { HelpLink } from '../components/HelpLink';
import { useTokenMeta } from '../lib/tokenMeta';
import { useWallet } from '../context/WalletContext';
import { useClaimables } from '../hooks/useClaimables';
import { useDiamondContract } from '../hooks/useDiamond';

export function ClaimsPage() {
  const { address, connect } = useWallet();
  const { data, isLoading, isError, error, refetch } = useClaimables();
  const diamond = useDiamondContract();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (!address) {
    return (
      <div>
        <h1 className="page-title">Claims</h1>
        <p className="page-subtitle">Connect your wallet to see claimable funds and collateral.</p>
        <button type="button" className="btn btn-primary" onClick={connect}>Connect wallet</button>
      </div>
    );
  }

  const rows = [
    ...(data?.asBorrower ?? []).map((loan) => ({ loan, side: 'borrower' as const })),
    ...(data?.asLender ?? []).map((loan) => ({ loan, side: 'lender' as const })),
  ];

  async function claim(loanId: number, side: 'borrower' | 'lender') {
    setBusyId(loanId);
    setMsg(null);
    try {
      if (side === 'borrower') await claimAsBorrower({ diamond, loanId: BigInt(loanId) });
      else await claimAsLender({ diamond, loanId: BigInt(loanId) });
      setMsg(`Claim confirmed for loan #${loanId}.`);
      await refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h1 className="page-title">Claims</h1>
      <p className="page-subtitle">
        Collect collateral, principal, or proceeds after a loan settles. <HelpLink anchor="claims" />
      </p>
      {msg ? <div className="banner banner-warn">{msg}</div> : null}
      {isError ? (
        <div className="banner banner-error" style={{ marginBottom: 16 }}>
          Could not load claimables: {error instanceof Error ? error.message : 'Indexer request failed'}
        </div>
      ) : null}
      {isLoading ? <p>Loading claimables…</p> : null}
      <div className="position-list">
        {rows.map(({ loan, side }) => (
          <ClaimLoanCard
            key={`${side}-${loan.loanId}`}
            loan={loan}
            side={side}
            busy={busyId === loan.loanId}
            onClaim={() => void claim(loan.loanId, side)}
          />
        ))}
      </div>
      {!isLoading && !isError && rows.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          Nothing to claim right now. <Link to="/positions">View positions</Link>
        </p>
      ) : null}
    </div>
  );
}

function ClaimLoanCard({
  loan,
  side,
  busy,
  onClaim,
}: {
  loan: IndexedLoan;
  side: 'borrower' | 'lender';
  busy: boolean;
  onClaim: () => void;
}) {
  const lendingMeta = useTokenMeta(loan.lendingAsset);
  const collateralMeta = useTokenMeta(loan.collateralAsset);
  const displayAsset = side === 'borrower' ? loan.collateralAsset : loan.lendingAsset;
  const displayMeta = side === 'borrower' ? collateralMeta : lendingMeta;

  return (
    <div className="position-card">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <strong>Loan #{loan.loanId}</strong>
        <span>{side === 'borrower' ? 'Borrower claim' : 'Lender claim'}</span>
      </div>
      <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        <AssetSymbolLink address={displayAsset} meta={displayMeta} /> ·{' '}
        {formatBpsAsPercent(loan.interestRateBps)} · {loan.status}
      </div>
      <p style={{ fontSize: '0.85rem', marginTop: 4 }}>
        {side === 'borrower'
          ? 'You can claim returned collateral or rebates after settlement.'
          : 'You can claim principal plus interest after the borrower repaid.'}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onClaim}>
          Claim
        </button>
        <Link to={`/positions/${loan.loanId}`} className="btn btn-secondary">
          Details
        </Link>
      </div>
    </div>
  );
}