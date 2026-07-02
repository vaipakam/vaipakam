import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  claimAsBorrower,
  claimAsLender,
  fetchLoanById,
  formatBpsAsPercent,
  repayLoanFull,
} from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract, useReadChain } from '../hooks/useDiamond';

export function PositionDetailPage() {
  const { loanId } = useParams();
  const id = Number(loanId);
  const chain = useReadChain();
  const { address } = useWallet();
  const diamond = useDiamondContract();
  const origin = import.meta.env.VITE_INDEXER_ORIGIN;

  const { data: loan, isLoading } = useQuery({
    queryKey: ['loan', chain.chainId, id],
    enabled: Number.isFinite(id),
    queryFn: () => fetchLoanById(origin, chain.chainId, id),
  });

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (isLoading) return <p>Loading loan…</p>;
  if (!loan) return <p>Loan not found.</p>;

  const isLender = address?.toLowerCase() === loan.lender.toLowerCase();
  const isBorrower = address?.toLowerCase() === loan.borrower.toLowerCase();

  async function run(action: 'repay' | 'claim-lender' | 'claim-borrower') {
    setBusy(true);
    setMsg(null);
    try {
      if (action === 'repay') await repayLoanFull({ diamond, loanId: BigInt(loan!.loanId) });
      if (action === 'claim-lender') await claimAsLender({ diamond, loanId: BigInt(loan!.loanId) });
      if (action === 'claim-borrower') await claimAsBorrower({ diamond, loanId: BigInt(loan!.loanId) });
      setMsg('Transaction confirmed.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to="/positions" style={{ fontSize: '0.9rem' }}>← Back to positions</Link>
      <h1 className="page-title" style={{ marginTop: 12 }}>Loan #{loan.loanId}</h1>
      <p className="page-subtitle">
        {loan.status} · {formatBpsAsPercent(loan.interestRateBps)} · {loan.durationDays} days
      </p>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        <div>Principal asset: {shortenAddr(loan.lendingAsset)}</div>
        <div>Collateral asset: {shortenAddr(loan.collateralAsset)}</div>
        <div>Lender: {shortenAddr(loan.lender)}</div>
        <div>Borrower: {shortenAddr(loan.borrower)}</div>
      </div>

      {msg ? <div className="banner banner-warn" style={{ marginTop: 16 }}>{msg}</div> : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        {isBorrower && loan.status === 'active' ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('repay')}>
            Repay loan
          </button>
        ) : null}
        {isLender ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run('claim-lender')}>
            Claim as lender
          </button>
        ) : null}
        {isBorrower ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run('claim-borrower')}>
            Claim as borrower
          </button>
        ) : null}
      </div>
    </div>
  );
}