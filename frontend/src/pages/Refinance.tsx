import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { L as Link } from '../components/L';
import { useTranslation } from 'react-i18next';
import { maxUint256 as MaxUint256 } from 'viem';
import { AlertTriangle, ArrowLeft, CheckCircle } from 'lucide-react';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { InterestImplicationWarning } from '../components/app/InterestImplicationWarning';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract } from '../contracts/useDiamond';
import { useERC20 } from '../contracts/useERC20';
import { useLoan } from '../hooks/useLoan';
import { AssetType, LoanStatus } from '../types/loan';
import { decodeContractError } from '../lib/decodeContractError';
import { beginStep } from '../lib/journeyLog';
import { DEFAULT_CHAIN } from '../contracts/config';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { TokenAmount } from '../components/app/TokenAmount';
import { bpsToPercent } from '../lib/format';
import { CardInfo } from '../components/CardInfo';
import './LoanDetails.css';

type Step = 'idle' | 'review' | 'submitting' | 'success';

// Mirrors the `OfferAssetKind` strings CreateOffer expects on its query
// params — kept local because the refinance page is the only caller.
function assetTypeParam(t: bigint): string {
  const n = Number(t);
  return n === AssetType.ERC721 ? 'erc721' : n === AssetType.ERC1155 ? 'erc1155' : 'erc20';
}

/**
 * Borrower Refinance — README §"Allow Borrower to Choose New Lender".
 *
 * Two-step UX (matches the atomic on-chain flow):
 *   1. Borrower posts a Borrower Offer via the existing Create Offer page.
 *   2. Once a replacement lender accepts the offer (creating a new loan),
 *      the borrower returns here, enters the accepted offer ID, and calls
 *      refinanceLoan to close the original loan and collect old collateral.
 *
 * Transfer-lock warning is shown per WebsiteReadme §"Strategic-flow
 * transfer-lock UX requirements" even though refinanceLoan is atomic — the
 * warning keeps the UX contract consistent across preclose, refinance, and
 * early-withdrawal per spec.
 */
