/**
 * RL-3 claim horizon (#1956) — the Claim Center countdown, the second of the
 * two ratified user safeguards (the first is the free pre-expiry notice in
 * the in-app notification center).
 *
 * Once governance sets the claim horizon, an interaction reward that stays
 * claimable for the full horizon plus the notice period returns to the
 * rewards programme. The contract exposes, per reward entry, a forward
 * estimate of the EARLIEST removal (`getRewardEntryExpiry`), deliberately
 * optimistic: it assumes the reward stays claimable from now on, so the real
 * removal can only come later (an outage or a sanctions bar pauses the clock;
 * a forfeited entry reads zero and shows no countdown). The card shows the
 * soonest such date, so it only ever urges the owner to claim sooner.
 *
 * Dark until the horizon knob is set: while `getRewardClaimHorizonDays()` is
 * zero no entry can expire and nothing renders.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { signalAware } from '../chain/railHealth';

/** The notice period the contract adds after the horizon, in days. A FIXED
 *  protocol constant with no getter (`LibVaipakam.REWARD_CLAIM_HORIZON_NOTICE_DAYS`);
 *  mirrored here only to decide when the card switches to its final-notice
 *  wording. */
export const REWARD_CLAIM_NOTICE_DAYS = 90;

/** Entries read per multicall. EVERY entry is read: the card may never show a
 *  date later than the contract would enforce, and a capped or partial read
 *  could miss the soonest entry and do exactly that. */
const ENTRY_CHUNK = 100;

export interface RewardExpirySoonest {
  entryId: bigint;
  /** Unix seconds — the contract's earliest-removal estimate. */
  expiresAt: number;
}

export interface RewardExpiryCountdown {
  /** The live horizon knob; 0 = dark (nothing renders). */
  horizonDays: number;
  /** The soonest estimated removal among the owner's entries, if any. */
  soonest: RewardExpirySoonest | null;
}

/** The soonest NON-ZERO estimate (zero = no countdown: dark, unstarted or
 *  forfeited). Pure, for the unit test. */
export function soonestRewardExpiry(
  entries: readonly { id: bigint; expiresAt: number }[],
): RewardExpirySoonest | null {
  let best: RewardExpirySoonest | null = null;
  for (const e of entries) {
    if (e.expiresAt <= 0) continue;
    if (best === null || e.expiresAt < best.expiresAt) best = { entryId: e.id, expiresAt: e.expiresAt };
  }
  return best;
}

/** Inside the final notice period: the estimate is no more than the notice
 *  period away. Pure, for the unit test. */
export function inFinalNotice(expiresAt: number, nowSec: number): boolean {
  return expiresAt > 0 && expiresAt - nowSec <= REWARD_CLAIM_NOTICE_DAYS * 86_400;
}

export function useRewardExpiryCountdown() {
  const { readChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['rewardExpiry', readChain.chainId, address?.toLowerCase()],
    enabled: Boolean(address) && Boolean(publicClient),
    // The estimate moves in days, not seconds; the reward card's own read
    // refreshes on receipts, focus and the push rail.
    refetchInterval: signalAware(300_000),
    queryFn: async (): Promise<RewardExpiryCountdown> => {
      const client = publicClient!;
      const diamond = readChain.diamondAddress;
      try {
        const horizonDays = Number(
          await client.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getRewardClaimHorizonDays',
          }),
        );
        if (horizonDays === 0) return { horizonDays: 0, soonest: null };
        const ids = (await client.readContract({
          address: diamond,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getUserRewardEntryIds',
          args: [address!],
        })) as readonly bigint[];
        const entries: { id: bigint; expiresAt: number }[] = [];
        for (let i = 0; i < ids.length; i += ENTRY_CHUNK) {
          const chunk = ids.slice(i, i + ENTRY_CHUNK);
          // eslint-disable-next-line no-await-in-loop
          const res = (await client.multicall({
            allowFailure: true,
            contracts: chunk.map((id) => ({
              address: diamond,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getRewardEntryExpiry',
              args: [id],
            })) as never,
          })) as readonly { status: 'success' | 'failure'; result?: unknown }[];
          res.forEach((r, j) => {
            // An unread entry FAILS the read rather than being skipped: the
            // missing one could be the soonest, and showing the next-soonest
            // would report a date LATER than the contract would enforce. The
            // card keeps its last good answer (or shows none) until a full
            // read succeeds.
            if (r.status !== 'success') {
              throw new Error(`reward expiry read failed for entry ${chunk[j]}`);
            }
            const [, expiresAt] = r.result as readonly [bigint, bigint];
            entries.push({ id: chunk[j], expiresAt: Number(expiresAt) });
          });
        }
        return { horizonDays, soonest: soonestRewardExpiry(entries) };
      } catch (err) {
        // A revert / zero data means the horizon views are absent on this
        // chain: the quiet dark state, exactly as the rewards card treats an
        // absent rewards facet. A transport failure rethrows.
        const isRevert =
          err instanceof BaseError &&
          (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        if (isRevert) return { horizonDays: 0, soonest: null };
        throw err;
      }
    },
  });
}
