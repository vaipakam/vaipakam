import { useMemo } from 'react';
import { useLogIndex } from './useLogIndex';

interface RewardsClaimedHistory {
  /** Sum of every `StakingRewardsClaimed` event's `amount` for the
   *  connected wallet, in VPFI base units (18 decimals). */
  stakingLifetimeClaimed: bigint;
  /** Sum of every `InteractionRewardsClaimed` event's `amount` for the
   *  connected wallet, in VPFI base units (18 decimals). */
  interactionLifetimeClaimed: bigint;
}

/**
 * Lifetime-claimed VPFI for a wallet, derived from the per-(chain,
 * diamond) log-index. There's no on-chain getter for either running
 * total — the events carry the full history, so we sum them client-side.
 *
 * Three surfaces consume this: `<StakingRewardsClaim>` (Buy VPFI),
 * `<InteractionRewardsClaim>` (Claim Center), and the new dashboard
 * `<RewardsSummaryCard>`. Hoisting the scan into a shared hook keeps
 * the three lifetime numbers in lockstep — a stale cache that hasn't
 * yet seen the latest claim will show identical figures everywhere
 * rather than a paradoxical mix where the dashboard total disagrees
 * with the per-card breakdown.
 *
 * Same caveat as inherited from `useLogIndex`: a fresh browser cache
 * shows 0 (or partial) lifetime until the per-(chain, diamond) log-
 * index scan backfills the historic blocks. Once it does, the number
 * jumps. We deliberately don't gate render on the scan completing —
 * partial-then-complete is the same trust model the existing cards
 * use today, and a loading skeleton on the dashboard would block
 * other unrelated content.
 */
export function useRewardsClaimedHistory(
  address: string | null | undefined,
): RewardsClaimedHistory {
  const { events } = useLogIndex();
  return useMemo(() => {
    if (!address) {
      return { stakingLifetimeClaimed: 0n, interactionLifetimeClaimed: 0n };
    }
    const me = address.toLowerCase();
    let staking = 0n;
    let interaction = 0n;
    for (const ev of events) {
      if (typeof ev.args.user !== 'string' || ev.args.user !== me) continue;
      if (typeof ev.args.amount !== 'string') continue;
      try {
        if (ev.kind === 'StakingRewardsClaimed') {
          staking += BigInt(ev.args.amount);
        } else if (ev.kind === 'InteractionRewardsClaimed') {
          interaction += BigInt(ev.args.amount);
        }
      } catch {
        // skip malformed amount strings
      }
    }
    return {
      stakingLifetimeClaimed: staking,
      interactionLifetimeClaimed: interaction,
    };
  }, [events, address]);
}
