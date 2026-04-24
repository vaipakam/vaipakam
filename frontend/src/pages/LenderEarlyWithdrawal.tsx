import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle } from 'lucide-react';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { RiskDisclosures } from '../components/app/RiskDisclosures';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract } from '../contracts/useDiamond';
import { useLoan } from '../hooks/useLoan';
import { usePositionLock, LockReason } from '../hooks/usePositionLock';
import { AssetType, LoanStatus } from '../types/loan';
import { decodeContractError } from '../lib/decodeContractError';
import {
  FALLBACK_CONSENT_CHECKBOX_LABEL,
} from '../lib/fallbackTerms';
import { beginStep } from '../lib/journeyLog';
import { DEFAULT_CHAIN } from '../contracts/config';
import { TransferLockWarning } from '../components/app/TransferLockWarning';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { TokenAmount } from '../components/app/TokenAmount';
import { bpsToPercent } from '../lib/format';
import './LoanDetails.css';

type Step = 'idle' | 'review' | 'submitting' | 'success';

/**
 * Lender Early Withdrawal — README §9 Option 2 (createLoanSaleOffer +
 * completeLoanSale). Initiating the flow natively locks the lender-side
 * position NFT; the lock clears on acceptance-completion or via cancellation
 * of the linked sale offer.
 */
