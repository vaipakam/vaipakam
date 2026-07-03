import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  borrowerPrimaryAction,
  claimAsBorrower,
  claimAsLender,
  fetchLoanById,
  formatBpsAsPercent,
  isLoanSideClaimable,
  isNftRentalLoan,
  nftAssetKindLabel,
  plainHealthLabel,
  loanRoleForWallet,
  rentalDailyFeeWei,
  repayLoanFull,
} from '@vaipakam/defi-client';
import { shortenAddr } from '@vaipakam/lib/address';
import { AssetAmount } from '../components/AssetAmount';
import { HelpLink } from '../components/HelpLink';
import { useTokenMeta } from '../lib/tokenMeta';
import { useWallet } from '../context/WalletContext';
import { TechnicalRiskPanel } from '../components/TechnicalRiskPanel';
import { useMode } from '../context/ModeContext';
import { useLoanHealth } from '../hooks/useLoanHealth';
import { useLoanRisks } from '../hooks/useLoanRisks';
import { useIndexerOrigin } from '../hooks/useIndexerOrigin';
import { useWalletClient } from 'wagmi';
import type { Address } from 'viem';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from '../hooks/useDiamond';
import { DEFI_CLASSIC_LINKS } from '../lib/defiClassicLinks';

export function PositionDetailPage() {
  const { loanId } = useParams();
  const id = Number(loanId);
  const chain = useReadChain();
  const { address, isCorrectChain } = useWallet();
  const diamond = useDiamondContract();
  const publicClient = useDiamondPublicClient();
  const { data: walletClient } = useWalletClient();
  const origin = useIndexerOrigin();
  const { mode } = useMode();
  const { data: hf } = useLoanHealth(id);
  const { data: riskMap, isLoading: riskLoading } = useLoanRisks(Number.isFinite(id) ? [id] : []);

  const { data: loan, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['loan', chain.chainId, id, origin],
    enabled: Number.isFinite(id) && Boolean(origin),
    queryFn: () => fetchLoanById(origin!, chain.chainId, id),
  });

  const lendingMeta = useTokenMeta(loan?.lendingAsset ?? null);
  const collateralMeta = useTokenMeta(loan?.collateralAsset ?? null);

  const role = loan ? loanRoleForWallet(loan, address) : 'other';
  const needsBorrowerClaimProbe =
    (role === 'borrower' || role === 'both') &&
    (loan?.status === 'defaulted' ||
      loan?.status === 'internal_matched' ||
      loan?.status === 'liquidated') &&
    Boolean(chain.diamondAddress);
  const { data: borrowerClaimable } = useQuery({
    queryKey: ['loan-borrower-claimable', chain.chainId, id, chain.diamondAddress],
    enabled: needsBorrowerClaimProbe,
    queryFn: () =>
      isLoanSideClaimable(
        publicClient,
        chain.diamondAddress as Address,
        id,
        false,
      ),
    staleTime: 20_000,
  });

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!origin) {
    return (
      <div>
        <p className="banner banner-warn">
          Indexer is not configured. Set <code>VITE_INDEXER_ORIGIN</code> in <code>.env.local</code>{' '}
          to load loan details.
        </p>
        <Link to="/positions">← Back to positions</Link>
      </div>
    );
  }

  if (isLoading) return <p>Loading loan…</p>;
  if (isError) {
    const msg = error instanceof Error ? error.message : 'Indexer request failed';
    return (
      <div>
        <p className="banner banner-error">Could not load loan from the indexer: {msg}</p>
        <button type="button" className="btn btn-secondary" onClick={() => void refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!loan) return <p>Loan not found.</p>;

  const rental = loan ? isNftRentalLoan(loan) : false;
  const isBorrower = role === 'borrower' || role === 'both';
  const health = plainHealthLabel(isBorrower && !rental ? hf : null);
  const rolesForAction: ('borrower' | 'lender')[] =
    role === 'both'
      ? ['borrower', 'lender']
      : role === 'borrower' || role === 'lender'
        ? [role]
        : [];
  let primary: ReturnType<typeof borrowerPrimaryAction> = {
    action: 'none',
    label: 'No action available',
  };
  for (const actionRole of rolesForAction) {
    const candidate = borrowerPrimaryAction({
      role: actionRole,
      loanStatus: loan.status,
      healthTone: actionRole === 'borrower' ? health.tone : 'ok',
      isRental: rental,
      borrowerClaimable:
        actionRole === 'borrower' &&
        (loan.status === 'defaulted' ||
          loan.status === 'internal_matched' ||
          loan.status === 'liquidated')
          ? borrowerClaimable
          : undefined,
    });
    if (candidate.action !== 'none') {
      primary = candidate;
      break;
    }
  }

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
      ? rental
        ? 'Active'
        : isBorrower
          ? health.label
          : 'Active'
      : loan.status === 'repaid'
        ? 'Repaid — ready to claim'
        : loan.status;

  return (
    <div>
      <Link to="/positions" style={{ fontSize: '0.9rem' }}>← Back to positions</Link>
      <h1 className="page-title" style={{ marginTop: 12 }}>
        {rental ? `Rental #${loan.loanId}` : `Loan #${loan.loanId}`}
      </h1>
      <p className="page-subtitle">
        Role:{' '}
        {role === 'borrower'
          ? rental
            ? 'Renter'
            : 'Borrower'
          : role === 'lender'
            ? rental
              ? 'NFT owner'
              : 'Lender'
            : role === 'both'
              ? 'Borrower & lender'
              : 'Viewer'}{' '}
        · {statusLabel}
      </p>

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {rental ? (
          <>
            <div>
              <strong>NFT:</strong> {nftAssetKindLabel(loan.assetType)} #{loan.tokenId} ({shortenAddr(loan.lendingAsset)})
            </div>
            <div>
              <strong>Daily fee:</strong>{' '}
              <AssetAmount
                mode="raw"
                amount={rentalDailyFeeWei({ amount: loan.principal }).toString()}
                address={loan.collateralAsset}
                meta={collateralMeta}
              />{' '}
              · {loan.durationDays} days
            </div>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              {isBorrower
                ? 'You have temporary use rights only. The NFT stays in vault custody.'
                : 'Your NFT stays in vault custody while the renter holds temporary use rights.'}
            </p>
            <details>
              <summary>What happens if I do nothing?</summary>
              <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
                If the renter does not close before the term ends, rights reset through the rental expiry path and
                settlement follows the protocol rental rules.
              </p>
            </details>
          </>
        ) : (
          <>
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
            <div>
              <strong>Interest:</strong> {formatBpsAsPercent(loan.interestRateBps)} over {loan.durationDays} days
            </div>
            {isBorrower ? <div style={{ color: 'var(--text-secondary)' }}>{health.detail}</div> : null}
            {mode === 'advanced' && isBorrower ? (
              <TechnicalRiskPanel risk={riskMap?.get(loan.loanId)} loading={riskLoading} />
            ) : null}
            <details>
              <summary>What happens if I do nothing?</summary>
              <p style={{ marginTop: 8, color: 'var(--text-secondary)' }}>
                If you are the borrower and do not repay by the due date, the lender may receive your collateral after
                the grace period.
              </p>
            </details>
          </>
        )}
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

      {mode === 'advanced' && !rental && loan.status === 'active' ? (
        <div className="card" style={{ marginTop: 16 }}>
          <strong>More protocol actions</strong>
          <p style={{ margin: '8px 0 12px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Add collateral, partial repay, preclose, refinance, and early withdrawal live in the classic app
            until alpha01 catches up.
          </p>
          <a
            href={DEFI_CLASSIC_LINKS.loan(loan.loanId)}
            className="btn btn-secondary"
            target="_blank"
            rel="noreferrer"
          >
            Open loan in classic app →
          </a>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <HelpLink anchor="manage-loan" />
      </div>
    </div>
  );
}