export default function Refinance() {
  const { t } = useTranslation();
  const { loanId } = useParams();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  // Active-chain Diamond + explorer (fallback: DEFAULT_CHAIN). Approvals
  // must target the Diamond on the user's current chain.
  const activeDiamondAddr =
    (activeChain && isCorrectChain ? activeChain.diamondAddress : null) ??
    DEFAULT_CHAIN.diamondAddress;
  const activeBlockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;
  const diamond = useDiamondContract();
  const { loan, borrowerHolder, loading, error, reload } = useLoan(loanId);
  const erc20 = useERC20(loan?.principalAsset ?? null);

  const [offerIdStr, setOfferIdStr] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const isBorrower =
    !!loan && !!address && !!borrowerHolder &&
    borrowerHolder.toLowerCase() === address.toLowerCase();
  const isActive = !!loan && Number(loan.status) === LoanStatus.Active;
  const isErc20Loan = !!loan && Number(loan.assetType) === AssetType.ERC20;

  const ctxBase = {
    area: 'refinance' as const,
    wallet: address,
    chainId,
    loanId,
    role: 'borrower' as const,
  };

  const ensureAllowance = async (needed: bigint) => {
    if (!erc20 || !address || needed === 0n) return;
    const diamondAddr = activeDiamondAddr;
    const current = (await erc20.allowance(address, diamondAddr)) as bigint;
    if (current >= needed) return;
    const tx = await erc20.approve(diamondAddr, needed);
    await tx.wait();
  };

  const handleRefinance = async () => {
    if (!loan) return;
    setTxError(null);
    setTxHash(null);
    let offerId: bigint;
    try {
      offerId = BigInt(offerIdStr);
    } catch {
      setTxError('Enter a valid offer ID.');
      return;
    }
    if (offerId <= 0n) {
      setTxError('Offer ID must be a positive integer.');
      return;
    }
    setStep('submitting');
    const s = beginStep({
      ...ctxBase,
      flow: 'refinanceLoan',
      step: 'submit-tx',
      offerId: offerId.toString(),
    });
    try {
      // Borrower must repay old lender (principal + full-term interest +
      // shortfall + treasury fee). We don't know shortfall client-side, so
      // request max allowance — user can revoke afterwards.
      await ensureAllowance(MaxUint256);
      const tx = await diamond.refinanceLoan(loan.id, offerId);
      setTxHash(tx.hash);
      await tx.wait();
      await reload();
      setStep('success');
      s.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setTxError(decodeContractError(err, 'Refinance failed'));
      setStep('review');
      s.failure(err);
    }
  };

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <p>{t('loanDetails.loadingLoan', { id: loanId })}</p>
      </div>
    );
  }

  if (error || !loan) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)' }}>
          <AlertTriangle size={28} />
        </div>
        <h3>{t('loanDetails.loanNotFound')}</h3>
        <p>{error || t('loanDetails.loanNotFoundBody', { id: loanId })}</p>
        <Link to="/app" className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> {t('loanDetails.backToDashboard')}
        </Link>
      </div>
    );
  }

  if (!isBorrower) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon" style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--accent-red)' }}>
          <AlertTriangle size={28} />
        </div>
        <h3>{t('loanFlow.borrowerOnly')}</h3>
        <p>{t('loanFlow.borrowerOnlyRefinance')}</p>
        <Link to={`/app/loans/${loan.id.toString()}`} className="btn btn-secondary btn-sm">
          <ArrowLeft size={16} /> {t('loanFlow.backToLoan')}
        </Link>
      </div>
    );
  }

  return (
    <div className="loan-details">
      <Link to={`/app/loans/${loan.id.toString()}`} className="back-link">
        <ArrowLeft size={16} /> {t('loanFlow.backToLoan')} #{loan.id.toString()}
      </Link>

      <div className="loan-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('refinance.pageTitle', { id: loan.id.toString() })}
            <CardInfo id="refinance.overview" />
          </h1>
          <p className="page-subtitle">{t('refinance.pageSubtitle')}</p>
        </div>
      </div>

      {!isActive && (
        <div className="alert alert-warning">
          <AlertTriangle size={18} />
          <span>{t('loanFlow.notActiveRefinance')}</span>
        </div>
      )}

      {isActive && !isErc20Loan && (
        <div className="alert alert-warning">
          <AlertTriangle size={18} />
          <span>{t('refinance.phase1Erc20Only')}</span>
        </div>
      )}

      {txHash && (
        <div className="alert alert-success">
          <CheckCircle size={18} />
          <span>
            {t('loanFlow.txSubmitted')}{' '}
            <a href={`${activeBlockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              {txHash.slice(0, 20)}...
            </a>
          </span>
        </div>
      )}

      {txError && <ErrorAlert message={txError} />}

      <div className="card">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('loanFlow.positionSummary')}
          <CardInfo id="refinance.position-summary" />
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanDetails.principal')}</span>
          <span className="data-value">
            <TokenAmount amount={loan.principal} address={loan.principalAsset} />{' '}
            <AssetSymbol address={loan.principalAsset} />
          </span>
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanFlow.rate')}</span>
          <span className="data-value">{bpsToPercent(loan.interestRateBps)}%</span>
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanDetails.duration')}</span>
          <span className="data-value">{loan.durationDays.toString()} {t('loanDetails.daysSuffix')}</span>
        </div>
        <div className="data-row">
          <span className="data-label">{t('loanFlow.borrowerNft')}</span>
          <span className="data-value mono">#{loan.borrowerTokenId.toString()}</span>
        </div>
      </div>

      {isActive && isErc20Loan && (
        <div className="card loan-actions-card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('refinance.step1Title')}
            <CardInfo id="refinance.step-1-post-offer" />
          </div>
          <p className="action-desc">
            Create a Borrower Offer that mirrors this loan's principal asset and your desired new
            terms (rate, duration, collateral). A replacement lender accepts it from the Offer Book,
            sending principal to you and creating a new loan. Then return here with that offer ID.
          </p>
          <p className="action-desc" style={{ marginTop: 8 }}>
            <strong>Asset continuity is enforced by the contract.</strong>{' '}
            {/* See RefinanceFacet.refinanceLoan — lendingAsset, collateralAsset,
                collateralAssetType, and prepayAsset on the new Borrower Offer
                must match the original loan or the refinance reverts. */}
            The new offer must use the same principal asset, collateral asset,
            collateral asset-type, and prepay asset as this loan. The button
            below opens Create Offer with those fields pre-filled and locked.
          </p>
          <div className="action-row">
            <Link
              to={`/app/create-offer?${new URLSearchParams({
                from: 'refinance',
                loanId: loan.id.toString(),
                offerType: 'borrower',
                lendingAsset: loan.principalAsset,
                collateralAsset: loan.collateralAsset,
                collateralAssetType: assetTypeParam(loan.collateralAssetType),
                prepayAsset: loan.prepayAsset ?? '',
                amount: loan.principal.toString(),
              }).toString()}`}
              className="btn btn-primary btn-sm"
            >
              {t('refinance.createOfferButton')}
            </Link>
          </div>
        </div>
      )}

      {isActive && isErc20Loan && (
        <div className="card loan-actions-card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {t('refinance.step2Title')}
            <CardInfo id="refinance.step-2-complete" />
          </div>
          {step === 'review' || step === 'submitting' ? (
            <>
              <div className="data-row" style={{ marginTop: 12 }}>
                <span className="data-label">{t('refinance.acceptedOfferIdLabel')}</span>
                <span className="data-value">#{offerIdStr}</span>
              </div>
              <p className="action-desc" style={{ marginTop: 12 }}>
                Clicking Confirm atomically repays the old lender (principal +
                full-term interest + any rate shortfall + treasury fee) and
                releases your original collateral in a single transaction — no
                NFT transfer-lock is needed because there is no intermediate
                state to protect.
              </p>
              <InterestImplicationWarning kind="refinance" />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleRefinance}
                  disabled={step === 'submitting'}
                >
                  {step === 'submitting' ? t('refinance.submitting') : t('refinance.confirmButton')}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setStep('idle')}
                  disabled={step === 'submitting'}
                >
                  {t('refinance.back')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="action-desc">
                Enter the ID of the Borrower Offer you created in step 1 — it must have been
                accepted by a replacement lender already. The refinance is atomic: the old loan
                closes and your original collateral becomes claimable in the same transaction.
              </p>
              <div className="action-row" style={{ alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">{t('refinance.acceptedOfferIdInputLabel')}</label>
                  <input
                    className="form-input"
                    type="text"
                    placeholder="e.g. 42"
                    value={offerIdStr}
                    onChange={(e) => setOfferIdStr(e.target.value)}
                  />
                </div>
              </div>
              <div className="action-row" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => setStep('review')}
                  disabled={!offerIdStr}
                >
                  {t('refinance.reviewButton')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
