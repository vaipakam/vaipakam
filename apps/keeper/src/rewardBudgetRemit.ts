// apps/keeper/src/rewardBudgetRemit.ts
//
// #925 — reward-budget remittance automation.
//
// The #776 bridge lets Base fund each mirror's interaction-reward VPFI on
// demand (`RewardRemittanceFacet.remitRewardBudget`, which is `onlyCanonical`
// — it runs ON Base and sends TO a mirror `dstChainId`). Without this pass an
// operator must hand-remit; this drives it on the cron tick so mirrors stay
// funded ahead of their claim frontier (remit-before-broadcast, IncidentRunbook
// §2b).
//
// Discovery is cursor-free by design: `quoteRewardBudget` returns 0 for any
// non-finalized / already-remitted / no-slice day, so re-scanning a bounded
// recent window each tick is harmless and needs no persisted state. Sends are
// idempotent on-chain (already-sent days are skipped), so a retry is always
// safe.
//
// Gated twice: the global `KEEPER_ENABLED` AND an explicit `REWARD_REMIT_ENABLED`
// so the path stays dark until the operator has also authorized the keeper EOA
// on-chain (`setRewardRemittanceKeeper`, or ADMIN).

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
  RewardAggregatorFacetABI,
  InteractionRewardsLensFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env, PlainVarKey } from './env';
import type { PassTick } from './passSchedule';
import { MULTICALL3_ADDRESS } from './multicall3';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import { reportSendError } from './submissionQueue';
import { readCutoffMs, runIndex } from './runWindow';
import { rotate } from './rotate';
import { isUnroutedRead, owedButBlocked, readRemitDayStatuses } from './remitDayStatus';
import { redactedError } from '@vaipakam/lib/errorDescription';

const REMIT_ABI = RewardRemittanceFacetABI as Abi;
/** `getDayClosedByRemitId` lives on the read-only lens facet. */
const REMIT_LENS_ABI = RewardRemittanceLensFacetABI as Abi;

const REPORTER_ABI = RewardReporterFacetABI as Abi;
const AGGREGATOR_ABI = RewardAggregatorFacetABI as Abi;
// `getInteractionCurrentDay` moved to the read-only lens facet (#1333).
const INTERACTION_ABI = InteractionRewardsLensFacetABI as Abi;

/** How many recent days to re-scan for un-remitted budget each tick. */
const DEFAULT_LOOKBACK_DAYS = 45;
/**
 * The operator's per-send VPFI ceiling (`REWARD_REMIT_LANE_CAP`). Defaults to
 * the SAME 50k VPFI as `ConfigureCcip.s.sol`'s `CCIP_RATE_CAPACITY` default.
 *
 * #918 (owner decision 2026-10-27, "send in parts"): this is no longer a
 * filter that skips a day whose slice is larger. A day is sent in PARTS no
 * larger than the part cap the pass resolves each tick ({@link resolvePartCap}:
 * the smaller of this ceiling and the lane bucket's live tokens), and the
 * mirror opens the day only once every part has landed. An early high-APR day
 * above the lane capacity therefore drains over several ticks instead of
 * waiting for an operator to raise the lane.
 */
const DEFAULT_LANE_CAP = 50_000n * 10n ** 18n;
/**
 * #2960 — the smallest part worth a send (`REWARD_REMIT_MIN_PART`, wei).
 *
 * Every part costs a CCIP fee, a reservation and a mirror transport epoch, and
 * a day's claims move into staging once it has taken more than 64 parts. A
 * nearly empty lane bucket would otherwise be drained in dust parts that move
 * almost nothing. So a part that would leave its day still owing waits, below
 * this size, for the bucket to refill; a part that COMPLETES its day is never
 * held back by it, however small.
 *
 * The default is 1,000 VPFI: at the default lane refill (about 5.8 VPFI a
 * second) an emptied bucket holds that much again within one five-minute
 * tick. The floor never exceeds the largest part the lane could ever carry
 * ({@link resolvePartCap}'s `maxPart`), since waiting could not help there.
 */
const DEFAULT_MIN_PART = 1_000n * 10n ** 18n;
/**
 * Codex #1426 r1 — bounded backscan behind the normal lookback for ARMED
 * days: a day gated by a missing commitment report can outlive the 45-day
 * lookback and would otherwise never be re-quoted once its report finally
 * completes. Matches the commitment pass's backscan horizon.
 */
