/**
 * RW-43, RW-44 — whether the interaction reward programme runs on this
 * network, read from the Diamond at one block, and the one sentence the
 * Rewards page leads with.
 *
 * Every fact is read on its own and kept as unread (null) when it does not
 * answer, so an unreadable fact is never shown as zero or off. The headline
 * calls the programme live only when the launch has passed, the network
 * holds a reward role that pays here, and VPFI is held to pay rewards now;
 * any of those unread makes the headline unknown. On a mirror, VPFI sent for
 * a particular day has no programme-wide figure, so empty standing funds
 * there never read as nothing to pay. Rewards are usage rebates
 * paid from fees already received, never yield (RL-6).
 */
import type { Abi, Hex, PublicClient } from 'viem';
import {
  ConfigFacetABI,
  InteractionRewardsLensFacetABI,
  RewardCustodyFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
  VPFITokenFacetABI,
} from '@vaipakam/contracts/abis';
import { answerOrNull } from '../reads/answer';

const LENS = InteractionRewardsLensFacetABI as Abi;
const REPORTER = RewardReporterFacetABI as Abi;
const CUSTODY = RewardCustodyFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;
const VPFI_TOKEN = VPFITokenFacetABI as Abi;
const REMITTANCE_LENS = RewardRemittanceLensFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The views each fact reads, by signature, so a missing route is stated. */
export const PROGRAMME_SIGNATURES = {
  launch: ['getInteractionLaunchTimestamp()'],
  role: ['getRewardRole()'],
  retirement: ['getRewardChainRetirement()'],
  reporter: ['getRewardReporterConfig()'],
  custody: ['rewardCustodyActivated()'],
  horizon: ['getRewardClaimHorizonDays()'],
  funding: ['getVPFIToken()', 'getRewardReservations()', 'getDeliveredFreshBound()'],
} as const;

export type ProgrammeFact = keyof typeof PROGRAMME_SIGNATURES;

/** The resolved reward role (`LibVaipakam.RewardRole`). */
export type RewardRole = 'canonical' | 'mirror' | 'unconfigured' | 'detached';

const ROLES: readonly RewardRole[] = ['canonical', 'mirror', 'unconfigured', 'detached'];

export function roleOf(raw: number): RewardRole | null {
  return ROLES[raw] ?? null;
}

export interface Retirement {
  retired: boolean;
  /** The home network a detached mirror left; 0 when none is recorded. */
  returnChainId: number;
  returnDeployment: Hex;
  /** VPFI sent back to the home network so far. */
  returned: bigint;
}

export interface ProgrammeRead {
  /** Unix seconds at which day 0 begins; 0 while not set. */
  launch: bigint | null;
  role: RewardRole | null;
  retirement: Retirement | null;
  /** The home network's chain id this network reports to (0 when none). */
  baseChainId: number | null;
  custodyActivated: boolean | null;
  /** The claim horizon in days; 0 when off. */
  horizonDays: number | null;
  /** This network's VPFI token at the read block; null when none is set or
   *  it could not be read. Every amount here is in this token. */
  token: Hex | null;
  /** The standing VPFI a reward settlement may draw now, net of what is
   *  reserved. On a mirror this leaves out VPFI sent with a particular day's
   *  rewards (transport epochs), which is held per day and read only by the
   *  claim itself.
   *  `fresh` is what a claim can pay from VPFI delivered for rewards: the
   *  lowest of every programme-wide limit a claim checks before it pays
   *  fresh VPFI, so VPFI held beyond any of them is not counted as payable:
   *  the fresh VPFI held (`held`), the delivered allowance the claim charges
   *  (`getDeliveredFreshBound`) and the pool's available headroom
   *  (`getRewardReservations`' `poolAvailable`). `recycled` is the
   *  recycled bucket's room. Zero, with `noToken`, on a network with no VPFI
   *  token set, where nothing can be held. */
  funding: { fresh: bigint; held: bigint; recycled: bigint; noToken: boolean } | null;
  blockNumber: bigint;
  /** The read block's timestamp: the start is judged against the chain's
   *  clock, never the reader's. */
  chainTime: number;
}

