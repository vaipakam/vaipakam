import { useCallback, useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';
import { useWallet } from '../context/WalletContext';
import { beginStep } from '../lib/journeyLog';

const SCALE_18 = 1_000_000_000_000_000_000n;

export interface StakingSnapshot {
  cap: bigint;
  paidOut: bigint;
  remaining: bigint;
  totalStaked: bigint;
  aprBps: number;
  userStaked: bigint;
  pending: bigint;
}

export interface InteractionSnapshot {
  cap: bigint;
  paidOut: bigint;
  remaining: bigint;
  launch: bigint;
  today: bigint;
  aprBps: number;
  lastClaimedDay: bigint;
  previewAmount: bigint;
  previewFromDay: bigint;
  previewToDay: bigint;
  // Spec §4a finalization gate. The diamond rejects a claim for `dayId`
  // until its cross-chain global denominator has been broadcast to this
  // chain. `finalizedPrefix` mirrors that gate so the UI can explain the
  // wait instead of silently showing zero.
  claimFromDay: bigint;
  claimWindowToDay: bigint;
  claimEffectiveToDay: bigint;
  finalizedPrefix: boolean;
  waitingForDay: bigint;
}

/**
 * Consolidated read of both reward pools — staking (escrow-VPFI APR) and
 * interaction (daily USD-share emissions). A single hook keeps the Rewards
 * page free of ten parallel `useEffect`s.
 */
export function useRewards() {
  const diamond = useDiamondRead();
  const { address } = useWallet();
  const [staking, setStaking] = useState<StakingSnapshot | null>(null);
  const [interaction, setInteraction] = useState<InteractionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'rewards',
      flow: 'useRewards',
      step: 'readSnapshots',
    });
    try {
      const d = diamond as unknown as {
        getStakingSnapshot: () => Promise<
          [bigint, bigint, bigint, bigint, bigint]
        >;
        getUserStakedVPFI: (u: string) => Promise<bigint>;
        previewStakingRewards: (u: string) => Promise<bigint>;
        getInteractionSnapshot: () => Promise<
          [bigint, bigint, bigint, bigint, bigint, bigint]
        >;
        getInteractionLastClaimedDay: (u: string) => Promise<bigint>;
        previewInteractionRewards: (
          u: string,
        ) => Promise<[bigint, bigint, bigint]>;
        getInteractionClaimability: (
          u: string,
        ) => Promise<[bigint, bigint, bigint, boolean, bigint]>;
      };

      const [stakeTuple, interTuple] = await Promise.all([
        d.getStakingSnapshot(),
        d.getInteractionSnapshot(),
      ]);

      const [sCap, sPaid, sRemaining, sTotalStaked, sAprBps] = stakeTuple;
      const [iCap, iPaid, iRemaining, iLaunch, iToday, iAprBps] = interTuple;

      let userStaked = 0n;
      let pending = 0n;
      let lastClaimedDay = 0n;
      let previewAmount = 0n;
      let previewFromDay = 0n;
      let previewToDay = 0n;
      let claimFromDay = 0n;
      let claimWindowToDay = 0n;
      let claimEffectiveToDay = 0n;
      let finalizedPrefix = false;
      let waitingForDay = 0n;
      if (address) {
        const [uStaked, uPending, uLast, prev, claimability] = await Promise.all([
          d.getUserStakedVPFI(address),
          d.previewStakingRewards(address),
          d.getInteractionLastClaimedDay(address),
          d.previewInteractionRewards(address),
          d.getInteractionClaimability(address),
        ]);
        userStaked = uStaked;
        pending = uPending;
        lastClaimedDay = uLast;
        [previewAmount, previewFromDay, previewToDay] = prev;
        [claimFromDay, claimWindowToDay, claimEffectiveToDay, finalizedPrefix, waitingForDay] =
          claimability;
      }

      setStaking({
        cap: sCap,
        paidOut: sPaid,
        remaining: sRemaining,
        totalStaked: sTotalStaked,
        aprBps: Number(sAprBps),
        userStaked,
        pending,
      });
      setInteraction({
        cap: iCap,
        paidOut: iPaid,
        remaining: iRemaining,
        launch: iLaunch,
        today: iToday,
        aprBps: Number(iAprBps),
        lastClaimedDay,
        previewAmount,
        previewFromDay,
        previewToDay,
        claimFromDay,
        claimWindowToDay,
        claimEffectiveToDay,
        finalizedPrefix,
        waitingForDay,
      });
      step.success({
        note: `staking pending=${pending}, interaction preview=${previewAmount}`,
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, address]);

  useEffect(() => {
    load();
  }, [load]);

  return { staking, interaction, loading, error, reload: load };
}

export function formatVpfi(v: bigint | null | undefined): number {
  if (v == null) return 0;
  return Number(v) / 1e18;
}

export function formatVpfiCompact(v: bigint | null | undefined): string {
  const n = formatVpfi(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return n.toFixed(4);
}

export const SECONDS_PER_YEAR = 31_557_600n;
export const BPS = 10_000n;

/**
 * Naive pending-rewards extrapolation for display: `userStaked * aprBps *
 * elapsedSeconds / (BPS * SECONDS_PER_YEAR)`. Lets the UI animate the pending
 * counter between on-chain reads without calling the RPC.
 */
export function projectStakingAccrual(
  userStaked: bigint,
  aprBps: number,
  elapsedSeconds: bigint,
): bigint {
  if (userStaked === 0n || aprBps === 0) return 0n;
  return (
    (userStaked * BigInt(aprBps) * elapsedSeconds) / (BPS * SECONDS_PER_YEAR)
  );
}

/** Used for the scale-18 -> bigint conversion on deposit/withdraw tx inputs. */
export function parseVpfiInput(s: string): bigint {
  if (!s || s === '.') return 0n;
  const [whole, frac = ''] = s.split('.');
  const wholePart = BigInt(whole || '0');
  const fracPadded = (frac + '000000000000000000').slice(0, 18);
  return wholePart * SCALE_18 + BigInt(fracPadded);
}