const ARMED_BACKSCAN_DAYS = 90;
/**
 * Codex #2232 r4 — the per-remittance DAY-COUNT bound, mirroring
 * `LibRewardCustody.TRANSPORT_DAY_FANOUT_CAP`: ONE funded day per send since
 * #2821.
 *
 * The send and its fee quote both refuse a batch funding more days than that.
 * This is a SECOND, independent ceiling beside `laneCap`: the lane cap bounds
 * the VPFI a batch moves, and says nothing about how many days it spans. Those
 * come apart after a keeper outage or a run of delayed commitment reports: many
 * days owed, each carrying a small slice, so the whole window fits the monetary
 * cap while naming many days. Before this bound the keeper built that batch
 * every tick, `quoteRemittanceFee` reverted before anything was sent, and the
 * next tick rebuilt the identical batch: a mirror unfunded indefinitely.
 *
 * Why one (#2821): a send funding several days lands on the mirror as one
 * transport epoch listing all of them, and its balance funds every listed day
 * at once, so a draw for one is contested by the others. A mirror day closes
 * only when every entry covering it has claimed past it, so an entry spanning
 * two listed days would need the epoch to pay the first day and the first day
 * paid to free the epoch: it could never be paid. The chain therefore funds one
 * day per send and the mirror withholds any wider epoch for good. A backlog
 * drains one day per tick per mirror, at one CCIP fee per day, which is also
 * the steady-state cost.
 *
 * Days beyond the bound are DEFERRED, not dropped — they are counted into the
 * same `deferred` total a part that leaves its day owing feeds, so the coverage
 * signal reports the mirror as not settled and the next tick takes the next one.
 *
 * It bounds FUNDED days only (Codex #2232 r5). The send and its quote trim the
 * payload to the days that actually carry VPFI and apply the bound to that
 * count, so a close-only day never reaches the destination list and rides
 * along free of this cap exactly as it is free of the part cap.
 *
 * `rewardBudgetRemitFanoutCap.test.ts` pins BOTH halves against the contract
 * source: the figure against `TRANSPORT_DAY_FANOUT_CAP`, and the population
 * against the argument every `requireRemittableFanout` call site passes. The
 * figure alone would not have caught this — the first revision had the right
 * number and the wrong subject.
 */
const TRANSPORT_DAY_FANOUT_CAP = 1;

/**
 * #2821 — how many FUNDED days one send carries: the chain's own bound
 * ({@link TRANSPORT_DAY_FANOUT_CAP}), so the pass never builds a batch the
 * send would refuse.
 */
export const REMIT_FUNDED_DAYS_PER_SEND = TRANSPORT_DAY_FANOUT_CAP;

/**
 * The batch a tick sends, and what it leaves behind.
 *
 * EXPORTED AND PURE (Codex #2232 r4). It was an inline loop inside the pass,
 * which meant the only way to test the rule was to restate it in the test —
 * and a restated rule is the drift this programme keeps paying for. The pass
 * calls this; the suite calls this; there is one rule.
 *
 * @param window     The planned day ids, in the order they are offered.
 * @param perDay     Each day's PART under `partCap`, positionally — what
 *                   `quoteRemitDayPlans(…, partCap)` returns, never more than
 *                   the cap.
 * @param actionable Whether the send would act on the day (a zero-amount
 *                   actionable day is close-only).
 * @param partCap    The part cap the plan was quoted under.
 * @param partial    #918 — whether the day's part leaves it still owing
 *                   (`Partial`), positionally. A partial day is sent and ALSO
 *                   counted as deferred: the send moved a part, not the day.
 * @param maxFundedDays Funded days one send may carry; defaults to
 *                   {@link REMIT_FUNDED_DAYS_PER_SEND} (#2821), and never
 *                   exceeds {@link TRANSPORT_DAY_FANOUT_CAP}.
 * @param minPart    #2960 — the smallest part that may leave its day still
 *                   owing ({@link DEFAULT_MIN_PART}). A smaller partial part
 *                   waits, and is counted as deferred; a completing part is
 *                   exempt.
 */
export function planRemitBatch(
  window: readonly bigint[],
  perDay: readonly bigint[],
  actionable: readonly boolean[],
  partCap: bigint,
  partial: readonly boolean[] = [],
  maxFundedDays: number = REMIT_FUNDED_DAYS_PER_SEND,
  minPart: bigint = 0n,
): { batch: bigint[]; total: bigint; deferred: number } {
  // The destination's fan-out cap is the ceiling whatever the caller asks for.
  const fundedBound = Math.min(Math.max(1, Math.floor(maxFundedDays)), TRANSPORT_DAY_FANOUT_CAP);
  // Greedily batch the un-remitted days, keeping the total under the part
  // cap. Close-only days (actionable, zero amount) ride along for free.
  const batch: bigint[] = [];
  let total = 0n;
  // Days that are ACTIONABLE but did not make this tick's batch. This is the
  // discriminator the coverage signal turns on, and getting it wrong has now
  // gone both ways: r19 treated an empty batch as always-unsettled, which made
  // the steady state (every day already remitted, so every entry comes back
  // amount=0 / actionable=false) report 0/A forever and put the stand-down
  // permanently out of reach. An empty batch is settled ONLY when nothing was
  // left behind (Codex #1924 r20).
  let deferred = 0;
  // FUNDED days in the batch, which is the population the destination bound
  // counts — NOT `batch.length` (Codex #2232 r5). The send and its quote both
  // trim the payload to the funded days and call `requireRemittableFanout` on
  // that count, so a close-only day never reaches the destination list and
  // never occupies a place in it.
  //
  // Counting the whole batch was wrong twice over. It refused batches the
  // chain would have accepted; and because the cap was checked before the
  // close-only branch, a plan with more than 32 actionable zero-slice days
  // filled the cap with free riders and then left every later day behind —
  // dropping close-only ones silently, since the deferral count only ever
  // counts positive slices. `remitToMirror` would then have reported the
  // mirror settled with days still open and their commitments unretired,
  // which is the stand-down signal reading a truncation as completeness.
  //
  // The error was inferring the cap's subject from the list this function
  // builds instead of reading which population the contract counts. The test
  // pins that subject now, not only the figure.
  let fundedInBatch = 0;
  for (let i = 0; i < window.length; i++) {
    const slice = perDay[i] ?? 0n;
    if (slice === 0n) {
      // Zero-amount and not actionable = nothing to do for this day. Already
      // remitted, or otherwise not eligible; NOT a deferral. Closeable ones
      // ride along free of BOTH caps: they move no VPFI and reach no
      // destination list.
      if (actionable[i]) batch.push(window[i]);
      continue;
    }
    if (slice > partCap) {
      // Not reachable from a plan quoted under `partCap` (the chain sizes
      // every part to it). Kept so a plan read under a different cap than
      // the one passed here can never put an over-cap part in the batch; the
      // day stays owed and is counted.
      deferred += 1;
      continue;
    }
    if (fundedInBatch >= fundedBound || total + slice > partCap || (partial[i] && slice < minPart)) {
      // A cap is reached — the funded-days bound (one per send, #2821, never
      // above the destination's day fan-out), or the part cap — or the part
      // is below the minimum and would leave its day owing (#2960). Either
      // way this day and EVERY later actionable one wait for a later tick:
      // one funded day per send, and an earlier day goes first.
      // Counting only this one would under-report (r20).
      //
      // Reached only on a FUNDED day, so `deferred` is always at least one
      // here and the tick reports the mirror unsettled. That is what stops a
      // truncated plan from being read as a complete one.
      for (let k = i; k < window.length; k++) {
        const rest = perDay[k] ?? 0n;
        if (rest > 0n) deferred += 1;
      }
      break;
    }
    batch.push(window[i]);
    total += slice;
    fundedInBatch += 1;
    // #918 — a part that leaves its day owing is a send, not a settlement:
    // the rest of the day goes on a later tick, so the mirror is not settled.
    if (partial[i]) deferred += 1;
  }
  return { batch, total, deferred };
}

