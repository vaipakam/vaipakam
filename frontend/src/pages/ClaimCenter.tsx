import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWallet } from '../context/WalletContext';
import { useDiamondContract } from '../contracts/useDiamond';
import { useClaimables } from '../hooks/useClaimables';
import { AssetType, LOAN_STATUS_LABELS, type ClaimableEntry, type LoanRole } from '../types/loan';
import { decodeContractError } from '../lib/decodeContractError';
import { beginStep } from '../lib/journeyLog';
import { DEFAULT_CHAIN } from '../contracts/config';
import { HandCoins, Wallet, CheckCircle, ExternalLink } from 'lucide-react';
import { ErrorAlert } from '../components/app/ErrorAlert';
import { AssetSymbol } from '../components/app/AssetSymbol';
import { TokenAmount } from '../components/app/TokenAmount';
import { InteractionRewardsClaim } from '../components/app/InteractionRewardsClaim';
import { CardInfo } from '../components/CardInfo';
import { L as Link } from '../components/L';
import './ClaimCenter.css';

export default function ClaimCenter() {
  const { t } = useTranslation();
  const { address, chainId, activeChain, isCorrectChain } = useWallet();
  const activeBlockExplorer =
    (activeChain && isCorrectChain ? activeChain.blockExplorer : null) ??
    DEFAULT_CHAIN.blockExplorer;
  const diamond = useDiamondContract();
  const { claims, loading, reload } = useClaimables(address);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const handleClaim = async (loanId: bigint, role: LoanRole) => {
    const key = `${loanId}-${role}`;
    setClaimingId(key);
    setError(null);
    setTxHash(null);
    const step = beginStep({
      area: 'claim',
      flow: role === 'lender' ? 'claimAsLender' : 'claimAsBorrower',
      step: 'submit-tx',
      wallet: address,
      chainId,
      loanId,
      role,
    });
    try {
      const tx = role === 'lender'
        ? await diamond.claimAsLender(loanId)
        : await diamond.claimAsBorrower(loanId);
      setTxHash(tx.hash);
      await tx.wait();
      reload();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setError(decodeContractError(err, 'Claim failed'));
      step.failure(err);
    } finally {
      setClaimingId(null);
    }
  };

  if (!address) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div className="empty-state-icon">
          <Wallet size={28} />
        </div>
        <h3>{t('claimCenter.connectTitle')}</h3>
        <p>{t('claimCenter.connectBody')}</p>
      </div>
    );
  }

  return (
    <div className="claim-center">
      <div className="page-header">
        <h1 className="page-title">
          {t('appNav.claimCenter')}
          <CardInfo id="claim-center.claims" />
        </h1>
        <p className="page-subtitle">{t('claimCenter.pageSubtitle')}</p>
      </div>

      {error && <ErrorAlert message={error} />}

      {txHash && (
        <div className="alert alert-success">
          <CheckCircle size={18} />
          <span>
            {t('claimCenter.claimSubmitted')}{' '}
            <a href={`${activeBlockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              {txHash.slice(0, 20)}...
            </a>
          </span>
        </div>
      )}

      {/* Platform-interaction VPFI rewards live here as a sibling to the
          per-loan claim rows below — Claim Center is the single home for
          "anywhere you can pull funds you're owed." Hides itself when
          the wallet has no pending interaction balance. The staking-
          rewards stream lives separately on the Buy VPFI page (Step 2)
          since it pairs naturally with the stake/unstake controls. */}
      <InteractionRewardsClaim
        address={address ?? null}
        chainId={chainId}
        blockExplorer={activeBlockExplorer}
      />

      <div className="card">
        {loading ? (
          <div className="empty-state">
            <p>{t('claimCenter.scanning')}</p>
          </div>
        ) : claims.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <HandCoins size={28} />
            </div>
            <h3>{t('claimCenter.noClaimableFunds')}</h3>
            <p>{t('claimCenter.noClaimableFundsBody')}</p>
          </div>
        ) : (
          <div className="claims-list">
            {claims.map((claim) => {
              const key = `${claim.loanId}-${claim.role}`;
              const isClaiming = claimingId === key;
              return (
                <div key={key} className="claim-row">
                  <div className="claim-info">
                    <div className="claim-loan-id">
                      {t('claimCenter.loanPrefix')}{' '}
                      {/* The loan-id doubles as a deep-link to the loan
                          details page so a user reviewing a pending
                          claim can jump to the full timeline / risk
                          panel without going back to the dashboard. */}
                      <Link
                        to={`/app/loans/${claim.loanId.toString()}`}
                        style={{ color: 'var(--brand)' }}
                      >
                        #{claim.loanId.toString()}
                      </Link>
                    </div>
                    <div className="claim-meta">
                      <span className={`status-badge ${claim.role}`}>
                        {claim.role === 'lender' ? t('common.lender') : t('common.borrower')}
                      </span>
                      <span className={`status-badge ${LOAN_STATUS_LABELS[claim.status].toLowerCase()}`}>
                        {LOAN_STATUS_LABELS[claim.status]}
                      </span>
                    </div>
                  </div>
                  <div className="claim-amount">
                    <div className="claim-value mono">{renderClaimPayload(claim)}</div>
                    <a
                      href={`${activeBlockExplorer}/address/${claim.claimableAsset}`}
                      target="_blank"
                      rel="noreferrer"
                      className="claim-asset"
                    >
                      <AssetSymbol address={claim.claimableAsset} /> <ExternalLink size={10} />
                    </a>
                    {claim.role === 'lender' && claim.heldForLender > 0n && (
                      <div className="claim-held mono">
                        + held <TokenAmount amount={claim.heldForLender} address={claim.claimableAsset} />
                      </div>
                    )}
                    {claim.role === 'borrower' && claim.lifRebate > 0n && (
                      <div className="claim-held mono" data-tooltip="Phase 5 LIF VPFI rebate: time-weighted discount on the initiation fee you paid up front in VPFI, earned across this loan's lifetime and credited at proper close. Paid out in the same Claim transaction.">
                        + rebate {(Number(claim.lifRebate) / 1e18).toString()} VPFI
                      </div>
                    )}
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleClaim(claim.loanId, claim.role)}
                    disabled={isClaiming}
                  >
                    {isClaiming ? t('claimCenter.claiming') : t('claimCenter.claim')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the claim payload based on assetType — ERC-20 gets the familiar
 * fungible amount, ERC-721 shows the specific NFT id, ERC-1155 shows the
 * id plus quantity. Prevents NFT claims from being silently hidden or
 * misrendered as a zero fungible balance.
 */
function renderClaimPayload(claim: ClaimableEntry) {
  if (claim.assetType === AssetType.ERC721) {
    return `NFT #${claim.tokenId.toString()}`;
  }
  if (claim.assetType === AssetType.ERC1155) {
    return `${claim.quantity.toString()} × #${claim.tokenId.toString()}`;
  }
  return <TokenAmount amount={claim.claimableAmount} address={claim.claimableAsset} />;
}
