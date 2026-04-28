import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle, ExternalLink } from 'lucide-react';
import { useDiamondContract } from '../../contracts/useDiamond';
import { useInteractionRewards } from '../../hooks/useInteractionRewards';
import { decodeContractError } from '../../lib/decodeContractError';
import { beginStep } from '../../lib/journeyLog';
import { TokenAmount } from './TokenAmount';
import { ErrorAlert } from './ErrorAlert';

interface Props {
  /** Connected wallet address. Disconnected wallets see nothing. */
  address: string | null | undefined;
  /** Connected wallet's chainId, threaded through to journeyLog. */
  chainId: number | null | undefined;
  /** Block-explorer base URL for tx-hash deep links (no trailing slash). */
  blockExplorer: string;
}

/**
 * Inline claim card for the platform-interaction VPFI reward stream.
 * Lives at the top of Claim Center alongside the per-loan claim rows.
 *
 * Hides itself when the wallet has zero pending and isn't waiting on a
 * cross-chain finalization — a fresh user who hasn't yet engaged with
 * the platform doesn't see a "0 VPFI" prompt. When the spec §4a
 * finalization gate is open (claimability returns
 * `finalizedPrefix === false && waitingForDay > 0`), the card surfaces
 * a "waiting on day X" status instead of a claim button so the user
 * understands a click would revert. Once finalization lands, the card
 * flips to an active Claim button driven by `previewInteractionRewards`.
 */
export function InteractionRewardsClaim({ address, chainId, blockExplorer }: Props) {
  const { t } = useTranslation();
  const diamond = useDiamondContract();
  const { pending, finalizedPrefix, waitingForDay, stale, reload, loading } =
    useInteractionRewards(address ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  if (!address) return null;
  if (stale) return null;
  // Nothing pending AND not waiting on a finalization → don't render.
  // A user who never engaged with the platform doesn't see a 0-VPFI
  // promo on the Claim Center.
  const isWaiting = !finalizedPrefix && waitingForDay > 0n;
  if (pending === 0n && !isWaiting) return null;

  const handleClaim = async () => {
    if (pending === 0n) return;
    setSubmitting(true);
    setError(null);
    setTxHash(null);
    const step = beginStep({
      area: 'rewards',
      flow: 'claimInteractionRewards',
      step: 'submit-tx',
      wallet: address,
      chainId,
    });
    try {
      const tx = await diamond.claimInteractionRewards();
      setTxHash(tx.hash);
      await tx.wait();
      reload();
      step.success({ note: `tx ${tx.hash}` });
    } catch (err) {
      setError(decodeContractError(err, t('interactionRewards.claimFailed')));
      step.failure(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="card"
      style={{
        marginBottom: 16,
        borderColor: 'var(--brand)',
        background: 'rgba(79, 70, 229, 0.06)',
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
            background: 'rgba(79, 70, 229, 0.15)',
            color: 'var(--brand)',
            flexShrink: 0,
          }}
        >
          <Activity size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('interactionRewards.title')}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {t('interactionRewards.subtitle')}
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
                {t('interactionRewards.pendingLabel')}
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                <TokenAmount amount={pending} address="vpfi" decimals={18} /> VPFI
              </div>
            </div>
            {isWaiting ? (
              <span
                className="status-badge"
                data-tooltip={t('interactionRewards.waitingTooltip', {
                  day: waitingForDay.toString(),
                })}
                style={{
                  background: 'rgba(245, 158, 11, 0.12)',
                  color: 'var(--accent-orange, #f59e0b)',
                }}
              >
                {t('interactionRewards.waiting', { day: waitingForDay.toString() })}
              </span>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleClaim}
                disabled={submitting || pending === 0n || loading}
              >
                {submitting ? t('interactionRewards.claiming') : t('interactionRewards.claim')}
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <div style={{ marginTop: 12 }}><ErrorAlert message={error} /></div>}
      {txHash && (
        <div className="alert alert-success" style={{ marginTop: 12 }}>
          <CheckCircle size={16} />
          <span>
            {t('interactionRewards.submitted')}{' '}
            <a href={`${blockExplorer}/tx/${txHash}`} target="_blank" rel="noreferrer">
              {txHash.slice(0, 16)}…<ExternalLink size={11} style={{ verticalAlign: 'middle' }} />
            </a>
          </span>
        </div>
      )}
    </div>
  );
}