/** The Base-side outbound lane bucket toward one mirror, as
 *  `RewardRemittanceLensFacet.getRemitLaneBucket` reports it. */
export type RemitLaneBucket = {
  /** The lane resolved (registry, messenger, pool and lane all present). */
  readable: boolean;
  /** The lane's limiter is enabled. */
  limited: boolean;
  /** Tokens the bucket holds now, refilled to the read block. */
  tokens: bigint;
  capacity: bigint;
};

/**
 * #2960 — the MIRROR's end of the lane: its pool's inbound bucket from Base,
 * as `RewardRemittanceLensFacet.getRemitInboundLaneBucket` reports it there,
 * or why it could not be read.
 */
export type MirrorInbound =
  | { kind: 'read'; bucket: RemitLaneBucket }
  | { kind: 'unread'; reason: string };

/**
 * #918 / #2960 — the part cap for this tick, from both ends of the lane.
 *
 * - The operator's ceiling (`REWARD_REMIT_LANE_CAP`).
 * - BASE's outbound bucket, by its live TOKENS: the send draws it in the same
 *   transaction, so a part above them reverts on Base.
 * - The MIRROR's inbound bucket, by its CAPACITY. A part above the capacity
 *   can never execute there: CCIP rejects a single over-capacity request
 *   rather than queueing it (CcipCutoverRunbook, "Changing lane rate limits
 *   after deployment"), and it waits for a manual re-execution that a lowered
 *   lane would refuse too. The live tokens are NOT the bound, because the
 *   bucket is drawn at execution, later: parts already in flight have not
 *   drawn it yet when this tick reads it, so the tokens read now do not
 *   describe the bucket the part meets, while the capacity bounds every
 *   bucket it could meet. A part at or below the capacity that finds the
 *   bucket short waits for the refill (inferred from the same runbook line,
 *   which calls only over-capacity requests rejected).
 *
 * Pure and exported so the rule is tested where it lives. An end that could
 * not be read sizes nothing and is NAMED in `note`, so the pass states what it
 * did not know instead of implying a part sized by both ends. A `partCap` of
 * zero means Base's bucket is empty: nothing is sent this tick.
 *
 * `maxPart` is the largest part the lane could carry with both buckets full:
 * the ceiling lowered to each limited end's capacity. The minimum part size
 * never exceeds it ({@link DEFAULT_MIN_PART}).
 */
export function resolvePartCap(
  laneCap: bigint,
  bucket: RemitLaneBucket | undefined,
  inbound?: MirrorInbound,
): { partCap: bigint; maxPart: bigint; note?: string } {
  const notes: string[] = [];
  let partCap = laneCap;
  let maxPart = laneCap;
  const lower = (cur: bigint, by: bigint) => (by < cur ? by : cur);
  if (bucket === undefined) {
    notes.push('Base lane bucket unreadable; parts not sized by Base\'s end');
  } else if (!bucket.readable) {
    notes.push(
      'lane not resolvable from Base (registry, messenger, pool or lane unset); parts not sized by Base\'s end',
    );
  } else if (bucket.limited) {
    partCap = lower(partCap, bucket.tokens);
    maxPart = lower(maxPart, bucket.capacity);
  }
  if (inbound === undefined) {
    notes.push('mirror inbound bucket not read; parts not sized by the mirror\'s end');
  } else if (inbound.kind === 'unread') {
    notes.push(`mirror inbound bucket unread (${inbound.reason}); parts not sized by the mirror's end`);
  } else if (!inbound.bucket.readable) {
    notes.push(
      'lane not resolvable on the mirror (registry, messenger, pool or lane unset); parts not sized by the mirror\'s end',
    );
  } else if (inbound.bucket.limited) {
    partCap = lower(partCap, inbound.bucket.capacity);
    maxPart = lower(maxPart, inbound.bucket.capacity);
  }
  return notes.length > 0 ? { partCap, maxPart, note: notes.join('; ') } : { partCap, maxPart };
}