export default function LenderEarlyWithdrawal() {
  const { loanId } = useParams();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  const activeBlockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;
  const diamond = useDiamondContract();
  const { loan, lenderHolder, loading, error, reload } = useLoan(loanId);
  const { lock, reload: reloadLock } = usePositionLock(loan?.lenderTokenId ?? null);

  const [rate, setRate] = useState('');
  const [fallbackConsent, setFallbackConsent] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const isLender =
    !!loan && !!address && !!lenderHolder &&
    lenderHolder.toLowerCase() === address.toLowerCase();
  const isActive = !!loan && Number(loan.status) === LoanStatus.Active;
  const isErc20 = !!loan && Number(loan.assetType) === AssetType.ERC20;
  const inProgress = lock === LockReason.EarlyWithdrawalSale;

  const ctxBase = {
    area: 'early-withdrawal' as const,
    wallet: address,
    chainId,
    loanId,
    role: 'lender' as const,
  };

  const handleInitiate = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    // Contract takes bps (e.g. 10% = 1000). Form input is a percent string.
    const bps = Math.round(Number(rate) * 100);
    if (!Number.isFinite(bps) || bps <= 0) {
      setTxError('Enter a valid interest rate greater than 0%.');
      return;
    }
    setStep('submitting');
    const s = beginStep({ ...ctxBase, flow: 'createLoanSaleOffer', step: 'submit-tx' });
    try {
      const tx = await diamond.createLoanSaleOffer(loan.id, BigInt(bps), fallbackConsent);
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      await reloadLock();
      setStep('success');
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, 'Failed to create loan sale offer'));
      setStep('review');
      s.failure(err);
    }
  };

  const handleComplete = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    setStep('submitting');
    const s = beginStep({ ...ctxBase, flow: 'completeLoanSale', step: 'submit-tx' });
    try {
      const tx = await diamond.completeLoanSale(loan.id);
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      await reloadLock();
      setStep('success');
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, 'Complete sale failed'));
      setStep('idle');
      s.failure(err);
    }
  };

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <p>Loading loan #{loanId}...</p>
      </div>
    );
  }

  if (error || !loan) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)' }}>
          <AlertTriangle size={28} />
        </div>
        <h3>Loan Not Found</h3>
        <p>{error || `Loan #${loanId} does not exist.`}</p>
        <Link to="/app" className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
      </div>
    );
  }

  if (!isLender) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)' }}>
          <AlertTriangle size={28} />
        </div>
        <h3>Lender only</h3>
        <p>Only the current holder of the lender-side Vaipakam NFT can initiate early withdrawal for this loan.</p>
        <Link to={`/app/loans/${loan.id.toString()}`} className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> Back to Loan
        </Link>
      </div>
    );
  }

  return (
    <div className="loan-details">
      <Link to={`/app/loans/${loan.id.toString()}`} className="back-link">
        <ArrowLeft size={16} /> Back to Loan #{loan.id.toString()}
      </Link>

      <div className="loan-header">
        <div>
          <h1 className="page-title">Early Withdrawal · Loan #{loan.id.toString()}</h1>
          <p className="page-subtitle">
            Sell your lender position to a new lender. Your lender-side Vaipakam NFT will be
            locked for transfer while the sale is pending.
          </p>
        </div>
      </div>

      {!isActive && (
        <div className="alert alert-warning">
          <AlertTriangle size={18} />
          <span>This loan is not active. Early withdrawal is only available on active loans.</span>
        </div>
      )}

      {isActive && !isErc20 && (
        <div className="alert alert-warning">
          <AlertTriangle size={18} />
          <span>
            Lender-side sale is only supported for ERC-20 loans in Phase 1. NFT-rental lender positions
            cannot be sold through this flow.
          </span>
        </div>
      )}

      {txHash && (
        <div className="alert alert-success">
          <CheckCircle size={18} />
          <span>
            Tx submitted:{' '}
            <a href={`${activeBlockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              {txHash.slice(0, 20)}...
            </a>
          </span>
        </div>
      )}

      {txError && <ErrorAlert message={txError} />}

      <div className="card">
        <div className="card-title">Position Summary</div>
        <div className="data-row">
          <span className="data-label">Principal</span>
          <span className="data-value">
            <TokenAmount amount={loan.principal} address={loan.principalAsset} />{' '}
            <AssetSymbol address={loan.principalAsset} />
          </span>
        </div>
        <div className="data-row">
          <span className="data-label">Original Rate</span>
          <span className="data-value">{bpsToPercent(loan.interestRateBps)}%</span>
        </div>
        <div className="data-row">
          <span className="data-label">Duration</span>
          <span className="data-value">{loan.durationDays.toString()} days</span>
        </div>
        <div className="data-row">
          <span className="data-label">Lender NFT</span>
          <span className="data-value mono">#{loan.lenderTokenId.toString()}</span>
        </div>
      </div>

      {isActive && isErc20 && (
        <div className="card loan-actions-card">
          <div className="card-title">{inProgress ? 'Sale In Progress' : 'Initiate Sale'}</div>

          {inProgress ? (
            <>
              <TransferLockWarning mode="active" lock={lock} tokenId={loan.lenderTokenId} />
              <p className="action-desc" style={{ marginTop: 12 }}>
                A sale offer is live for this loan. As soon as a new lender accepts it, the sale
                finalizes atomically in the same transaction — no extra click needed. Until
                acceptance the lender NFT cannot be transferred. To abort the flow, cancel the
                linked sale offer from the Offer Book. The manual button below is only needed as
                a recovery hook if auto-completion didn't run.
              </p>
              <div className="action-row">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleComplete}
                  disabled={step === 'submitting'}
                >
                  {step === 'submitting' ? 'Processing...' : 'Complete Sale (recovery)'}
                </button>
                <Link to="/app/offers" className="btn btn-secondary btn-sm">
                  View Offer Book
                </Link>
              </div>
            </>
          ) : step === 'review' || step === 'submitting' ? (
            <>
              <TransferLockWarning
                mode="pre-confirm"
                flow="early-withdrawal"
                tokenId={loan.lenderTokenId}
                role="lender"
              />
              <div className="data-row" style={{ marginTop: 12 }}>
                <span className="data-label">New rate</span>
                <span className="data-value">{rate}% per year</span>
              </div>
              <div className="data-row">
                <span className="data-label">Remaining term</span>
                <span className="data-value">inherits from live loan</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleInitiate}
                  disabled={step === 'submitting'}
                >
                  {step === 'submitting' ? 'Submitting...' : 'Confirm & Create Sale Offer'}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setStep('idle')}
                  disabled={step === 'submitting'}
                >
                  Back
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="action-desc">
                Set a new interest rate that a replacement lender will see on the sale offer. Noah
                (a new lender) can then accept the offer from the Offer Book. You forfeit accrued
                interest to treasury on completion.
              </p>
              <div className="action-row" style={{ alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">Sale interest rate (%)</label>
                  <input
                    className="form-input"
                    type="number"
                    step="any"
                    min="0"
                    placeholder="e.g. 5"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  />
                </div>
              </div>
              <RiskDisclosures />
              <label style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={fallbackConsent}
                  onChange={(e) => setFallbackConsent(e.target.checked)}
                />
                <span>{FALLBACK_CONSENT_CHECKBOX_LABEL}</span>
              </label>
              <div className="action-row" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setStep('review')}
                  disabled={!rate || !fallbackConsent}
                >
                  Review Sale Offer
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
