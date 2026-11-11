/**
 * RW-43, RW-44 — whether the interaction reward programme runs on this
 * network, read from the Diamond at one block, and the one sentence the
 * Rewards page leads with.
 *
 * Every fact is read on its own and kept as unread (null) when it does not
 * answer, so an unreadable fact is never shown as zero or off. The headline
 * calls the programme live only when the launch has passed, the network
 * holds a reward role that pays here, and VPFI is held to pay rewards now;
 * any of those unread makes the headline unknown. Rewards are usage rebates
 * paid from fees already received, never yield (RL-6).
 */
import type { Abi, Hex, PublicClient } from 'viem';
import { ConfigFacetABI, InteractionRewardsLensFacetABI, RewardCustodyFacetABI, RewardReporterFacetABI, VPFITokenFacetABI } from '@vaipakam/contracts/abis';
import { answerOrNull } from '../reads/answer';

const LENS = InteractionRewardsLensFacetABI as Abi;
const REPORTER = RewardReporterFacetABI as Abi;
const CUSTODY = RewardCustodyFacetABI as Abi;
const CONFIG = ConfigFacetABI as Abi;
const VPFI_TOKEN = VPFITokenFacetABI as Abi;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The views this card reads, by signature, so a missing route is stated. */
export const PROGRAMME_SIGNATURES = {
  launch: 'getInteractionLaunchTimestamp()',
  role: 'getRewardRole()',
  retirement: 'getRewardChainRetirement()',
  reporter: 'getRewardReporterConfig()',
  custody: 'rewardCustodyActivated()',
  horizon: 'getRewardClaimHorizonDays()',
  funding: 'getRewardReservations()',
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
  /** VPFI a reward settlement may draw now, net of what is reserved:
   *  delivered (fresh) and recycled from fees. Zero, with `noToken`, on a
   *  network with no VPFI token set, where nothing can be held. */
  funding: { fresh: bigint; recycled: bigint; noToken: boolean } | null;
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
  const reservations = token === null || noToken ? null : await read<RawReservations>(LENS, 'getRewardReservations');
  return {
    launch,
    role: role === null ? null : roleOf(Number(role)),
    retirement:
      retirement === null ? null : { retired: retirement[0], returnChainId: Number(retirement[1]), returnDeployment: retirement[2], returned: retirement[3] },
    baseChainId: reporter === null ? null : Number(reporter[2]),
    custodyActivated: custody,
    horizonDays: horizon === null ? null : Number(horizon),
    // liveFreshAvailable and bucketAvailable: what the claim gates draw.
    funding: noToken
      ? { fresh: 0n, recycled: 0n, noToken: true }
      : reservations === null
        ? null
        : { fresh: reservations[4], recycled: reservations[7], noToken: false },
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
  /** Launched, but nothing is held to pay rewards right now. */
  | { kind: 'unfunded'; mirror: boolean }
  | { kind: 'live' };

export function programmeHeadline(r: ProgrammeRead): ProgrammeHeadline {
  if (r.role === null) return { kind: 'unknown' };
  if (r.role === 'detached') return { kind: 'left' };
  if (r.launch === null) return { kind: 'unknown' };
  if (r.launch === 0n) return { kind: 'not-started' };
  if (r.launch > BigInt(r.chainTime)) return { kind: 'starts', at: Number(r.launch) };
  if (r.funding === null) return { kind: 'unknown' };
  if (r.funding.fresh + r.funding.recycled === 0n) return { kind: 'unfunded', mirror: r.role === 'mirror' };
  return { kind: 'live' };
}
