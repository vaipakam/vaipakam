import { useTranslation } from 'react-i18next';
import { Coins, Activity, ChevronRight } from 'lucide-react';
import { L as Link } from '../L';
import { useStakingRewards } from '../../hooks/useStakingRewards';
import { useStakingApr } from '../../hooks/useStakingApr';
import { useInteractionRewards } from '../../hooks/useInteractionRewards';
import { useRewardsClaimedHistory } from '../../hooks/useRewardsClaimedHistory';
import { TokenAmount } from './TokenAmount';
import { CardInfo } from '../CardInfo';

interface Props {
  /** Connected wallet address. Disconnected wallets see nothing. */
  address: string | null | undefined;
}

/**
 * Aspirational rewards summary on the Dashboard. Surfaces the
 * connected wallet's combined VPFI rewards picture in one card:
 *
 *   - Big "total earned" headline = sum of (staking pending +
 *     staking lifetime claimed + interaction pending + interaction
 *     lifetime claimed).
 *   - Two breakdown rows — one per reward stream — each showing
 *     pending + lifetime claimed and a chevron deep-link to the
 *     full claim card on the appropriate page (staking lives on
 *     Buy VPFI; interaction lives on Claim Center).
 *
 * Always renders for connected wallets, even at all-zero state. The
 * "0 VPFI earned, here's how to start" framing is itself the value
 * — a fresh user otherwise has no signal that the rewards programs
 * exist short of wandering into Buy VPFI or Claim Center.
 *
 * Data sources are the same hooks the underlying claim cards use,
 * so the dashboard can never disagree with the per-card breakdown
 * about either a pending number or a lifetime number.
 */
export function RewardsSummaryCard({ address }: Props) {
  const { t } = useTranslation();
  const { pending: stakingPending, stale: stakingStale } = useStakingRewards(
    address ?? null,
  );
  const { pending: interactionPending, stale: interactionStale } =
    useInteractionRewards(address ?? null);
  const { stakingLifetimeClaimed, interactionLifetimeClaimed } =
    useRewardsClaimedHistory(address);
  // Live staking APR for the empty-state hint's `{{apr}}%` placeholder.
  // Goes through the live read so governance rate changes flow through
  // to the copy without a frontend redeploy — same convention as the
  // rest of the app's APR-mentioning surfaces.
  const { aprPct } = useStakingApr();

  if (!address) return null;

  const totalEarned =
    (stakingStale ? 0n : stakingPending) +
    (interactionStale ? 0n : interactionPending) +
    stakingLifetimeClaimed +
    interactionLifetimeClaimed;

  const stakingTotal =
    (stakingStale ? 0n : stakingPending) + stakingLifetimeClaimed;
  const interactionTotal =
    (interactionStale ? 0n : interactionPending) + interactionLifetimeClaimed;

  const isFreshUser = totalEarned === 0n;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-title">
        {t('rewardsSummary.title')}
        <CardInfo id="dashboard.rewards-summary" />
      </div>

      {/* Aspirational headline. Even at zero this anchors the card and
          tells the user the program exists; the empty-state subtitle
          below carries the "how to start" framing. */}
      <div
        style={{
          padding: '12px 4px 14px',
          borderBottom: '1px solid var(--border)',
          marginBottom: 12,
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            marginBottom: 4,
          }}
        >
          {t('rewardsSummary.totalEarnedLabel')}
        </div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: isFreshUser ? 'var(--text)' : 'var(--brand)',
          }}
        >
          <TokenAmount
            amount={totalEarned}
            address="vpfi"
            decimals={18}
          />{' '}
          VPFI
        </div>
        {isFreshUser && (
          <div
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              marginTop: 6,
            }}
          >
            {t('rewardsSummary.freshUserHint', { apr: aprPct })}
          </div>
        )}
      </div>

      {/* Staking row — links to Buy VPFI's StakingRewardsClaim card. */}
      <RewardRow
        icon={<Coins size={16} aria-hidden="true" />}
        title={t('rewardsSummary.stakingTitle')}
        subtitle={t('rewardsSummary.stakingSubtitle')}
        pending={stakingStale ? 0n : stakingPending}
        lifetime={stakingLifetimeClaimed}
        total={stakingTotal}
        linkTo="/buy-vpfi#staking-rewards"
        linkLabel={t('rewardsSummary.manageOnBuyVpfi')}
      />

      {/* Interaction row — links to Claim Center's InteractionRewardsClaim. */}
      <RewardRow
        icon={<Activity size={16} aria-hidden="true" />}
        title={t('rewardsSummary.interactionTitle')}
        subtitle={t('rewardsSummary.interactionSubtitle')}
        pending={interactionStale ? 0n : interactionPending}
        lifetime={interactionLifetimeClaimed}
        total={interactionTotal}
        linkTo="/app/claims#interaction-rewards"
        linkLabel={t('rewardsSummary.openClaimCenter')}
      />
    </div>
  );
}

function RewardRow(props: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  pending: bigint;
  lifetime: bigint;
  total: bigint;
  linkTo: string;
  linkLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <Link
      to={props.linkTo}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 4px',
        borderRadius: 8,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
      aria-label={props.linkLabel}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface-2)',
          color: 'var(--brand)',
          flexShrink: 0,
        }}
      >
        {props.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{props.title}</div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            marginTop: 2,
          }}
        >
          {props.subtitle}
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text)',
            marginTop: 6,
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <span>
            <span style={{ color: 'var(--muted)' }}>
              {t('rewardsSummary.pendingLabel')}:
            </span>{' '}
            <strong>
              <TokenAmount amount={props.pending} address="vpfi" decimals={18} />
            </strong>
          </span>
          <span>
            <span style={{ color: 'var(--muted)' }}>
              {t('rewardsSummary.claimedLabel')}:
            </span>{' '}
            <strong>
              <TokenAmount amount={props.lifetime} address="vpfi" decimals={18} />
            </strong>
          </span>
        </div>
      </div>
      <ChevronRight
        size={20}
        aria-hidden="true"
        style={{ color: 'var(--muted)', flexShrink: 0 }}
      />
    </Link>
  );
}
