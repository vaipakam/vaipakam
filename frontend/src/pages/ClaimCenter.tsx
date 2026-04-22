import { useState } from 'react';
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
import './ClaimCenter.css';

export default function ClaimCenter() {
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
        <h3>Connect Your Wallet</h3>
        <p>Connect your wallet to view and claim your funds.</p>
      </div>
    );
  }

  return (
    <div className="claim-center">
      <div className="page-header">
        <h1 className="page-title">Claim Center</h1>
        <p className="page-subtitle">
          Claim your funds and collateral from completed, repaid, or defaulted loans using your Vaipakam NFT.
        </p>
      </div>

      {error && <ErrorAlert message={error} />}

      {txHash && (
        <div className="alert alert-success">
          <CheckCircle size={18} />
          <span>
            Claim submitted:{' '}
            <a href={`${activeBlockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              {txHash.slice(0, 20)}...
            </a>
          </span>
        </div>
      )}

      <div className="card">
        {loading ? (
          <div className="empty-state">
            <p>Scanning your loans for claimable funds...</p>
          </div>
        ) : claims.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <HandCoins size={28} />
            </div>
            <h3>No Claimable Funds</h3>
            <p>You have no pending claims. Funds become claimable after a loan is repaid, defaulted, or settled.</p>
          </div>
        ) : (
          <div className="claims-list">
            {claims.map((claim) => {
              const key = `${claim.loanId}-${claim.role}`;
              const isClaiming = claimingId === key;
              return (
                <div key={key} className="claim-row">
                  <div className="claim-info">
                    <div className="claim-loan-id">Loan #{claim.loanId.toString()}</div>
                    <div className="claim-meta">
                      <span className={`status-badge ${claim.role}`}>
                        {claim.role === 'lender' ? 'Lender' : 'Borrower'}
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
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleClaim(claim.loanId, claim.role)}
                    disabled={isClaiming}
                  >
                    {isClaiming ? 'Claiming...' : 'Claim'}
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
