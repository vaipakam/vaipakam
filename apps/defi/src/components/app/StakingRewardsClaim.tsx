import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Coins, CheckCircle, ExternalLink } from 'lucide-react';
import { useDiamondContract } from '../../contracts/useDiamond';
import { useStakingRewards } from '../../hooks/useStakingRewards';
import { useRewardsClaimedHistory } from '../../hooks/useRewardsClaimedHistory';
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
  const { pending, aprBps, stale, reload, loading } = useStakingRewards(address ?? null);
  // Live APR from `getStakingAPRBps` (defaults to 500 = 5% but is
  // admin-configurable via `setStakingApr`). Interpolated into the
  // empty-state subtitle so the copy never falsely advertises 5% when
  // governance has changed the rate. Format with up to 2 decimal
  // places to handle non-round values like 575 → 5.75%.
  const aprPct = (Number(aprBps) / 100).toFixed(Number(aprBps) % 100 === 0 ? 0 : 2);
  // Lifetime claimed VPFI — derived from the shared
  // `useRewardsClaimedHistory` hook so this card, InteractionRewardsClaim
  // on Claim Center, and the new RewardsSummaryCard on Dashboard all
  // agree on the running total. See that hook's docstring for the
  // log-index scan and partial-cache caveat.
  const { stakingLifetimeClaimed: lifetimeClaimed } = useRewardsClaimedHistory(address);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  if (!address) return null;
  if (stale) return null;
  // Render even at all-zero state. The card doubles as a promotional
  // surface — a "0 VPFI pending" disabled-button view tells a fresh
  // user the program exists and how to start earning. The zero-state
  // gate previously hid the card on first visits, which made the
  // staking program effectively invisible until the user already
  // had escrow VPFI for some other reason.

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
    const inlineHasPending = pending > 0n;
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
          background: inlineHasPending ? 'rgba(16, 185, 129, 0.06)' : 'transparent',
        }}
      >
        <Coins size={16} style={{ color: inlineHasPending ? 'var(--accent-green)' : 'var(--text-secondary)', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
            {t('stakingRewards.pendingLabel')}
          </div>
          <div style={{ fontWeight: 600 }}>{headline}</div>
        </div>
        {/* Lifetime-claimed sub-block on the inline mirror — only renders
            when non-zero so a fresh user keeps the row clean. */}
        {lifetimeClaimed > 0n && (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
              {t('stakingRewards.lifetimeClaimedLabel')}
            </div>
            <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              <TokenAmount amount={lifetimeClaimed} address="vpfi" decimals={18} /> VPFI
            </div>
          </div>
        )}
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

  // Visual states:
  //   pending > 0 → green chrome + "available" copy. Real call to action.
  //   pending = 0 → neutral card chrome + informational copy. Hides
  //                 disabled-button shoutiness; reads as a passive
  //                 promo for the program until the user has rewards
  //                 to claim.
  const hasPending = pending > 0n;
  return (
    <div
      className="card"
      // `id` doubles as the deep-link anchor target the Dashboard
      // RewardsSummaryCard scrolls to via `/buy-vpfi#staking-rewards`.
      id="staking-rewards"
      style={
        hasPending
          ? {
              marginBottom: 12,
              borderColor: 'var(--accent-green)',
              background: 'rgba(16, 185, 129, 0.06)',
            }
          : { marginBottom: 12 }
      }
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
            background: hasPending ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.12)',
            color: hasPending ? 'var(--accent-green)' : 'var(--text-secondary)',
            flexShrink: 0,
          }}
        >
          <Coins size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {hasPending
              ? t('stakingRewards.titleAvailable')
              : t('stakingRewards.titleEmpty')}
          </div>
          <p className="stat-label" style={{ margin: 0 }}>
            {hasPending
              ? t('stakingRewards.subtitle')
              : t('stakingRewards.subtitleEmpty', { apr: aprPct })}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
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
            {/* Lifetime-claimed total — sums every StakingRewardsClaimed
                event in the log-index keyed to this wallet. Hidden when
                zero so a first-time staker sees only "Pending". */}
            {lifetimeClaimed > 0n && (
              <div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)' }}>
                  {t('stakingRewards.lifetimeClaimedLabel')}
                </div>
                <div style={{ fontSize: '1.05rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  <TokenAmount amount={lifetimeClaimed} address="vpfi" decimals={18} /> VPFI
                </div>
              </div>
            )}
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
