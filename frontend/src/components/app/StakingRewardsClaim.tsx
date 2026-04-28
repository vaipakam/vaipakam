import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Coins, CheckCircle, ExternalLink } from 'lucide-react';
import { useDiamondContract } from '../../contracts/useDiamond';
import { useStakingRewards } from '../../hooks/useStakingRewards';
import { decodeContractError } from '../../lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';
import { TokenAmount } from './TokenAmount';
import { ErrorAlert } from './ErrorAlert';

interface Props {
  /** Connected wallet address; controls visibility — disconnected wallets
   *  see nothing rather than a meaningless zeroed card. */
  address: string | null | undefined;
  /** Connected wallet's chainId, threaded through to journeyLog. */
  chainId: number | null | undefined;
  /** Block-explorer base URL for tx-hash deep links (no trailing slash). */
  blockExplorer: string;
  /** Visual variant — `'card'` (full card on Buy VPFI) or `'inline'`
   *  (compact row mirrored on the Dashboard's Discount Status card). */
  variant?: 'card' | 'inline';
}

/**
 * Shows the connected wallet's pending VPFI staking rewards and lets them
 * claim with one click. Reads via `previewStakingRewards`; writes via
 * `claimStakingRewards`. Hides itself entirely while pending == 0 and
 * `staked == 0` — no point screaming "0 VPFI rewards" at a fresh user
 * who hasn't staked anything yet.
 *
 * Two layouts share one component to keep behaviour identical between
 * the Buy VPFI page (full card) and the Dashboard mirror (inline row).
 */
export function StakingRewardsClaim({ address, chainId, blockExplorer, variant = 'card' }: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondContract();
  const { pending, staked, stale, reload, loading } = useStakingRewards(address ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  if (!address) return null;
  if (stale) return null;
  // Nothing staked AND nothing pending → don't render. A user who staked
  // before but unstaked can still see a non-zero pending until they claim.
  if (staked === 0n && pending === 0n) return null;

  const handleClaim = async () => {
    if (pending === 0n) return;
    setSubmitting(true);
    setError(null);
    setTxHash(null);
    const step = beginStep({
      area: 'staking',
      flow: 'claimStakingRewards',
      step: 'submit-tx',
      wallet: address,
      chainId,
    });
    try {
      const tx = await diamond.claimStakingRewards();
      setTxHash(tx.hash);
      await tx.wait();
      reload();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setError(decodeContractError(err, t('stakingRewards.claimFailed')));
      step.failure(err);
    } finally {
      setSubmitting(false);
    }
  };

  const button = (
    <button
      className="btn btn-primary btn-sm"
      onClick={handleClaim}
      disabled={submitting || pending === 0n || loading}
    >
      {submitting ? t('stakingRewards.claiming') : t('stakingRewards.claim')}
    </button>
  );

  const headline = (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      <TokenAmount amount={pending} address="vpfi" decimals={18} /> VPFI
    </span>
  );

  if (variant === 'inline') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: 10,
          marginTop: 12,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'rgba(16, 185, 129, 0.06)',
        }}
      >
        <Coins size={16} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
            {t('stakingRewards.pendingLabel')}
          </div>
          <div style={{ fontWeight: 600 }}>{headline}</div>
        </div>
        {button}
        {txHash && (
          <a
            href={`${blockExplorer}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        marginBottom: 12,
        borderColor: 'var(--accent-green)',
        background: 'rgba(16, 185, 129, 0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'rgba(16, 185, 129, 0.15)',
            color: 'var(--accent-green)',
            flexShrink: 0,
          }}
        >
          <Coins size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('stakingRewards.title')}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {t('stakingRewards.subtitle')}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: 12,
            }}
          >
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                {t('stakingRewards.pendingLabel')}
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>{headline}</div>
            </div>
            {button}
          </div>
        </div>
      </div>

      {error && <div style={{ marginTop: 12 }}><ErrorAlert message={error} /></div>}
      {txHash && (
        <div className="alert alert-success" style={{ marginTop: 12 }}>
          <CheckCircle size={16} />
          <span>
            {t('stakingRewards.submitted')}{' '}
            <a href={`${blockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
              {txHash.slice(0, 16)}…<ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
          </span>
        </div>
      )}
    </div>
  );
}