function readNumber(env: Env, key: PlainVarKey, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Parse a wei amount, accepting BOTH a plain integer string and the scientific
 * `<mantissa>e<exp>` notation used in the README/wrangler docs (e.g. `50000e18`
 * — `BigInt()` alone throws on that). Non-positive / unparseable → fallback.
 */
function readBigint(env: Env, key: PlainVarKey, fallback: bigint): bigint {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  try {
    const m = raw.match(/^(\d+)e(\d+)$/i);
    const v = m ? BigInt(m[1]) * 10n ** BigInt(m[2]) : BigInt(raw);
    return v > 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function runRewardBudgetRemit(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'rewardBudgetRemit', 'REWARD_REMIT_ENABLED')) return;

  // Chains side by side, mirrors from a rotating start (#2572 r5, `runWindow.ts`).
  const run = runIndex(tick, 5 * 60_000);
  await Promise.all(
    getChainConfigs(env).map(async (chain) => {
      try {
        await remitFromCanonical(env, chain, tick.deadlineMs, run);
      } catch (err) {
        console.error(`[keeper] rewardBudgetRemit chain=${chain.id} failed:`, redactedError(err));
      }
    }),
  );
}

async function remitFromCanonical(env: Env, chain: ChainConfig, deadlineMs: number, run = 0): Promise<void> {
  const publicClient = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  // `remitRewardBudget` is Base-only; find the canonical chain and remit from it.
  const cfg = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const localChainId = Number(cfg[1]);
  const isCanonical = cfg[3];
  if (!isCanonical) return;

  const [currentDay, active] = (await publicClient.readContract({
    address: diamond,
    abi: INTERACTION_ABI,
    functionName: 'getInteractionCurrentDay',
  })) as readonly [bigint, boolean];
  if (!active || currentDay <= 1n) return; // no finalized (day < currentDay) yet

  const ctx = buildKeeperContext(env, chain, publicClient, { notAfterMs: deadlineMs });
  if (!ctx || !ctx.wallet.account) return;

  // Mirror list comes from the ON-CHAIN reward topology (the expected reward
  // sources minus Base itself), NOT from getChainConfigs — funding a mirror is a
  // Base-side call that never touches a mirror RPC, so a mirror must not be
  // silently skipped just because its keeper RPC binding happens to be down.
  const expected = (await publicClient.readContract({
    address: diamond,
    abi: AGGREGATOR_ABI,
    functionName: 'getExpectedSourceChainIds',
  })) as readonly number[];
  const mirrorIds = expected.map(Number).filter((id) => id !== localChainId);
  if (mirrorIds.length === 0) return;

  const lookback = readNumber(env, 'REWARD_REMIT_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  const laneCap = readBigint(env, 'REWARD_REMIT_LANE_CAP', DEFAULT_LANE_CAP);
  const minPart = readBigint(env, 'REWARD_REMIT_MIN_PART', DEFAULT_MIN_PART);
  // #2960 — each mirror's own RPC, for its end of the lane. Funding a mirror
  // never needs it (the send is Base-side), so a mirror without one is still
  // funded, with its end named as unread.
  const mirrorChains = new Map(getChainConfigs(env).map((c) => [c.id, c] as const));

  // Armed-day window extension (Codex #1426 r1): armed days carry the
  // commitment gate + close-only semantics, so their un-closed tail must
  // stay in scope beyond the plain lookback (bounded by the backscan cap).
  const commitState = (await publicClient.readContract({
    address: diamond,
    abi: AGGREGATOR_ABI,
    functionName: 'getGovernorCommitState',
  })) as readonly [bigint, bigint, bigint, bigint];
  const armedFromDay = commitState[0];

  let covered = 0;
  const attempted = mirrorIds.length;
  // From a start that moves each run (#2572 r5, rule 2), so the deadline does
  // not leave the same mirrors unfunded run after run.
  // A mirror's planning reads stop at the read cutoff (#2572 r7, rule 3), so a
  // slow plan cannot use the window its own remit needs.
  const readCutoff = readCutoffMs(deadlineMs);
  for (const mirrorId of rotate(mirrorIds, run)) {
    // #2572 — a mirror starts with its planning reads, so none starts once
    // the read cutoff has passed; the remaining mirrors are funded next run.
    if (Date.now() >= readCutoff) {
      console.log(`[keeper] rewardBudgetRemit read cutoff reached before Base->${mirrorId}; resumes next run`);
      break;
    }
    try {
      const mirrorChain = mirrorChains.get(mirrorId);
      const mirror = mirrorChain
        ? {
            client: createPublicClient({ transport: http(mirrorChain.rpc) }) as PublicClient,
            diamond: mirrorChain.diamond as Address,
          }
        : undefined;
      const sizing: RemitSizing = { baseChainId: localChainId, mirror, minPart };
      if (await remitToMirror(publicClient, ctx, diamond, mirrorId, currentDay, lookback, laneCap, armedFromDay, readCutoff, sizing)) {
        covered += 1;
      }
    } catch (err) {
      // Benign reverts (RewardPoolCapExceeded near exhaustion, NotRewardRemitter
      // if the keeper isn't authorized yet, etc.) — log at info and continue.
      // The failure marker `skipped Base-><id>:` is the one the runbook names.
      reportSendError(`[keeper] rewardBudgetRemit`, err, `skipped Base->${mirrorId}: ${redactedError(err, { stack: false })}`, console.log);
    }
  }
  // #1896 — POSITIVE coverage evidence, for the same reason the liquidator
  // emits one (see `logScanComplete` there). Every unhappy path in this pass
  // is a distinct marker — `chain=<id> failed:`, `skipped Base-><id>:`,
  // `REVERTED` — none of which shares a prefix, so "no error lines" was never
  // a checkable condition. This says how many destinations were actually
  // served out of how many were attempted — a number to compare, not an
  // absence to trust (Codex #1924 r17).
  // eslint-disable-next-line no-console
  console.log(
    `[keeper] rewardBudgetRemit coverage: ${covered}/${attempted} destination(s) completed`,
  );
}

/**
 * #2960 — what the pass knows beyond Base for sizing a mirror's parts: the
 * mirror's own RPC (for its end of the lane) and the minimum part size. Every
 * field is optional; a missing one is NAMED in the tick's log, never assumed.
 */
export type RemitSizing = {
  /** Base's own chain id: the remote chain the mirror's inbound lane names. */
  baseChainId?: number;
  /** The mirror's client and Diamond; absent when no RPC is configured. */
  mirror?: { client: PublicClient; diamond: Address };
  /** The smallest part that may leave its day owing (default 0 = no floor). */
  minPart?: bigint;
};

/**
 * #2960 — read the mirror's end of the lane: its inbound bucket from Base.
 * Every failure is an `unread` with its reason; a Diamond that routes no such
 * view (one deployed before #2960) is named as such.
 */
export async function readMirrorInbound(sizing: RemitSizing): Promise<MirrorInbound> {
  if (!sizing.mirror) return { kind: 'unread', reason: 'no RPC configured for the mirror' };
  if (sizing.baseChainId === undefined) return { kind: 'unread', reason: 'Base chain id unknown' };
  try {
    const raw = (await sizing.mirror.client.readContract({
      address: sizing.mirror.diamond,
      abi: REMIT_LENS_ABI,
      functionName: 'getRemitInboundLaneBucket',
      args: [sizing.baseChainId],
    })) as readonly [boolean, boolean, bigint, bigint];
    return { kind: 'read', bucket: { readable: raw[0], limited: raw[1], tokens: raw[2], capacity: raw[3] } };
  } catch (err) {
    return {
      kind: 'unread',
      reason: isUnroutedRead(err)
        ? 'the mirror Diamond routes no getRemitInboundLaneBucket'
        : `read failed: ${redactedError(err, { stack: false })}`,
    };
  }
}

/**
 * #2960 — the days Base has sent this mirror in part and still owes, from
 * `getRemitOpenDays`, so a partly sent day is continued however old it is.
 * `undefined` when the list could not be read, with the reason logged.
 */
async function readOpenDays(
  publicClient: PublicClient,
  diamond: Address,
  mirrorId: number,
  planBlock: bigint,
): Promise<bigint[] | undefined> {
  try {
    const raw = (await publicClient.readContract({
      address: diamond,
      abi: REMIT_LENS_ABI,
      functionName: 'getRemitOpenDays',
      args: [mirrorId],
      blockNumber: planBlock,
    })) as readonly bigint[];
    return [...raw];
  } catch (err) {
    console.warn(
      `[keeper] rewardBudgetRemit mirror=${mirrorId} open-day list unread (${
        isUnroutedRead(err)
          ? 'this Diamond routes no getRemitOpenDays'
          : redactedError(err, { stack: false })
      }); a partly sent day older than the lookback is not continued this tick`,
    );
    return undefined;
  }
}

/**
 * #2960 — the plan window: every day in the lookback (and the armed backscan),
 * plus each partly sent day before it, oldest first. The mirror holds every
 * later day behind a partly sent one, so such a day is never left to age out
 * of the scan. Pure and exported for the tests.
 */
export function withOpenDays(window: readonly bigint[], openDays: readonly bigint[]): bigint[] {
  const from = window.length > 0 ? window[0] : undefined;
  const older = [...new Set(openDays)]
    .filter((d) => from === undefined || d < from)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...older, ...window];
}

/** @internal Exported for the planning tests; the pass is the only caller. */
export async function remitToMirror(
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  mirrorId: number,
  currentDay: bigint,
  lookback: number,
  laneCap: bigint,
  armedFromDay: bigint,
  readCutoff: number = Number.POSITIVE_INFINITY,
  sizing: RemitSizing = {},
): Promise<boolean> {
  // Returns TRUE only when this destination is SETTLED for this tick —
  // either remitted successfully, or genuinely nothing owed. FALSE on every
  // path that leaves days un-remitted (plan not stabilized, zero quote,
  // receipt timeout, reverted receipt). The caller's coverage counter is a
  // stand-down signal, and several of these paths log-and-return rather than
  // throwing, so counting attempts instead of outcomes reported A/A while
  // mirrors sat unfunded (Codex #1924 r18).
  // Candidate window of recent finalized days (strictly < currentDay).
  // Codex #1426 r1: when the program is armed, extend the floor down to
  // the armed range (bounded by the backscan cap) so a day whose
  // commitment report completes only after the plain lookback expired is
  // still re-quoted, and a zero-clamp day's close-only batch still runs.
  let from = currentDay > BigInt(lookback) ? currentDay - BigInt(lookback) : 1n;
  if (armedFromDay !== 0n && armedFromDay < from) {
    const span = BigInt(lookback + ARMED_BACKSCAN_DAYS);
    const floor = currentDay > span ? currentDay - span : 1n;
    const armedFloor = armedFromDay > floor ? armedFromDay : floor;
    if (armedFloor > armedFromDay) {
      console.warn(
        `[keeper] rewardBudgetRemit mirror=${mirrorId} armed window floored at ${armedFloor} by the ${lookback}+${ARMED_BACKSCAN_DAYS}-day cap — anything older and un-closed needs operator attention`,
      );
    }
    if (armedFloor < from) from = armedFloor;
  }
  const scan: bigint[] = [];
  for (let d = from; d < currentDay; d++) scan.push(d);

  // Codex #1426 r1 — plan through the batch planner view, not the plain
  // amount quote: a gate-passing armed day whose clamp lands at ZERO moves
  // no VPFI but must still be submitted so it terminally closes and its
  // finalize-time commitments retire (an amount-only quote cannot
  // distinguish it from a gated/closed day).
  //
  // Every planning read (the lane bucket, the plan, the per-day statuses, the
  // closure probe) is taken at ONE block. Read at successive heads, a
  // commitment report landing between the plan and the status read made a
  // day `Closeable` by its status but absent from the batch, and the empty
  // batch then read as settled while that day was still owed (Codex #2826
  // r3). At one block the status is the plan's own verdict for every day.
  // The send itself runs later and re-plans on chain, so pinning the plan
  // costs nothing but a day that became closeable after this block, which
  // the next tick picks up.
  const planBlock = await publicClient.getBlockNumber({ cacheTime: 0 });

  // #2960 — a partly sent day older than the scan is still owed its rest, and
  // the mirror holds every later day behind it.
  const openDays = await readOpenDays(publicClient, diamond, mirrorId, planBlock);
  const window = withOpenDays(scan, openDays ?? []);
  if (window.length === 0) return true; // nothing owed
  const continued = window.length - scan.length;
  if (continued > 0) {
    console.log(
      `[keeper] rewardBudgetRemit mirror=${mirrorId} continuing ${continued} partly sent day(s) older than the scan: ${window.slice(0, continued).join(',')}`,
    );
  }

  // #918 — size this tick's part. The chain plans every day under the SAME
  // cap the send carries, so the plan, the fee quote and the send agree for
  // every part size; there is no oversized day to drop and no re-plan.
  // (Before #918 a day above the lane cap was excluded and the plan re-run
  // until stable, and such a day waited for an operator to raise the lane.)
  let bucket: RemitLaneBucket | undefined;
  try {
    const raw = (await publicClient.readContract({
      address: diamond,
      abi: REMIT_LENS_ABI,
      functionName: 'getRemitLaneBucket',
      args: [mirrorId],
      blockNumber: planBlock,
    })) as readonly [boolean, boolean, bigint, bigint];
    bucket = { readable: raw[0], limited: raw[1], tokens: raw[2], capacity: raw[3] };
  } catch (err) {
    bucket = undefined;
    console.warn(
      `[keeper] rewardBudgetRemit mirror=${mirrorId} lane bucket read failed: ${redactedError(err, { stack: false })}`,
    );
  }
  // #2960 — the mirror's end, read at its own head (another chain's block).
  const inbound = await readMirrorInbound(sizing);
  const { partCap, maxPart, note } = resolvePartCap(laneCap, bucket, inbound);
  if (note) console.warn(`[keeper] rewardBudgetRemit mirror=${mirrorId} ${note}`);
  const requestedMin = sizing.minPart ?? 0n;
  const minPart = requestedMin < maxPart ? requestedMin : maxPart;
  if (partCap === 0n) {
    // Not settled: the bucket is empty, so no part can cross this block. It
    // refills at the lane's rate; the next tick sizes again.
    console.warn(
      `[keeper] rewardBudgetRemit mirror=${mirrorId} lane bucket empty at block ${planBlock}; nothing sent this tick`,
    );
    return false;
  }
  if (Date.now() >= readCutoff) {
    console.log(
      `[keeper] rewardBudgetRemit mirror=${mirrorId} read cutoff reached during planning; nothing sent, next run re-plans`,
    );
    return false;
  }
  const planWindow: bigint[] = window;
  const [perDay, actionable] = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemitDayPlans',
    args: [mirrorId, planWindow, partCap],
    blockNumber: planBlock,
  })) as readonly [readonly bigint[], readonly boolean[]];

  // #2760 — the send's own verdict for each day, so a day still owed but
  // gated (awaiting its commitment report, short of recycled backing, or
  // remit-ineligible) is named as owed and holds this mirror unsettled, while a
  // day that owed this mirror nothing is not reported at all. A Diamond
  // without the view keeps the earlier closure probe and its warning.
  //
  // #918 — the same verdict says which funded day's part leaves it still
  // owing (`Partial`). Without the statuses that is unknown, so a part that
  // fills the cap is taken as possibly partial: the mirror is reported
  // unsettled, which the next tick corrects, rather than settled on a guess.
  let blockedOwed = 0;
  let partial: boolean[];
  const statusRead = await readRemitDayStatuses(publicClient, diamond, mirrorId, planWindow, partCap, planBlock);
  if (statusRead.kind === 'read') {
    partial = statusRead.statuses.map((st) => st === 'Partial');
    const blocked = owedButBlocked(planWindow, statusRead.statuses);
    blockedOwed = blocked.length;
    if (blocked.length > 0) {
      console.warn(
        `[keeper] rewardBudgetRemit Base->${mirrorId} ${blocked.length} finalized day(s) still owed and not closeable this tick: ${blocked.map((b) => `${b.day} (${b.reason})`).join(', ')}`,
      );
    }
  } else {
    partial = planWindow.map((_, i) => (perDay[i] ?? 0n) >= partCap);
    if (statusRead.kind === 'unread') {
      console.warn(`[keeper] rewardBudgetRemit Base->${mirrorId} day status read failed: ${statusRead.error}; using the closure probe`);
    }
    await reportUnclosedDays(publicClient, diamond, mirrorId, planWindow, perDay, actionable, planBlock);
  }

  const { batch, total, deferred } = planRemitBatch(
    planWindow,
    perDay,
    actionable,
    partCap,
    partial,
    REMIT_FUNDED_DAYS_PER_SEND,
    minPart,
  );

  if (batch.length === 0) {
    if (deferred === 0 && blockedOwed === 0) return true; // genuinely nothing owed
    if (deferred === 0) return false; // owed days named above, none closeable yet
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} nothing sendable under partCap=${partCap} minPart=${minPart} this tick — ${deferred} actionable day(s) still owed`,
    );
    return false;
  }

  // Exact CCIP fee for THIS batch (the keeper EOA can't call the messenger's
  // quote directly — only the Diamond handler can; that's what this view wraps).
  // `quotedTotal` is the VPFI the send would actually move.
  const [fee, quotedTotal] = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemittanceFee',
    args: [mirrorId, batch, partCap],
  })) as readonly [bigint, bigint];
  // A race (another tick / a manual-admin remit) can consume the selected days
  // between `quoteRewardBudget` above and here, or the messenger/VPFI wiring can
  // be unset — either way `quoteRemittanceFee` returns total 0. Submitting the
  // now-stale batch would revert (NothingToRemit / config guard) and burn keeper
  // gas every tick, so skip and re-evaluate on the next tick.
  if (quotedTotal === 0n && total > 0n) {
    console.log(
      `[keeper] rewardBudgetRemit Base->${mirrorId} batch=${batch.length} — quote total 0 (raced or wiring unset); skipping`,
    );
    return false;
  }
  // A close-only batch (every day clamped to zero) legitimately quotes 0:
  // nothing is dispatched on-chain, the fee is 0, and the send just closes
  // the days + retires their commitments. If it races an admin close the
  // send reverts NothingToRemit, caught benignly below.

  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'remitRewardBudget',
    args: [mirrorId, batch, partCap],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  // Wait for the tx to mine BEFORE returning: `remitRewardBudget` marks the
  // (chain, day) pairs only when mined, so a still-pending tx would let a later
  // remit (in this or a subsequent tick) re-quote the same state. Cross-tick
  // overlap (a tx pending past the 1-min cron interval) can still race, but that
  // is harmless by construction: the on-chain marks make a duplicate remit a
  // safe no-op that reverts `NothingToRemit` — no double-fund, no loss — caught
  // at info below. This is the same on-chain-idempotency safety model every
  // other keeper pass relies on for cross-invocation dedup.
  // Bound the wait (viem defaults to 180s) — mirrors are processed sequentially
  // and the cron fires every minute, so an unbounded wait on one slow/dropped tx
  // would starve later mirrors and burn the invocation's wall-time. 30s matches
  // the matcher pass. On timeout we bail this mirror; the on-chain marks make the
  // next tick's re-quote safe (a duplicate reverts NothingToRemit).
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  } catch {
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} tx=${hash} receipt wait timed out — continuing; next tick re-evaluates`,
    );
    return false;
  }
  if (receipt.status !== 'success') {
    // Broadcast succeeded but the tx reverted on-chain (e.g. a manual/admin
    // remit or a pool-cap change won the race between quote and inclusion).
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} tx=${hash} REVERTED (status=${receipt.status}) — days re-evaluated next tick`,
    );
    return false;
  }
  console.log(
    `[keeper] rewardBudgetRemit Base->${mirrorId} days=${batch.length} total=${total} partCap=${partCap} fee=${fee} tx=${hash}`,
  );
  if (deferred > 0) {
    // The send succeeded, but only for a PREFIX of the plan — a cap cut the
    // rest (the destination's day fan-out), or the day it funded went as a
    // PART and still owes the rest (#918) — and those finalized obligations
    // are still unfunded. A successful tx is not
    // the same as a settled destination (Codex #1924 r20).
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} partial: ${deferred} actionable day(s) deferred to a later tick`,
    );
    return false;
  }
  // SOURCE-ACCEPTED, NOT DELIVERED (Codex #1924 r22).
  //
  // A successful Base receipt means CCIP accepted the message, not that the
  // mirror received it. `IncidentRunbook`'s reward-remittance section records
  // the failure mode explicitly: delivery can park or revert on the mirror —
  // a paused receiver, say — while the days are ALREADY marked remitted on
  // Base. The next tick cannot repair it (`remitRewardBudget` returns
  // `NothingToRemit` for those days); recovery is a manual CCIP
  // re-execution. So users on that mirror can have no claim backing while
  // this pass reports success.
  //
  // This function cannot observe the destination, so it does not claim to:
  // `true` here means "nothing left owed AT THE SOURCE". The stand-down
  // checklist owns the rest, and says so — mirror-side confirmation is a
  // separate check, not something the coverage counter can imply.
  //
  // #2760 — days still owed but gated are named above and keep the
  // destination unsettled until they close.
  return blockedOwed === 0;
}

