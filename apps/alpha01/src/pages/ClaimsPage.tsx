import { useState } from 'react';
import { Link } from 'react-router-dom';
import { claimAsBorrower, claimAsLender, formatBpsAsPercent } from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { HelpLink } from '../components/HelpLink';
import { useWallet } from '../context/WalletContext';
import { useClaimables } from '../hooks/useClaimables';
import { useDiamondContract } from '../hooks/useDiamond';

export function ClaimsPage() {
  const { address, connect } = useWallet();
  const { data, isLoading, refetch } = useClaimables();
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

  const rows = [...(data?.asBorrower ?? []), ...(data?.asLender ?? [])];

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
      {isLoading ? <p>Loading claimables…</p> : null}
      <div className="position-list">
        {rows.map((loan) => {
          const side = data?.asBorrower.some((l) => l.loanId === loan.loanId) ? 'borrower' : 'lender';
          return (
            <div key={`${side}-${loan.loanId}`} className="position-card">
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>Loan #{loan.loanId}</strong>
                <span>{side === 'borrower' ? 'Borrower claim' : 'Lender claim'}</span>
              </div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                {shortenAddr(loan.lendingAsset)} · {formatBpsAsPercent(loan.interestRateBps)} · {loan.status}
              </div>
              <p style={{ fontSize: '0.85rem', marginTop: 4 }}>
                {side === 'borrower'
                  ? 'You can claim returned collateral or rebates after settlement.'
                  : 'You can claim principal plus interest after the borrower repaid.'}
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId === loan.loanId}
                  onClick={() => void claim(loan.loanId, side)}
                >
                  Claim
                </button>
                <Link to={`/positions/${loan.loanId}`} className="btn btn-secondary">Details</Link>
              </div>
            </div>
          );
        })}
      </div>
      {!isLoading && rows.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)' }}>
          Nothing to claim right now. <Link to="/positions">View positions</Link>
        </p>
      ) : null}
    </div>
  );
}