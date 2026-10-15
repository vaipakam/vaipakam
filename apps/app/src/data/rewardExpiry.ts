/**
 * RL-3 claim horizon (#1956) — the Claim Center countdown, the second of the
 * two ratified user safeguards (the first is the free pre-expiry notice in
 * the in-app notification center).
 *
 * Once governance sets the claim horizon, an interaction reward that stays
 * claimable for the full horizon plus the notice period returns to the
 * rewards programme. The contract exposes, per reward entry, a forward
 * estimate of the EARLIEST removal (`getRewardEntryExpiry`), deliberately
 * optimistic: it assumes the reward stays claimable from now on, so time the
 * reward cannot be claimed (an outage, a sanctions bar) moves the real removal
 * LATER than the estimate; a forfeited entry reads zero and shows no countdown.
 * The one thing that can move it EARLIER is governance shortening the claim
 * horizon — the estimate follows the new horizon at once, and the copy says
 * so (Codex #2489 r8). The card shows the soonest such date, which the
 * contract computes over bounded pages of the wallet's LIVE entries
 * (`getUserSoonestRewardExpiry`, Codex #2489 r16) starting past its settled
 * history, so the read costs a number of calls that follows the wallet's live
 * rewards, not its lifetime.
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

/** Index positions one page of `getUserSoonestRewardExpiry` scans at most
 *  (Codex #2489 r16). A position costs the contract a few storage reads; the
 *  page starts at the wallet's live-from cursor (every position below it is
 *  settled or expiring — the wallet's own claims advance it, and anyone may),
 *  so the lifetime history the index keeps is not re-walked on every refresh. */
const SCAN_POSITIONS = 1_000n;

/** Live entries one page prices at most. Pricing an entry's estimate is the
 *  costly part (it mirrors the sweep's executability test), so the pages are
 *  bounded by live entries too — the contract ends a page BEFORE an entry it
 *  will not price and always prices at least one, so a walk over pages sees
 *  every live entry exactly once. */
const PRICE_LIVE = 100n;

/** One page of the contract's soonest-deadline view:
 *  `[soonestId, soonestExpiresAt, nextOffset, total]`. */
export type SoonestExpiryPage = readonly [bigint, bigint, bigint, bigint];

/** The soonest estimate across ALL of `user`'s live entries, as of ONE block,
 *  by walking the contract's paged view from its returned `nextOffset` until
 *  it reaches `total`. EVERY live entry is priced: the card may never show a
 *  date later than the contract would enforce, and a capped or partial read
 *  could miss the soonest entry and do exactly that. Pinned to a block
 *  because the index swap-removes a repointed entry (the tail moves into its
 *  slot), so a repoint between two unpinned pages could move an unread entry
 *  across the boundary. A page that makes no progress short of the total is
 *  an error, never a silent early end. */
export async function readSoonestRewardExpiry(
  read: (offset: bigint, limit: bigint, maxLive: bigint) => Promise<SoonestExpiryPage>,
  positions = SCAN_POSITIONS,
  maxLive = PRICE_LIVE,
): Promise<RewardExpirySoonest | null> {
  const pages: { id: bigint; expiresAt: number }[] = [];
  let offset = 0n;
  for (;;) {
    const [id, expiresAt, nextOffset, total] = await read(offset, positions, maxLive);
    pages.push({ id, expiresAt: Number(expiresAt) });
    if (nextOffset >= total) return soonestRewardExpiry(pages);
    if (nextOffset <= offset) {
      throw new Error(`reward expiry scan made no progress at position ${offset} of ${total}`);
    }
    offset = nextOffset;
  }
}

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
      // ONLY the horizon read may answer "dark" (Codex #2489 r8): a revert /
      // zero data there means the horizon views are absent on this chain —
      // the quiet dark state, exactly as the rewards card treats an absent
      // rewards facet. Once a non-zero horizon has been read, rewards on this
      // chain CAN be reaped, so every later failure — the paged index missing
      // on a lens not yet refreshed, a reverting page, a failed expiry read —
      // is an ERROR the card shows, never a date hidden as if governance had
      // switched expiry off. A transport failure on the horizon read rethrows.
      let horizonDays: number;
      try {
        horizonDays = Number(
          await client.readContract({
            address: diamond,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getRewardClaimHorizonDays',
          }),
        );
      } catch (err) {
        if (isAbsentViewError(err)) return { horizonDays: 0, soonest: null };
        throw err;
      }
      if (horizonDays === 0) return { horizonDays: 0, soonest: null };
      {
        // One block for the whole walk — see readSoonestRewardExpiry. A page
        // that fails FAILS the read rather than being skipped: the missing
        // page could hold the soonest entry, and showing the next-soonest
        // would report a date LATER than the contract would enforce. The card
        // keeps its last good answer (or shows none) until a full read
        // succeeds.
        const blockNumber = await client.getBlockNumber();
        const soonest = await readSoonestRewardExpiry(
          async (offset, limit, maxLive) =>
            (await client.readContract({
              address: diamond,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getUserSoonestRewardExpiry',
              args: [address!, offset, limit, maxLive],
              blockNumber,
            })) as SoonestExpiryPage,
        );
        return { horizonDays, soonest };
      }
    },
  });
}

/** A revert or zero data from a view: the selector is not routed on this
 *  Diamond (or the view reverted), as opposed to a transport failure. */
export function isAbsentViewError(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    (err.walk((e) => e instanceof ContractFunctionRevertedError) !== null ||
      err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null)
  );
}
