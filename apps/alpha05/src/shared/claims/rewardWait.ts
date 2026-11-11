/**
 * RW-28 — why a reward claim waits on a day, read at the claim preview's own
 * block so the reason and the refusal describe one chain state.
 *
 * The claim preview names the day and which gate holds it: the day's global
 * figures (the known-global FLAG the claim checks, never a zero total), or
 * the funding a mirror waits to receive for it. This read says what that
 * gate is waiting on now. On a home network a day waits to be finalised, and
 * the finalisation's own readiness answer says why it cannot run yet. On a
 * mirror it waits for the home network's figures to arrive, or for the day's
 * funding: not yet priced for this network, waiting on this network's own
 * report, or arriving in parts (how much of the declared whole has landed).
 * A day whose parts stated different totals can be closed unpaid after a
 * waiting period, and that is disclosed. Every fact is read on its own and
 * kept as unread (null) when it does not answer, so an unread fact is stated,
 * never guessed. No step of the wallet's own clears any of these; anyone may
 * run the step that does. Reads only.
 */
import type { Abi, PublicClient } from 'viem';
import { RewardAggregatorFacetABI, RewardRemittanceLensFacetABI, RewardReporterFacetABI } from '@vaipakam/contracts/abis';
import type { CopyKey } from '../copy/useCopy';
import { answerOrNull } from '../reads/answer';
import { roleOf, type RewardRole } from '../rewards/programme';

type Hex = `0x${string}`;

const AGGREGATOR = RewardAggregatorFacetABI as Abi;
const REPORTER = RewardReporterFacetABI as Abi;
const REMITTANCE_LENS = RewardRemittanceLensFacetABI as Abi;

/** `LibRewardDayReport`'s readiness reasons for finalising a day. */
export const READINESS = { ready: 0, finalized: 1, noReport: 2, waiting: 3, listUnusable: 4 } as const;

/** One day's delivery record on a mirror (`getDayDeliveryParts`). */
export interface DeliveryParts {
  /** The whole Base declared for the day, fresh plus recycled. */
  whole: bigint;
  /** What has landed toward it so far, fresh plus recycled. */
  landed: bigint;
  /** How many parts have landed. */
  parts: number;
  /** A part declared a different whole. */
  conflict: boolean;
}

export type WaitDetail =
  /** A home network (or one with no role set): whether the day may be
   *  finalised now, and if not, why (`READINESS`); null when unread. */
  | { kind: 'finalize'; reason: number | null }
  /** A mirror waiting for the home network's figures for the day. */
  | { kind: 'broadcast'; applied: boolean | null }
  /** A mirror waiting for the day's funding: whether the home network has
   *  priced the day for this network, whether this network's report for it
   *  has been sent, and the parts that have landed (each null when unread). */
  | { kind: 'delivery'; stamped: boolean | null; reportSent: boolean | null; parts: DeliveryParts | null }
  /** The network's reward role could not be read, so which gate applies is
   *  not known. */
  | { kind: 'unknown' };

type RawState = readonly [boolean, boolean, boolean, boolean, Hex, bigint, boolean, boolean, boolean, boolean];
interface RawParts {
  wholeFresh: bigint;
  wholeRecycled: bigint;
  landedFresh: bigint;
  landedRecycled: bigint;
  parts: number;
  wholeConflict: boolean;
}

/** Why `day` holds the claim, read at `blockNumber`. */
export async function readWaitDetail(c: PublicClient, diamond: Hex, day: bigint, why: 'global' | 'delivery', blockNumber: bigint): Promise<WaitDetail> {
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi, functionName, args, blockNumber }) as Promise<T>);
  if (why === 'delivery') {
    const [state, parts] = await Promise.all([
      read<RawState>(REMITTANCE_LENS, 'getDayDeliveryState', [day]),
      read<RawParts>(REMITTANCE_LENS, 'getDayDeliveryParts', [day]),
    ]);
    return {
      kind: 'delivery',
      stamped: state === null ? null : state[1],
      reportSent: state === null ? null : state[7],
      parts:
        parts === null
          ? null
          : {
              whole: parts.wholeFresh + parts.wholeRecycled,
              landed: parts.landedFresh + parts.landedRecycled,
              parts: Number(parts.parts),
              conflict: parts.wholeConflict,
            },
    };
  }
  const raw = await read<number>(REPORTER, 'getRewardRole');
  const role: RewardRole | null = raw === null ? null : roleOf(Number(raw));
  if (role === null) return { kind: 'unknown' };
  if (role === 'mirror') return { kind: 'broadcast', applied: await read<boolean>(REPORTER, 'getBroadcastV2Applied', [day]) };
  const ready = await read<readonly [boolean, number]>(AGGREGATOR, 'isDayReadyToFinalize', [day]);
  return { kind: 'finalize', reason: ready === null ? null : Number(ready[1]) };
}

/** One sentence of the reason: a copy key and its values (amounts as base
 *  units, formatted by the caller). */
export interface WaitLine {
  key: CopyKey;
  vars?: Record<string, string>;
  amounts?: Record<string, bigint>;
}

/** The reason's sentences, in order. Pure, so the rule is tested once.
 *  `null` for a fact means it could not be read, and is said so. */
export function waitLines(day: bigint, d: WaitDetail): WaitLine[] {
  const v = { day: day.toString() };
  const lines: WaitLine[] = [];
  switch (d.kind) {
    case 'unknown':
      lines.push({ key: 'rewardsWait.roleUnread', vars: v });
      break;
    case 'finalize': {
      const key: CopyKey =
        d.reason === null
          ? 'rewardsWait.finalizeUnread'
          : d.reason === READINESS.ready
            ? 'rewardsWait.finalizeReady'
            : d.reason === READINESS.noReport
              ? 'rewardsWait.finalizeNoReport'
              : d.reason === READINESS.waiting
                ? 'rewardsWait.finalizeReports'
                : d.reason === READINESS.finalized
                  ? 'rewardsWait.finalizeDone'
                  : d.reason === READINESS.listUnusable
                    ? 'rewardsWait.finalizeList'
                    : 'rewardsWait.finalizeOther';
      lines.push({ key, vars: d.reason === null ? v : { ...v, reason: String(d.reason) } });
      break;
    }
    case 'broadcast':
      lines.push({ key: d.applied === null ? 'rewardsWait.broadcastUnread' : d.applied ? 'rewardsWait.broadcastApplied' : 'rewardsWait.broadcast', vars: v });
      break;
    case 'delivery': {
      if (d.stamped === null) lines.push({ key: 'rewardsWait.pricedUnread', vars: v });
      else if (!d.stamped) lines.push({ key: 'rewardsWait.priced', vars: v });
      else if (d.reportSent === false && (d.parts === null || d.parts.parts === 0)) lines.push({ key: 'rewardsWait.report', vars: v });
      if (d.stamped) {
        if (d.parts === null) lines.push({ key: 'rewardsWait.partsUnread', vars: v });
        else if (d.parts.parts === 0) lines.push({ key: 'rewardsWait.noParts', vars: v });
        else lines.push({ key: 'rewardsWait.parts', vars: { ...v, parts: String(d.parts.parts) }, amounts: { landed: d.parts.landed, whole: d.parts.whole } });
      }
      if (d.parts?.conflict) lines.push({ key: 'rewardsWait.conflict', vars: v });
      break;
    }
  }
  lines.push({ key: 'rewardsWait.behind' });
  return lines;
}