/**
 * The closure probe for a Diamond without `quoteRemitDayStatuses`: a
 * zero-amount, non-actionable day is reported when `getDayClosedByRemitId`
 * says it is still open. It cannot tell an owed, gated day from one that
 * owed this mirror nothing, so it reports and decides nothing.
 */
async function reportUnclosedDays(
  publicClient: PublicClient,
  diamond: Address,
  mirrorId: number,
  planWindow: readonly bigint[],
  perDay: readonly bigint[],
  actionable: readonly boolean[],
  planBlock: bigint,
): Promise<void> {
  // A zero-amount, non-actionable day is AMBIGUOUS: `quoteRemitDayPlans`
  // returns exactly that both for a day already remitted AND for one that is
  // still owed but gated — an armed day awaiting its commitment report, or a
  // recycled day without backing (Codex #1924 r34). Treating them alike let
  // the coverage marker report A/A while source funding was still owed.
  //
  // `getDayClosedByRemitId` is the discriminator: 0 means the day is still
  // open. Only the ambiguous days are queried, so the cost is bounded by how
  // many of them there are — and in the steady state, where every day really
  // is closed, this is exactly the set that would otherwise have been silently
  // counted as covered.
  const ambiguous = planWindow.filter((_, i) => (perDay[i] ?? 0n) === 0n && !actionable[i]);
  // ONE subrequest, not one per day (Codex #1924 r36). The default window is
  // 45 days and in steady state EVERY already-closed day lands here, so the
  // sequential loop this replaces issued up to 45 subrequests per mirror —
  // against a 50-subrequest free-tier ceiling that the setup reads and the
  // plan quote have already eaten into. A second mirror would simply not be
  // processed. Adding an unbounded per-day loop to the Worker that #1896
  // exists to bring back under its limits was the wrong instinct; multicall
  // makes the whole probe one call.
  const openDays: bigint[] = [];
  if (ambiguous.length > 0) {
    try {
      const results = (await publicClient.multicall({
        contracts: ambiguous.map((dayId) => ({
          address: diamond,
          abi: REMIT_LENS_ABI,
          functionName: 'getDayClosedByRemitId',
          args: [mirrorId, dayId],
        })),
        multicallAddress: MULTICALL3_ADDRESS,
        blockNumber: planBlock,
        allowFailure: true,
        // Same size-split disable as the liquidator (#1965 r2): viem's default
        // is 1024 BYTES, so a probe list long enough to exceed it silently
        // becomes several `aggregate3` requests against the same
        // per-invocation subrequest ceiling. This list is already bounded by
        // the ambiguous-day set.
        //
        // The aggregate-rejection case needs no serial retry HERE, unlike the
        // liquidator: `allowFailure` turns a rejected aggregate into per-call
        // failures, and the loop below already treats any non-success as an
        // OPEN/unknown day and reports it. The outcome is the same whether the
        // rejection surfaces as results or as a throw.
        batchSize: 0,
      })) as { status: 'success' | 'failure'; result?: unknown }[];
      ambiguous.forEach((dayId, i) => {
        const r = results[i];
        // A failed probe is UNKNOWN, and unknown is reported rather than
        // assumed closed.
        if (r?.status !== 'success' || r.result === 0n) openDays.push(dayId);
      });
    } catch (err) {
      console.warn(
        `[keeper] rewardBudgetRemit Base->${mirrorId} closure probe failed: ${redactedError(err, { stack: false })}`,
      );
      openDays.push(...ambiguous);
    }
  }
  if (openDays.length > 0) {
    // REPORTED, not folded into `deferred` (Codex #1924 r35). An open day here
    // is one of two things and this pass cannot tell them apart: an obligation
    // still gated (awaiting its commitment report, or unbacked), or a day that
    // simply gave this mirror no slice — the latter is never closed by
    // anything, so counting it as owed would hold coverage below A/A on every
    // tick until it left the scan window, and the stand-down would never be
    // reachable. That is the false-red the r34 fix introduced by treating both
    // as owed.
    //
    // So the ambiguity is surfaced rather than guessed at: the operator has
    // the day ids and can check whether any carries a real obligation. Same
    // shape as the other signals here — report what is observable, do not
    // infer what is not.
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} ${openDays.length} finalized day(s) neither remitted nor closed: ${openDays.join(',')} — gated obligation or zero budget for this mirror; verify before treating coverage as complete`,
    );
  }
}
