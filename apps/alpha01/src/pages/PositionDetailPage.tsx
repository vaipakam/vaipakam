import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  borrowerPrimaryAction,
  claimAsBorrower,
  claimAsLender,
  fetchLoanById,
  formatBpsAsPercent,
  plainHealthLabel,
  loanRoleForWallet,
  repayLoanFull,
} from '@vaipakam/defi-client';
import { AssetAmount } from '../components/AssetAmount';
import { HelpLink } from '../components/HelpLink';
import { useTokenMeta } from '../lib/tokenMeta';
import { useWallet } from '../context/WalletContext';
import { useLoanHealth } from '../hooks/useLoanHealth';
import { useIndexerOrigin } from '../hooks/useIndexerOrigin';
import { useWalletClient } from 'wagmi';
import type { Address } from 'viem';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';

export function PositionDetailPage() {
  const { loanId } = useParams();
  const id = Number(loanId);
  const chain = useReadChain();
  const { address, isCorrectChain } = useWallet();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const origin = useIndexerOrigin();
  const { data: hf } = useLoanHealth(id);

  const { data: loan, isLoading, refetch } = useQuery({
    queryKey: ['loan', chain.chainId, id],
    enabled: Number.isFinite(id),
    queryFn: () => fetchLoanById(origin ?? undefined, chain.chainId, id),
  });

  const lendingMeta = useTokenMeta(loan?.lendingAsset ?? null);
  const collateralMeta = useTokenMeta(loan?.collateralAsset ?? null);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (isLoading) return <p>Loading loan…</p>;
  if (!loan) return <p>Loan not found.</p>;

  const role = loanRoleForWallet(loan, address);
  const isBorrower = role === 'borrower';
  const health = plainHealthLabel(isBorrower ? hf : null);
  const primary = borrowerPrimaryAction({
    role: role === 'other' ? 'other' : role,
    loanStatus: loan.status,
    healthTone: health.tone,
  });

  async function run(action: 'repay' | 'claim-lender' | 'claim-borrower') {
    setBusy(true);
    setMsg(null);
    try {
      if (action === 'repay') {
        if (!walletClient || !chain.diamondAddress) throw new Error('Wallet not connected');
        await repayLoanFull({
          diamond,
          publicClient,
          walletClient,
          diamondAddress: chain.diamondAddress as Address,
          loan: loan!,
        });
      }
      if (action === 'claim-lender') await claimAsLender({ diamond, loanId: BigInt(loan!.loanId) });
      if (action === 'claim-borrower') await claimAsBorrower({ diamond, loanId: BigInt(loan!.loanId) });
      setMsg('Transaction confirmed.');
      await refetch();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Transaction failed');
    } finally {
      setBusy(false);
    }
  }

  const statusLabel =
    loan.status === 'active'
      ? health.label
      : loan.status === 'repaid'
        ? 'Repaid — ready to claim'
        : loan.status;

  return (
    <div>
      <Link to="/positions" style={{ fontSize: '0.9rem' }}>← Back to positions</Link>
      <h1 className="page-title" style={{ marginTop: 12 }}>Loan #{loan.loanId}</h1>
      <p className="page-subtitle">
        Role: {role === 'borrower' ? 'Borrower' : role === 'lender' ? 'Lender' : 'Viewer'} · {statusLabel}
      </p>

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        <div>
          <strong>Locked collateral:</strong>{' '}
          <AssetAmount
            mode="raw"
            amount={loan.collateralAmount}
            address={loan.collateralAsset}
            meta={collateralMeta}
            assetType={loan.collateralAssetType}
            tokenId={loan.collateralTokenId}
          />
        </div>
        <div>
          <strong>Principal:</strong>{' '}
          <AssetAmount
            mode="raw"
            amount={loan.principal}
            address={loan.lendingAsset}
            meta={lendingMeta}
            assetType={loan.assetType}
            tokenId={loan.tokenId}
          />
        </div>
        <div><strong>Interest:</strong> {formatBpsAsPercent(loan.interestRateBps)} over {loan.durationDays} days</div>
        {isBorrower ? <div style={{ color: 'var(--text-secondary)' }}>{health.detail}</div> : null}
        <details>
          <summary>What happens if I do nothing?</summary>
          <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
            If you are the borrower and do not repay by the due date, the lender may receive your collateral after the grace period.
          </p>
        </details>
      </div>

      {msg ? <div className="banner banner-warn" style={{ marginTop: 16 }}>{msg}</div> : null}

      <div style={{ marginTop: 16 }}>
        {primary.action === 'repay' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !isCorrectChain}
            onClick={() => void run('repay')}
          >
            {primary.label}
          </button>
        ) : null}
        {primary.action === 'claim-collateral' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !isCorrectChain}
            onClick={() => void run('claim-borrower')}
          >
            {primary.label}
          </button>
        ) : null}
        {primary.action === 'claim-lender' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !isCorrectChain}
            onClick={() => void run('claim-lender')}
          >
            {primary.label}
          </button>
        ) : null}
      </div>

      <div style={{ marginTop: 16 }}>
        <HelpLink anchor="manage-loan" />
      </div>
    </div>
  );
}