type RawRetirement = readonly [boolean, number, Hex, bigint];
type RawReporter = readonly [Hex, number, number, boolean, bigint];
type RawReservations = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

export async function readProgramme(c: PublicClient, diamond: Hex): Promise<ProgrammeRead> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const blockNumber = block.number;
  const read = <T>(abi: Abi, functionName: string) => answerOrNull(c.readContract({ address: diamond, abi, functionName, blockNumber }) as Promise<T>);
  const [launch, role, retirement, reporter, custody, horizon, token] = await Promise.all([
    read<bigint>(LENS, 'getInteractionLaunchTimestamp'),
    read<number>(REPORTER, 'getRewardRole'),
    read<RawRetirement>(REPORTER, 'getRewardChainRetirement'),
    read<RawReporter>(REPORTER, 'getRewardReporterConfig'),
    read<boolean>(CUSTODY, 'rewardCustodyActivated'),
    read<number>(CONFIG, 'getRewardClaimHorizonDays'),
    read<Hex>(VPFI_TOKEN, 'getVPFIToken'),
  ]);
  // The reservations view refuses on a network with no VPFI token
  // (`RecycleBackingTokenUnset`); there nothing can be held to pay.
  const noToken = token !== null && token.toLowerCase() === ZERO;
  const [reservations, bound] =
    token === null || noToken
      ? [null, null]
      : await Promise.all([read<RawReservations>(LENS, 'getRewardReservations'), read<readonly [bigint, bigint]>(REMITTANCE_LENS, 'getDeliveredFreshBound')]);
  return {
    launch,
    role: role === null ? null : roleOf(Number(role)),
    retirement:
      retirement === null ? null : { retired: retirement[0], returnChainId: Number(retirement[1]), returnDeployment: retirement[2], returned: retirement[3] },
    baseChainId: reporter === null ? null : Number(reporter[2]),
    token: token === null || noToken ? null : token,
    custodyActivated: custody,
    horizonDays: horizon === null ? null : Number(horizon),
    // liveFreshAvailable (capped by the delivered allowance and the pool's
    // available headroom) and bucketAvailable: what the claim gates draw.
    funding: noToken
      ? { fresh: 0n, held: 0n, recycled: 0n, noToken: true }
      : reservations === null || bound === null
        ? null
        : {
            fresh: [reservations[4], bound[1], reservations[1]].reduce((a, b) => (b < a ? b : a)),
            held: reservations[4],
            recycled: reservations[7],
            noToken: false,
          },
    blockNumber,
    chainTime: Number(block.timestamp),
  };
}

/** The sentence the Rewards page leads with, in order of what decides it. */
export type ProgrammeHeadline =
  | { kind: 'unknown' }
  /** A detached network: nothing new becomes claimable here. */
  | { kind: 'left' }
  | { kind: 'not-started' }
  | { kind: 'starts'; at: number }
  /** Launched on a home network (or one with no role set), and nothing is
   *  held to pay rewards right now: there the standing funds are the whole
   *  picture. */
  | { kind: 'unfunded' }
  /** Launched on a mirror with no standing VPFI to pay from. A mirror's
   *  claim can also be paid from VPFI its home network sent with a
   *  particular day's rewards (transport epochs). That is held per day and
   *  has no programme-wide figure, so the page never concludes that nothing
   *  can pay: the wallet's own claim figure shows what a claim pays now. */
  | { kind: 'per-day' }
  | { kind: 'live' };

export function programmeHeadline(r: ProgrammeRead): ProgrammeHeadline {
  if (r.role === null) return { kind: 'unknown' };
  if (r.role === 'detached') return { kind: 'left' };
  if (r.launch === null) return { kind: 'unknown' };
  if (r.launch === 0n) return { kind: 'not-started' };
  if (r.launch > BigInt(r.chainTime)) return { kind: 'starts', at: Number(r.launch) };
  if (r.funding === null) return { kind: 'unknown' };
  if (r.funding.fresh + r.funding.recycled === 0n) return r.role === 'mirror' ? { kind: 'per-day' } : { kind: 'unfunded' };
  return { kind: 'live' };
}
